// apps/worker/src/jobs/build.ts
// BullMQ job handler for the `build` queue.
// Orchestrates the full deployment lifecycle:
//   QUEUED → BUILDING → STARTING → TESTING → LIVE (or SUPERSEDED / FAILED)
// with a single AbortController wired to the `cancel:deploy:<id>` Redis pub/sub channel.

import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import {
  db,
  DeploymentNotFoundError,
  getDeploymentWithRepo,
  transitionDeploymentStatus,
} from '@reapd/db';
import {
  AbortError,
  createDockerClient,
  createPreviewContainer,
  forceRemoveContainer,
  listManagedImages,
  pollUntilHealthy,
  removeImage,
} from '@reapd/docker-client';
import { cloneRepoAtSha } from '../builder/git-clone.js';
import { buildDockerImage } from '../builder/image-builder.js';
import { getInstallationToken } from '../github/auth.js';

export interface BuildJobPayload {
  deploymentId: string;
  /** Optional override for local smoke tests; defaults to https://github.com/<owner>/<name>.git */
  repoUrl?: string;
  /** Optional subdirectory inside the repo containing the Dockerfile */
  subpath?: string;
}

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const docker = createDockerClient();

export async function buildJobHandler(job: Job<BuildJobPayload>): Promise<void> {
  const { deploymentId } = job.data;
  const ac = new AbortController();

  // ── Subscribe to cancel channel BEFORE reading state or starting work ──────
  // Prevents the race where a superseding webhook publishes `cancel:deploy:<id>`
  // between our initial DB check and the subscription becoming active.
  const sub = new Redis(REDIS_URL);
  await sub.subscribe(`cancel:deploy:${deploymentId}`);
  sub.on('message', () => {
    console.log(`🛑 Cancel signal received for deployment ${deploymentId}`);
    ac.abort();
  });

  try {
    const deployment = await getDeploymentWithRepo(db, deploymentId);
    if (!deployment) {
      throw new UnrecoverableError(`Deployment not found: ${deploymentId}`);
    }

    const { subdomain, commitSha, owner, name, installationId } = deployment;
    const shortSha = commitSha.slice(0, 7);
    const imageTag = `reapd-${subdomain}:${shortSha}`;
    const containerName = `reapd-${subdomain}`;
    const repoUrl =
      job.data.repoUrl ??
      process.env['REAPD_REPO_URL_OVERRIDE'] ??
      `https://github.com/${owner}/${name}.git`;

    // ── Phase 1: QUEUED → BUILDING ───────────────────────────────────────────
    const buildTrans = await transitionDeploymentStatus(db, {
      deploymentId,
      toStatus: 'BUILDING',
    });
    if (!buildTrans.transitioned) {
      console.log(`⏭️  Deployment ${deploymentId} already ${buildTrans.finalStatus} — skipping build`);
      return;
    }

    const authToken = repoUrl.startsWith('https://')
      ? await getInstallationToken(installationId, ac.signal).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`⚠️  Proceeding without installation token: ${msg}`);
          return undefined;
        })
      : undefined;

    const cloned = await cloneRepoAtSha({
      repoUrl,
      commitSha,
      deploymentId,
      ...(authToken ? { authToken } : {}),
      signal: ac.signal,
      onLog: (_stream, line) => console.log(`[git:${subdomain}] ${line}`),
    });

    let buildDurationMs = 0;
    try {
      const built = await buildDockerImage({
        contextDir: cloned.workDir,
        ...(job.data.subpath ? { subpath: job.data.subpath } : {}),
        imageTag,
        deploymentId,
        subdomain,
        signal: ac.signal,
        onLog: (_stream, line) => console.log(`[build:${subdomain}] ${line}`),
      });
      buildDurationMs = built.buildDurationMs;
    } finally {
      await cloned.cleanup().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`⚠️  Failed to remove temp clone dir: ${msg}`);
      });
    }

    // ── Phase 2: BUILDING → STARTING ─────────────────────────────────────────
    const startTrans = await transitionDeploymentStatus(db, {
      deploymentId,
      toStatus: 'STARTING',
      imageTag,
      buildDurationMs,
    });
    if (!startTrans.transitioned) {
      await removeImage(docker, imageTag).catch(() => {});
      return;
    }

    // Replace any previous container on the same PR subdomain and prune older images
    const oldImages = await listManagedImages(docker, { subdomain });
    await forceRemoveContainer(docker, containerName);
    for (const img of oldImages) {
      if (img.repoTag !== imageTag) {
        await removeImage(docker, img.repoTag).catch(() => {});
      }
    }

    const container = await createPreviewContainer(docker, {
      deploymentId,
      imageTag,
      subdomain,
    });

    const healthUrl = `https://${subdomain}.preview.localhost/health`;
    try {
      await pollUntilHealthy(healthUrl, ac.signal, { maxWaitMs: 30_000 });
    } catch (err) {
      await forceRemoveContainer(docker, container.name).catch(() => {});
      throw err;
    }

    // ── Phase 3: STARTING → TESTING (Playwright added in Phase 6) ────────────
    const testTrans = await transitionDeploymentStatus(db, {
      deploymentId,
      toStatus: 'TESTING',
      containerId: container.id,
    });
    if (!testTrans.transitioned) {
      await forceRemoveContainer(docker, container.name).catch(() => {});
      return;
    }

    // ── Phase 4: TESTING → LIVE ──────────────────────────────────────────────
    const liveTrans = await transitionDeploymentStatus(db, {
      deploymentId,
      toStatus: 'LIVE',
    });
    if (!liveTrans.transitioned) {
      await forceRemoveContainer(docker, container.name).catch(() => {});
      return;
    }

    console.log(`🟢 LIVE: https://${subdomain}.preview.localhost (deployment ${deploymentId})`);
  } catch (err) {
    if (err instanceof AbortError || (err instanceof Error && err.name === 'AbortError')) {
      // Transition to SUPERSEDED if the webhook hasn't already marked it terminal
      await transitionDeploymentStatus(db, {
        deploymentId,
        toStatus: 'SUPERSEDED',
        reason: 'Aborted via cancel signal',
      }).catch(() => {});
      return;
    }

    if (err instanceof DeploymentNotFoundError || err instanceof UnrecoverableError) {
      throw err;
    }

    const reason = err instanceof Error ? err.message.slice(0, 512) : String(err).slice(0, 512);
    await transitionDeploymentStatus(db, {
      deploymentId,
      toStatus: 'FAILED',
      reason,
    }).catch(() => {});

    throw err;
  } finally {
    await sub.unsubscribe().catch(() => {});
    await sub.quit().catch(() => {});
  }
}
