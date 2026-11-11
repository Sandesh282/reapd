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
import type { BuildLogEndStatus } from '@reapd/types';
import { cloneRepoAtSha } from '../builder/git-clone.js';
import { buildDockerImage } from '../builder/image-builder.js';
import { getInstallationToken } from '../github/auth.js';
import { createLogSink, type LogSink } from '../logs/log-sink.js';

export interface BuildJobPayload {
  deploymentId: string;
  /** Optional override for local smoke tests; defaults to https://github.com/<owner>/<name>.git */
  repoUrl?: string;
  /** Optional subdirectory inside the repo containing the Dockerfile */
  subpath?: string;
}

const docker = createDockerClient();
const activeBuildControllers = new Map<string, AbortController>();

/**
 * Aborts all currently running build jobs in this worker process (e.g. on SIGTERM / SIGINT).
 * Passes `'worker_shutdown'` as the abort reason so the job catch block marks the deployment
 * `FAILED` rather than `SUPERSEDED`.
 */
export function abortAllActiveBuilds(): void {
  for (const [deploymentId, ac] of activeBuildControllers.entries()) {
    console.log(`🛑 Aborting active build ${deploymentId} due to worker shutdown`);
    ac.abort('worker_shutdown');
  }
}

/**
 * Extracts the generation number from an image tag like `reapd-pr-104:g2-a1b2c3d`.
 * Returns `null` if the tag does not carry a generation prefix.
 */
export function parseGenerationFromTag(repoTag: string): number | null {
  const match = /:g(\d+)-[0-9a-f]+$/i.exec(repoTag);
  return match?.[1] ? Number(match[1]) : null;
}

function toBuildLogEndStatus(status: string): BuildLogEndStatus {
  if (status === 'LIVE' || status === 'SUPERSEDED') return status;
  return 'FAILED';
}

export async function buildJobHandler(job: Job<BuildJobPayload>): Promise<void> {
  const redisUrl = process.env['REDIS_URL'];
  if (!redisUrl) {
    throw new UnrecoverableError('REDIS_URL is not set — run `npm run env:init`');
  }
  const { deploymentId } = job.data;
  const ac = new AbortController();
  activeBuildControllers.set(deploymentId, ac);
  const sub = new Redis(redisUrl);
  let sink: LogSink | null = null;
  let finalBuildStatus: BuildLogEndStatus = 'FAILED';

  try {
    // ── Subscribe to cancel channel BEFORE reading state or starting work ────
    // Attach listener prior to `subscribe` so a message arriving in the same
    // socket read as the subscribe confirmation is never missed.
    sub.on('message', () => {
      console.log(`🛑 Cancel signal received for deployment ${deploymentId}`);
      ac.abort();
    });
    await sub.subscribe(`cancel:deploy:${deploymentId}`);

    const deployment = await getDeploymentWithRepo(db, deploymentId);
    if (!deployment) {
      throw new UnrecoverableError(`Deployment not found: ${deploymentId}`);
    }

    const { subdomain, commitSha, generation, owner, name, installationId } = deployment;
    const shortSha = commitSha.slice(0, 7);
    // Include generation in the image tag so two generations building the same SHA
    // never delete each other's image tag during cleanup.
    const imageTag = `reapd-${subdomain}:g${generation}-${shortSha}`;
    const containerName = `reapd-${subdomain}`;

    const envOverride =
      process.env['NODE_ENV'] !== 'production'
        ? process.env['REAPD_REPO_URL_OVERRIDE']
        : undefined;
    const repoUrl =
      job.data.repoUrl ?? envOverride ?? `https://github.com/${owner}/${name}.git`;

    // ── Phase 1: QUEUED → BUILDING ───────────────────────────────────────────
    // Note: if a worker process crashes mid-build and BullMQ re-runs a stalled job,
    // `BUILDING → BUILDING` is rejected by `assertValidTransition` and the deployment
    // transitions cleanly to `FAILED` (Phase 4 reconciler cleans up any leftovers).
    const buildTrans = await transitionDeploymentStatus(db, {
      deploymentId,
      toStatus: 'BUILDING',
    });
    if (!buildTrans.transitioned) {
      console.log(`⏭️  Deployment ${deploymentId} already ${buildTrans.finalStatus} — skipping build`);
      return;
    }

    // Initialize log sink ONLY after QUEUED → BUILDING succeeds so early-return jobs
    // on already-terminal deployments never create an empty stream key in Redis.
    sink = createLogSink({ deploymentId, redisUrl });
    sink.write(
      'system',
      'stdout',
      `[reapd] Deployment ${deploymentId} (gen ${generation}, commit ${shortSha}) -> BUILDING`,
    );

    const authToken = repoUrl.startsWith('https://github.com/')
      ? await getInstallationToken({
          installationId,
          repoName: name,
          signal: ac.signal,
        })
      : undefined;

    sink.write('system', 'stdout', `[reapd] Cloning ${owner}/${name}@${shortSha}...`);
    const cloned = await cloneRepoAtSha({
      repoUrl,
      commitSha,
      deploymentId,
      ...(authToken ? { authToken } : {}),
      signal: ac.signal,
      onLog: (stream, line) => {
        console.log(`[git:${subdomain}] ${line}`);
        sink?.write('git', stream, line);
      },
    });

    let buildDurationMs = 0;
    try {
      sink.write('system', 'stdout', `[reapd] Building image ${imageTag} with BuildKit...`);
      const built = await buildDockerImage({
        contextDir: cloned.workDir,
        ...(job.data.subpath ? { subpath: job.data.subpath } : {}),
        imageTag,
        deploymentId,
        subdomain,
        signal: ac.signal,
        onLog: (stream, line) => {
          console.log(`[build:${subdomain}] ${line}`);
          sink?.write('build', stream, line);
        },
      });
      buildDurationMs = built.buildDurationMs;
      sink.write('system', 'stdout', `[reapd] Image ${imageTag} built in ${buildDurationMs}ms`);
    } finally {
      await cloned.cleanup().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`⚠️  Failed to remove temp clone dir: ${msg}`);
      });
    }

    // ── Phase 2: BUILDING → STARTING ─────────────────────────────────────────
    if (ac.signal.aborted) {
      await removeImage(docker, imageTag).catch(() => {});
      throw new AbortError('Deployment superseded before container start');
    }

    const startTrans = await transitionDeploymentStatus(db, {
      deploymentId,
      toStatus: 'STARTING',
      imageTag,
      buildDurationMs,
    });
    if (!startTrans.transitioned) {
      await removeImage(docker, imageTag).catch(() => {});
      finalBuildStatus = toBuildLogEndStatus(startTrans.finalStatus);
      sink.write('system', 'stderr', `[reapd] Transition to STARTING fenced (${startTrans.finalStatus})`);
      await sink.flush();
      return;
    }

    sink.write('system', 'stdout', `[reapd] Starting preview container ${containerName}...`);

    if (ac.signal.aborted) {
      await removeImage(docker, imageTag).catch(() => {});
      throw new AbortError('Deployment superseded after STARTING transition');
    }

    // Replace any previous container on the same PR subdomain and prune only OLDER
    // generation images (never delete a newer generation's image if running concurrently).
    // Check abort signal before touching Docker so an aborted Gen N worker never removes
    // a container just started by Gen N+1.
    const oldImages = await listManagedImages(docker, { subdomain });
    if (ac.signal.aborted) {
      await removeImage(docker, imageTag).catch(() => {});
      throw new AbortError('Deployment superseded before removing previous container');
    }
    await forceRemoveContainer(docker, containerName);
    for (const img of oldImages) {
      const imgGen = parseGenerationFromTag(img.repoTag);
      if (imgGen !== null && imgGen < generation) {
        await removeImage(docker, img.repoTag).catch(() => {});
      }
    }

    if (ac.signal.aborted) {
      await removeImage(docker, imageTag).catch(() => {});
      throw new AbortError('Deployment superseded before creating preview container');
    }

    const container = await createPreviewContainer(docker, {
      deploymentId,
      imageTag,
      subdomain,
    });

    const healthUrl = `https://${subdomain}.preview.localhost/health`;
    sink.write('system', 'stdout', `[reapd] Probing health endpoint ${healthUrl}...`);
    try {
      await pollUntilHealthy(healthUrl, ac.signal, { maxWaitMs: 30_000 });
    } catch (err) {
      // Remove by unique `container.id` (never `container.name`) so an aborting
      // worker can never destroy a newer generation's container on the same PR.
      await forceRemoveContainer(docker, container.id).catch(() => {});
      throw err;
    }
    sink.write('system', 'stdout', `[reapd] Health check passed for ${healthUrl}`);

    // ── Phase 3: STARTING → TESTING (Playwright added in Phase 6) ────────────
    const testTrans = await transitionDeploymentStatus(db, {
      deploymentId,
      toStatus: 'TESTING',
      containerId: container.id,
    });
    if (!testTrans.transitioned) {
      await forceRemoveContainer(docker, container.id).catch(() => {});
      finalBuildStatus = toBuildLogEndStatus(testTrans.finalStatus);
      sink.write('system', 'stderr', `[reapd] Transition to TESTING fenced (${testTrans.finalStatus})`);
      await sink.flush();
      return;
    }

    // ── Phase 4: TESTING → LIVE ──────────────────────────────────────────────
    // Flush all pending log lines BEFORE committing `LIVE` in Postgres so any SSE client
    // observing `status = LIVE` in the DB is guaranteed the full build log tail is already in Redis.
    sink.write('system', 'stdout', `[reapd] Preview LIVE at https://${subdomain}.preview.localhost`);
    await sink.flush();

    const liveTrans = await transitionDeploymentStatus(db, {
      deploymentId,
      toStatus: 'LIVE',
    });
    if (!liveTrans.transitioned) {
      await forceRemoveContainer(docker, container.id).catch(() => {});
      finalBuildStatus = toBuildLogEndStatus(liveTrans.finalStatus);
      return;
    }

    finalBuildStatus = 'LIVE';
    console.log(`🟢 LIVE: https://${subdomain}.preview.localhost (deployment ${deploymentId})`);
  } catch (err) {
    if (err instanceof AbortError || (err instanceof Error && err.name === 'AbortError')) {
      const isShutdown = ac.signal.reason === 'worker_shutdown';
      const targetStatus: BuildLogEndStatus = isShutdown ? 'FAILED' : 'SUPERSEDED';
      const abortReason = isShutdown
        ? 'Build aborted due to worker shutdown'
        : 'Aborted via cancel signal';

      finalBuildStatus = targetStatus;
      if (sink) {
        sink.write('system', 'stderr', `[reapd] ${abortReason} -> ${targetStatus}`);
        await sink.flush();
      }

      await transitionDeploymentStatus(db, {
        deploymentId,
        toStatus: targetStatus,
        reason: abortReason,
      }).catch((dbErr: unknown) => {
        console.warn(`⚠️  Failed to record ${targetStatus} status for ${deploymentId}:`, dbErr);
      });
      return;
    }

    if (err instanceof DeploymentNotFoundError || err instanceof UnrecoverableError) {
      throw err;
    }

    const reason = err instanceof Error ? err.message.slice(0, 512) : String(err).slice(0, 512);
    finalBuildStatus = 'FAILED';
    if (sink) {
      sink.write('system', 'stderr', `[reapd] Build failed: ${reason}`);
      await sink.flush();
    }

    await transitionDeploymentStatus(db, {
      deploymentId,
      toStatus: 'FAILED',
      reason,
    }).catch((dbErr: unknown) => {
      console.warn(`⚠️  Failed to record FAILED status for ${deploymentId}:`, dbErr);
    });

    throw err;
  } finally {
    if (sink) {
      await sink.end(finalBuildStatus);
    }
    activeBuildControllers.delete(deploymentId);
    await sub.unsubscribe().catch(() => {});
    await sub.quit().catch(() => {});
  }
}
