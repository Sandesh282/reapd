// apps/worker/src/cli/reapd-cli.ts
// Phase 2 end-to-end CLI lifecycle runner:
//   up   — shallow-clones a repo at a commit SHA, builds via BuildKit, boots a hardened
//          preview container behind Traefik, and polls https://<subdomain>.preview.localhost
//   down — stops/removes the preview container + anonymous volumes and prunes its image
//   ls   — lists all active reapd-managed preview containers

import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  createDockerClient,
  createPreviewContainer,
  forceRemoveContainer,
  removeImage,
  listManagedContainers,
  listManagedImages,
  pollUntilHealthy,
} from '@reapd/docker-client';
import { cloneRepoAtSha } from '../builder/git-clone.js';
import { buildDockerImage } from '../builder/image-builder.js';
import { runReconcileSweep } from '../reconciler/index.js';
import { closeDb } from '@reapd/db';

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === 'up') {
    await runUp(rest);
  } else if (command === 'down') {
    await runDown(rest);
  } else if (command === 'ls') {
    await runLs();
  } else if (command === 'reconcile') {
    await runReconcile();
  } else {
    printUsage();
    process.exitCode = 1;
  }
}

async function runUp(rawArgs: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      repo: { type: 'string' },
      sha: { type: 'string', default: 'HEAD' },
      pr: { type: 'string' },
      subpath: { type: 'string' },
      port: { type: 'string', default: '3000' },
      'health-path': { type: 'string', default: '/health' },
    },
  });

  if (!values.repo || !values.pr) {
    throw new Error('Missing required flags: --repo <url-or-path> --pr <number>');
  }

  const prNumber = Number(values.pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid --pr number: ${values.pr}`);
  }

  const appPort = Number(values.port ?? '3000');
  if (!Number.isInteger(appPort) || appPort <= 0 || appPort > 65535) {
    throw new Error(`Invalid --port value: ${values.port}`);
  }

  const subdomain = `pr-${prNumber}`;
  const deploymentId = `cli-${subdomain}-${randomUUID().slice(0, 8)}`;
  const ac = new AbortController();

  // process.once: a second Ctrl-C while SIGTERM handling is in-flight
  // should not register a second listener
  process.once('SIGINT', () => ac.abort());
  process.once('SIGTERM', () => ac.abort());

  console.log(`📥 Cloning ${values.repo} @ ${values.sha} ...`);
  const cloned = await cloneRepoAtSha({
    repoUrl: values.repo,
    commitSha: values.sha ?? 'HEAD',
    deploymentId,
    signal: ac.signal,
    onLog: (_stream, line) => console.log(`   [git] ${line}`),
  });

  const shortSha = cloned.resolvedSha.slice(0, 7);
  const imageTag = `reapd-${subdomain}:${shortSha}`;

  try {
    console.log(`🔨 Building image ${imageTag} (resolved SHA: ${cloned.resolvedSha}) ...`);
    const buildRes = await buildDockerImage({
      contextDir: cloned.workDir,
      imageTag,
      deploymentId,
      subdomain,
      signal: ac.signal,
      onLog: (_stream: 'stdout' | 'stderr', line: string) =>
        console.log(`   [buildkit] ${line}`),
      ...(values.subpath ? { subpath: values.subpath } : {}),
    });
    console.log(`✅ Built ${buildRes.imageTag} in ${buildRes.buildDurationMs}ms`);
  } finally {
    await cloned.cleanup().catch((e: unknown) => {
      console.warn('⚠️  Failed to clean up temp build dir (possible disk leak):', e instanceof Error ? e.message : e);
    });
  }

  const docker = createDockerClient();
  // Remove any existing container for the same PR subdomain before starting the new one
  await forceRemoveContainer(docker, `reapd-${subdomain}`);

  // Prune any old-SHA images for this PR (e.g. from previous `up` runs with different SHAs)
  const oldImages = await listManagedImages(docker, { subdomain });
  for (const img of oldImages) {
    if (img.repoTag !== imageTag) {
      console.log(`🗑️  Pruning stale image ${img.repoTag} from previous build ...`);
      await removeImage(docker, img.repoTag);
    }
  }

  console.log(`🚀 Starting hardened container reapd-${subdomain} ...`);
  const container = await createPreviewContainer(docker, {
    deploymentId,
    imageTag,
    subdomain,
    appPort,
  });

  const previewUrl = `https://${subdomain}.preview.localhost`;
  const healthUrl = `${previewUrl}${values['health-path'] ?? '/health'}`;

  console.log(`⏳ Polling readiness at ${healthUrl} ...`);
  try {
    await pollUntilHealthy(healthUrl, ac.signal, { maxWaitMs: 30_000 });
  } catch (err) {
    // Roll back the container so we don't leave a dangling, unreachable preview
    console.error(`⚠️  Health-check failed — rolling back container ${container.name} ...`);
    await forceRemoveContainer(docker, container.name).catch(() => {/* best-effort */});
    throw err;
  }

  console.log(
    `🟢 LIVE: ${previewUrl} (container=${container.id.slice(0, 12)}, image=${imageTag})`
  );
}

async function runDown(rawArgs: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      pr: { type: 'string' },
    },
  });

  if (!values.pr) {
    throw new Error('Missing required flag: --pr <number>');
  }

  const prNumber = Number(values.pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid --pr number: ${values.pr}`);
  }

  const subdomain = `pr-${prNumber}`;
  const containerName = `reapd-${subdomain}`;
  const docker = createDockerClient();

  console.log(`🧹 Removing container ${containerName} and anonymous volumes ...`);
  await forceRemoveContainer(docker, containerName);

  // Find image by label so we can prune even if the container was already gone
  const images = await listManagedImages(docker, { subdomain });
  for (const img of images) {
    console.log(`🗑️  Pruning image ${img.repoTag} ...`);
    await removeImage(docker, img.repoTag);
  }

  if (images.length === 0) {
    // Fall back to listing containers in case image labels are missing (e.g. pre-label builds)
    const managed = await listManagedContainers(docker);
    const target = managed.find((c) => c.subdomain === subdomain);
    if (target?.image) {
      console.log(`🗑️  Pruning image ${target.image} (fallback) ...`);
      await removeImage(docker, target.image);
    }
  }

  console.log(`✅ Teardown complete for ${subdomain}`);
}

async function runLs(): Promise<void> {
  const docker = createDockerClient();
  const managed = await listManagedContainers(docker);

  if (managed.length === 0) {
    console.log('No active reapd preview containers.');
    return;
  }

  console.table(
    managed.map((c) => ({
      id: c.id.slice(0, 12),
      name: c.name,
      subdomain: c.subdomain,
      image: c.image,
      state: c.state,
      url: `https://${c.subdomain}.preview.localhost`,
    }))
  );
}

async function runReconcile(): Promise<void> {
  try {
    const res = await runReconcileSweep();
    console.log(
      `♻️  Reconcile complete: expired=${res.expiredDeploymentIds.length}, fenced=${res.fencedDeploymentIds.length}, removedContainers=${res.removedContainerIds.length}, removedImages=${res.removedImageTags.length}, removedTmpDirs=${res.removedTmpDirs.length}`
    );
  } finally {
    await closeDb().catch(() => {});
  }
}

function printUsage(): void {
  console.log(`Usage:
  reapd-cli up        --repo <url-or-path> --pr <number> [--sha <sha>] [--subpath <dir>] [--port <port>] [--health-path <path>]
  reapd-cli down      --pr <number>
  reapd-cli ls
  reapd-cli reconcile`);
}

main().catch((err: unknown) => {
  console.error('❌ Error:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
