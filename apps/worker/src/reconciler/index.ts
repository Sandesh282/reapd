// apps/worker/src/reconciler/index.ts
// Desired-State Reconciler (PRD v2.2 §6.1).
//
// Runs every 60 seconds (configurable via `REAPD_RECONCILE_INTERVAL_MS`) and
// treats PostgreSQL as the single source of truth:
//   1. Expire Due Environments — mark `LIVE` rows where `expires_at <= NOW()` as `EXPIRED`
//   2. Fence Stuck Builds      — mark `QUEUED`/`BUILDING`/`STARTING`/`TESTING` rows
//                                with `updated_at` older than 20 minutes as `FAILED`
//   3. Diff Actual vs. Desired — snapshot Docker `reapd.managed=true` containers & images
//                                BEFORE querying Postgres so a concurrent worker transitioning
//                                `BUILDING -> STARTING` is guaranteed to appear in the DB read
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
import {
  deploymentsTotal,
  reconcilerErrorsTotal,
  reconcilerExpiredTotal,
  reconcilerFencedTotal,
  reconcilerLastSuccessTimestampSeconds,
  reconcilerOrphansRemovedTotal,
  reconcilerSweepDurationSeconds,
} from '../metrics.js';

const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const DEFAULT_STUCK_BUILD_MINUTES = 20;
const DEFAULT_TMP_DIR_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const SWEEP_TIMEOUT_MS = 30_000;

export interface ReconcileSweepOptions {
  dbClient?: DrizzleClient;
  dockerClient?: Dockerode;
  stuckBuildMinutes?: number;
  tmpDirMaxAgeMs?: number;
  tmpRootDir?: string;
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
  const sweepStartMs = Date.now();
  const dbClient = opts?.dbClient ?? db;
  const dockerClient = opts?.dockerClient ?? createDockerClient();

  const envStuckMin = Number(
    process.env['REAPD_STUCK_THRESHOLD_MINUTES'] ?? process.env['REAPD_STUCK_BUILD_MINUTES']
  );
  const stuckBuildMinutes =
    opts?.stuckBuildMinutes ??
    (Number.isFinite(envStuckMin) && envStuckMin > 0
      ? envStuckMin
      : DEFAULT_STUCK_BUILD_MINUTES);

  const envTmpAge = Number(process.env['REAPD_TMP_DIR_MAX_AGE_MS']);
  const tmpDirMaxAgeMs =
    opts?.tmpDirMaxAgeMs ??
    (Number.isFinite(envTmpAge) && envTmpAge >= 0
      ? envTmpAge
      : DEFAULT_TMP_DIR_MAX_AGE_MS);

  const tmpRootDir = opts?.tmpRootDir ?? tmpdir();

  try {
    // ── 1. Expire LIVE deployments past their TTL (UPDATE ... RETURNING id) ───
    const expiredDeploymentIds = await expireDueDeployments(dbClient);
    if (expiredDeploymentIds.length > 0) {
      reconcilerExpiredTotal.inc(expiredDeploymentIds.length);
      deploymentsTotal.inc({ status: 'EXPIRED' }, expiredDeploymentIds.length);
    }
    for (const id of expiredDeploymentIds) {
      console.log(`♻️  [reconciler] Expired TTL-elapsed deployment ${id}`);
    }

    // ── 2. Fence stuck builds older than stuckBuildMinutes (UPDATE ... RETURNING id)
    const fencedDeploymentIds = await fenceStuckDeployments(dbClient, stuckBuildMinutes);
    if (fencedDeploymentIds.length > 0) {
      reconcilerFencedTotal.inc(fencedDeploymentIds.length);
      deploymentsTotal.inc({ status: 'FAILED' }, fencedDeploymentIds.length);
    }
    for (const id of fencedDeploymentIds) {
      console.log(`♻️  [reconciler] Fenced stuck build ${id} -> FAILED`);
    }

    // ── 3. Snapshot Docker resources FIRST, then read desired state from Postgres ─
    // Reading Docker before Postgres prevents a TOCTOU race where a worker transitions
    // BUILDING -> STARTING and creates a container in the millisecond after the DB read,
    // which would otherwise look like an untracked orphan in the Docker list.
    const [managedContainers, managedImages] = await Promise.all([
      listManagedContainers(dockerClient),
      listManagedImages(dockerClient),
    ]);

    const { activeBuildOrLiveIds, activeContainerIds } =
      await getActiveDeploymentIds(dbClient);

    // ── 4a. Purge orphan containers (not in STARTING, TESTING, or LIVE) ───────
    const removedContainerIds: string[] = [];

    for (const container of managedContainers) {
      // Manual CLI previews (`reapd up`) carry `cli-pr-<n>-<uuid>` and are managed by `reapd down`
      if (container.deploymentId.startsWith('cli-')) {
        continue;
      }

      const isDesired =
        container.deploymentId !== '' &&
        activeContainerIds.has(container.deploymentId);

      if (!isDesired) {
        console.log(
          `♻️  [reconciler] Removing orphan container ${container.name} (${container.id.slice(0, 12)}, deployment=${container.deploymentId || 'unknown'})`
        );
        try {
          await forceRemoveContainer(dockerClient, container.id);
          removedContainerIds.push(container.id);
          reconcilerOrphansRemovedTotal.inc({ kind: 'container' });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `⚠️  [reconciler] Failed to remove container ${container.id.slice(0, 12)}: ${msg}`
          );
        }
      }
    }

    // ── 4b. Purge orphan images (not in QUEUED/BUILDING/STARTING/TESTING/LIVE) ─
    const removedImageTags: string[] = [];

    for (const img of managedImages) {
      if (img.deploymentId.startsWith('cli-')) {
        continue;
      }

      const isDesired =
        img.deploymentId !== '' &&
        activeBuildOrLiveIds.has(img.deploymentId);

      if (!isDesired) {
        console.log(
          `♻️  [reconciler] Pruning orphan image ${img.repoTag} (deployment=${img.deploymentId || 'unknown'})`
        );
        try {
          await removeImage(dockerClient, img.repoTag);
          removedImageTags.push(img.repoTag);
          reconcilerOrphansRemovedTotal.inc({ kind: 'image' });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`⚠️  [reconciler] Failed to prune image ${img.repoTag}: ${msg}`);
        }
      }
    }

    // ── 4c. Sweep stale `/tmp/reapd-build-*` directories from crashed workers ─
    const removedTmpDirs = await sweepStaleTempBuildDirs(tmpDirMaxAgeMs, tmpRootDir);

    reconcilerLastSuccessTimestampSeconds.set(Date.now() / 1000);

    return {
      expiredDeploymentIds,
      fencedDeploymentIds,
      removedContainerIds,
      removedImageTags,
      removedTmpDirs,
    };
  } catch (err) {
    reconcilerErrorsTotal.inc();
    throw err;
  } finally {
    reconcilerSweepDurationSeconds.observe(Math.max(0, (Date.now() - sweepStartMs) / 1000));
  }
}

export async function sweepStaleTempBuildDirs(
  maxAgeMs: number,
  rootTmp = tmpdir()
): Promise<string[]> {
  const removed: string[] = [];
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
 * Uses an `isRunning` guard and a 30s timeout so overlapping sweeps cannot interleave
 * or wedge the timer permanently if Docker or Postgres stalls.
 */
export function startReconciler(opts?: {
  intervalMs?: number;
  immediate?: boolean;
  unref?: boolean;
}): () => void {
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
    let timerId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        runReconcileSweep(),
        new Promise<never>((_resolve, reject) => {
          timerId = setTimeout(
            () => reject(new Error(`Reconcile sweep timed out after ${SWEEP_TIMEOUT_MS}ms`)),
            SWEEP_TIMEOUT_MS
          );
          timerId.unref();
        }),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`❌ [reconciler] Sweep failed: ${msg}`);
    } finally {
      if (timerId) clearTimeout(timerId);
      isRunning = false;
    }
  };

  console.log(`♻️  Desired-state reconciler started (interval: ${intervalMs}ms)`);
  if (opts?.immediate) {
    void tick();
  }
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  if (opts?.unref ?? true) {
    timer.unref();
  }
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
