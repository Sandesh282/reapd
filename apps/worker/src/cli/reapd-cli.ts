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
  pollUntilHealthy,
} from '@reapd/docker-client';
import { cloneRepoAtSha } from '../builder/git-clone.js';
import { buildDockerImage } from '../builder/image-builder.js';

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === 'up') {
    await runUp(rest);
  } else if (command === 'down') {
    await runDown(rest);
  } else if (command === 'ls') {
    await runLs();
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
  const subdomain = `pr-${prNumber}`;
  const deploymentId = `cli-${subdomain}-${randomUUID().slice(0, 8)}`;
  const ac = new AbortController();

  process.on('SIGINT', () => ac.abort());
  process.on('SIGTERM', () => ac.abort());

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
    const buildOptions = {
      contextDir: cloned.workDir,
      imageTag,
      deploymentId,
      signal: ac.signal,
      onLog: (_stream: 'stdout' | 'stderr', line: string) =>
        console.log(`   [buildkit] ${line}`),
      ...(values.subpath ? { subpath: values.subpath } : {}),
    };
    const buildRes = await buildDockerImage(buildOptions);
    console.log(`✅ Built ${buildRes.imageTag} in ${buildRes.buildDurationMs}ms`);
  } finally {
    await cloned.cleanup().catch(() => {/* best-effort: don't mask build/abort errors */});
  }

  const docker = createDockerClient();
  // Remove any existing container for the same PR subdomain before starting the new one
  await forceRemoveContainer(docker, `reapd-${subdomain}`);

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
  await pollUntilHealthy(healthUrl, ac.signal, { maxWaitMs: 30_000 });

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

  const subdomain = `pr-${values.pr}`;
  const containerName = `reapd-${subdomain}`;
  const docker = createDockerClient();

  const managed = await listManagedContainers(docker);
  const target = managed.find(
    (c) => c.subdomain === subdomain || c.name === containerName
  );

  console.log(`🧹 Removing container ${containerName} and anonymous volumes ...`);
  await forceRemoveContainer(docker, containerName);

  if (target?.image) {
    console.log(`🗑️  Pruning image ${target.image} ...`);
    await removeImage(docker, target.image);
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

function printUsage(): void {
  console.log(`Usage:
  reapd-cli up   --repo <url-or-path> --pr <number> [--sha <sha>] [--subpath <dir>] [--port <port>]
  reapd-cli down --pr <number>
  reapd-cli ls`);
}

main().catch((err: unknown) => {
  console.error('❌ Error:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

