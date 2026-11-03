// apps/worker/src/reconciler/index.ts
// Desired-State Reconciler (PRD v2.2 §6.1).
//
// Runs every 60 seconds (configurable via `REAPD_RECONCILE_INTERVAL_MS`) and
// treats PostgreSQL as the single source of truth:
//   1. Expire Due Environments — mark `LIVE` rows where `expires_at <= NOW()` as `EXPIRED`
//   2. Fence Stuck Builds      — mark `QUEUED`/`BUILDING`/`STARTING`/`TESTING` rows
//                                with `updated_at` older than 20 minutes as `FAILED`
//   3. Diff Actual vs. Desired — query Docker for all `reapd.managed=true` containers & images
//   4. Purge Orphans           — remove any container not in `STARTING`/`TESTING`/`LIVE`,
//                                prune any image not in an active build or `LIVE` state,
//                                and sweep stale `/tmp/reapd-build-*` directories

import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Dockerode from 'dockerode';
import {
  db,
  type DrizzleClient,
  expireDueDeployments,
  fenceStuckDeployments,
  getActiveDeploymentIds,
} from '@reapd/db';
import {
  createDockerClient,
  forceRemoveContainer,
  listManagedContainers,
  listManagedImages,
  removeImage,
} from '@reapd/docker-client';

const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const DEFAULT_STUCK_BUILD_MINUTES = 20;
const DEFAULT_TMP_DIR_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

export interface ReconcileSweepOptions {
  dbClient?: DrizzleClient;
  dockerClient?: Dockerode;
  stuckBuildMinutes?: number;
  tmpDirMaxAgeMs?: number;
}

export interface ReconcileSweepResult {
  expiredDeploymentIds: string[];
  fencedDeploymentIds: string[];
  removedContainerIds: string[];
  removedImageTags: string[];
  removedTmpDirs: string[];
}

/**
 * Executes a single desired-state reconciliation pass across PostgreSQL, Docker, and `/tmp`.
 * Safe to invoke directly from tests, CLI scripts, or the periodic timer.
 */
export async function runReconcileSweep(
  opts?: ReconcileSweepOptions
): Promise<ReconcileSweepResult> {
  const dbClient = opts?.dbClient ?? db;
  const dockerClient = opts?.dockerClient ?? createDockerClient();
  const stuckBuildMinutes = opts?.stuckBuildMinutes ?? DEFAULT_STUCK_BUILD_MINUTES;
  const tmpDirMaxAgeMs = opts?.tmpDirMaxAgeMs ?? DEFAULT_TMP_DIR_MAX_AGE_MS;

  // ── 1. Expire LIVE deployments past their TTL ─────────────────────────────
  const expiredDeploymentIds = await expireDueDeployments(dbClient);
  for (const id of expiredDeploymentIds) {
    console.log(`♻️  [reconciler] Expired TTL-elapsed deployment ${id}`);
  }

  // ── 2. Fence stuck builds older than stuckBuildMinutes ────────────────────
  const fencedDeploymentIds = await fenceStuckDeployments(dbClient, stuckBuildMinutes);
  for (const id of fencedDeploymentIds) {
    console.log(`♻️  [reconciler] Fenced stuck build ${id} -> FAILED`);
  }

  // ── 3. Fetch active deployment IDs from PostgreSQL ────────────────────────
  const { activeBuildOrLiveIds, activeContainerIds } =
    await getActiveDeploymentIds(dbClient);

  // ── 4a. Purge orphan containers (not in STARTING, TESTING, or LIVE) ───────
  const managedContainers = await listManagedContainers(dockerClient);
  const removedContainerIds: string[] = [];

  for (const container of managedContainers) {
    const isDesired =
      container.deploymentId !== '' &&
      activeContainerIds.has(container.deploymentId);

    if (!isDesired) {
      console.log(
        `♻️  [reconciler] Removing orphan container ${container.name} (${container.id.slice(0, 12)}, deployment=${container.deploymentId || 'unknown'})`
      );
      await forceRemoveContainer(dockerClient, container.id).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`⚠️  [reconciler] Failed to remove container ${container.id.slice(0, 12)}: ${msg}`);
      });
      removedContainerIds.push(container.id);
    }
  }

  // ── 4b. Purge orphan images (not in QUEUED/BUILDING/STARTING/TESTING/LIVE) ─
  const managedImages = await listManagedImages(dockerClient);
  const removedImageTags: string[] = [];

  for (const img of managedImages) {
    const isDesired =
      img.deploymentId !== '' &&
      activeBuildOrLiveIds.has(img.deploymentId);

    if (!isDesired) {
      console.log(
        `♻️  [reconciler] Pruning orphan image ${img.repoTag} (deployment=${img.deploymentId || 'unknown'})`
      );
      await removeImage(dockerClient, img.repoTag).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`⚠️  [reconciler] Failed to prune image ${img.repoTag}: ${msg}`);
      });
      removedImageTags.push(img.repoTag);
    }
  }

  // ── 4c. Sweep stale `/tmp/reapd-build-*` directories from crashed workers ─
  const removedTmpDirs = await sweepStaleTempBuildDirs(tmpDirMaxAgeMs);

  return {
    expiredDeploymentIds,
    fencedDeploymentIds,
    removedContainerIds,
    removedImageTags,
    removedTmpDirs,
  };
}

async function sweepStaleTempBuildDirs(maxAgeMs: number): Promise<string[]> {
  const removed: string[] = [];
  const rootTmp = tmpdir();
  const cutoffMs = Date.now() - maxAgeMs;

  try {
    const entries = await readdir(rootTmp, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('reapd-build-')) {
        continue;
      }
      const fullPath = join(rootTmp, entry.name);
      try {
        const info = await stat(fullPath);
        if (info.mtimeMs <= cutoffMs) {
          await rm(fullPath, { recursive: true, force: true });
          removed.push(fullPath);
        }
      } catch {
        // Directory may have been removed concurrently by an active worker
      }
    }
  } catch {
    // Best-effort tmp sweep
  }

  return removed;
}

/**
 * Starts the periodic background reconciler loop.
 * Uses an `isRunning` guard so overlapping sweeps cannot interleave if Docker is slow.
 */
export function startReconciler(opts?: { intervalMs?: number }): () => void {
  const envInterval = Number(process.env['REAPD_RECONCILE_INTERVAL_MS']);
  const intervalMs =
    opts?.intervalMs ??
    (Number.isFinite(envInterval) && envInterval > 0
      ? envInterval
      : DEFAULT_RECONCILE_INTERVAL_MS);

  let isRunning = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped || isRunning) return;
    isRunning = true;
    try {
      await runReconcileSweep();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`❌ [reconciler] Sweep failed: ${msg}`);
    } finally {
      isRunning = false;
    }
  };

  console.log(`♻️  Desired-state reconciler started (interval: ${intervalMs}ms)`);
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
