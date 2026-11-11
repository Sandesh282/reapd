// packages/db/src/repositories/deployments.ts
// Atomic deployment state transitions with audit trail.
// Worker lifecycle transitions go through `transitionDeploymentStatus`
// (webhook ingestion performs its batch supersede inside `ingestPullRequestWebhook`).

import { sql } from 'drizzle-orm';
import {
  assertValidTransition,
  TERMINAL_STATUSES,
  type DeploymentStatus,
} from '@reapd/types';
import type { DrizzleClient } from '../client.js';

export class DeploymentNotFoundError extends Error {
  constructor(deploymentId: string) {
    super(`Deployment not found: ${deploymentId}`);
    this.name = 'DeploymentNotFoundError';
  }
}

export interface TransitionInput {
  deploymentId: string;
  toStatus: DeploymentStatus;
  reason?: string;
  containerId?: string;
  imageTag?: string;
  buildDurationMs?: number;
  logArchiveKey?: string;
}

export interface TransitionResult {
  /** true if the transition landed on toStatus, false if already terminal */
  transitioned: boolean;
  finalStatus: DeploymentStatus;
}

/**
 * Atomically transitions a deployment to a new status.
 *
 * Three guarantees:
 *  1. If the deployment is already in a terminal state (FAILED, SUPERSEDED, EXPIRED),
 *     returns early without throwing — callers don't need to treat this as an error.
 *     This covers the SUPERSEDED→SUPERSEDED case where a webhook marks a deployment
 *     SUPERSEDED while a worker is still calling transitionDeploymentStatus (issue #6).
 *  2. If a newer commit has incremented latest_generation, the effective target is
 *     forced to SUPERSEDED regardless of what the worker requested.
 *  3. Every transition is recorded in deployment_events in the same transaction.
 */
export async function transitionDeploymentStatus(
  db: DrizzleClient,
  input: TransitionInput
): Promise<TransitionResult> {
  return db.transaction(async (tx) => {
    // ── Step 1: Lock parent PR first, then deployment (matches webhook lock order)
    // Locking `pull_requests` before `deployments` in both `ingestPullRequestWebhook`
    // and `transitionDeploymentStatus` prevents 40P01 deadlocks under concurrent load.
    const prRows = await tx.execute<{
      id: string;
      latest_generation: number;
    }>(sql`
      SELECT pr.id, pr.latest_generation
      FROM   pull_requests pr
      WHERE  pr.id = (
        SELECT d.pull_request_id FROM deployments d WHERE d.id = ${input.deploymentId}
      )
      FOR UPDATE
    `);

    const prRow = prRows[0];
    if (!prRow) throw new DeploymentNotFoundError(input.deploymentId);

    const rows = await tx.execute<{
      status: DeploymentStatus;
      generation: number;
      pull_request_id: string;
    }>(sql`
      SELECT d.status, d.generation, d.pull_request_id
      FROM   deployments d
      WHERE  d.id = ${input.deploymentId}
      FOR UPDATE
    `);

    const row = rows[0];
    if (!row) throw new DeploymentNotFoundError(input.deploymentId);

    // ── Early exit: already terminal ─────────────────────────────────────────
    // Do not throw — let the caller treat this as a no-op and continue clean-up.
    if (TERMINAL_STATUSES.has(row.status)) {
      return { transitioned: false, finalStatus: row.status };
    }

    // ── Step 2: Stale-generation check ──────────────────────────────────────
    const isStale =
      row.generation < prRow.latest_generation &&
      input.toStatus !== 'SUPERSEDED' &&
      input.toStatus !== 'EXPIRED';

    const effectiveTarget: DeploymentStatus = isStale ? 'SUPERSEDED' : input.toStatus;
    const effectiveReason = isStale
      ? `Preempted by generation ${prRow.latest_generation}`
      : (input.reason ?? null);

    // ── Step 3: Domain-layer guard ───────────────────────────────────────────
    assertValidTransition(row.status, effectiveTarget);

    // ── Step 4: Update deployments row ──────────────────────────────────────
    await tx.execute(sql`
      UPDATE deployments
      SET
        status            = ${effectiveTarget}::deployment_status,
        container_id      = COALESCE(${input.containerId    ?? null}, container_id),
        image_tag         = COALESCE(${input.imageTag       ?? null}, image_tag),
        build_duration_ms = COALESCE(${input.buildDurationMs ?? null}, build_duration_ms),
        log_archive_key   = COALESCE(${input.logArchiveKey  ?? null}, log_archive_key),
        failure_reason    = CASE
          WHEN ${effectiveTarget}::deployment_status IN ('FAILED'::deployment_status, 'SUPERSEDED'::deployment_status)
          THEN ${effectiveReason}
          ELSE failure_reason
        END,
        updated_at        = NOW()
      WHERE id = ${input.deploymentId}
    `);

    // ── Step 5: Append immutable audit event ─────────────────────────────────
    await tx.execute(sql`
      INSERT INTO deployment_events (deployment_id, from_status, to_status, reason)
      VALUES (
        ${input.deploymentId},
        ${row.status}::deployment_status,
        ${effectiveTarget}::deployment_status,
        ${effectiveReason}
      )
    `);

    // ── Step 6: Expire any prior LIVE deployment on the same PR ──────────────
    if (effectiveTarget === 'LIVE') {
      const replaceReason = `Replaced by generation ${row.generation}`;
      const priorLive = await tx.execute<{ id: string }>(sql`
        UPDATE deployments
        SET status     = 'EXPIRED',
            updated_at = NOW()
        WHERE pull_request_id = ${row.pull_request_id}
          AND generation < ${row.generation}
          AND status = 'LIVE'
        RETURNING id
      `);

      for (const old of priorLive) {
        await tx.execute(sql`
          INSERT INTO deployment_events (deployment_id, from_status, to_status, reason)
          VALUES (
            ${old.id},
            'LIVE'::deployment_status,
            'EXPIRED'::deployment_status,
            ${replaceReason}
          )
        `);
      }
    }

    return {
      transitioned: effectiveTarget === input.toStatus,
      finalStatus: effectiveTarget,
    };
  });
}

export interface DeploymentWithRepo {
  id: string;
  commitSha: string;
  generation: number;
  subdomain: string;
  status: DeploymentStatus;
  prNumber: number;
  branchName: string;
  owner: string;
  name: string;
  installationId: number;
}

/**
 * Fetches a deployment joined with its parent PR and repository metadata.
 * Used by the BullMQ build worker at the start of a job.
 */
export async function getDeploymentWithRepo(
  db: DrizzleClient,
  deploymentId: string
): Promise<DeploymentWithRepo | null> {
  const rows = await db.execute<{
    id: string;
    commit_sha: string;
    generation: number;
    subdomain: string;
    status: DeploymentStatus;
    pr_number: number;
    branch_name: string;
    owner: string;
    name: string;
    installation_id: number;
  }>(sql`
    SELECT
      d.id,
      d.commit_sha,
      d.generation,
      d.subdomain,
      d.status,
      pr.pr_number,
      pr.branch_name,
      r.owner,
      r.name,
      r.installation_id
    FROM deployments d
    JOIN pull_requests pr ON pr.id = d.pull_request_id
    JOIN repositories  r  ON r.id  = pr.repo_id
    WHERE d.id = ${deploymentId}
    LIMIT 1
  `);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    commitSha: row.commit_sha.trim(),
    generation: row.generation,
    subdomain: row.subdomain,
    status: row.status,
    prNumber: row.pr_number,
    branchName: row.branch_name,
    owner: row.owner,
    name: row.name,
    installationId: Number(row.installation_id),
  };
}

/**
 * Marks all `LIVE` deployments whose `expires_at <= NOW()` as `EXPIRED`
 * and records an immutable `deployment_events` entry for each.
 * Uses `idx_deployments_reconcile (status, expires_at)`.
 *
 * Note on lock ordering: this CTE locks only `deployments` rows (`ORDER BY id FOR UPDATE SKIP LOCKED`)
 * and never acquires a `pull_requests` lock, so it cannot form a deadlock cycle with
 * `transitionDeploymentStatus` or `ingestPullRequestWebhook`. Any row currently locked by
 * an active worker transaction is safely skipped until the next sweep.
 */
export async function expireDueDeployments(
  db: DrizzleClient,
  opts?: { repoId?: string }
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const repoFilter = opts?.repoId
      ? sql`AND pull_request_id IN (SELECT id FROM pull_requests WHERE repo_id = ${opts.repoId})`
      : sql``;

    const expired = await tx.execute<{ id: string }>(sql`
      WITH due AS (
        SELECT id
        FROM deployments
        WHERE status = 'LIVE'
          AND expires_at <= NOW()
          ${repoFilter}
        ORDER BY id
        FOR UPDATE SKIP LOCKED
      )
      UPDATE deployments d
      SET status     = 'EXPIRED',
          updated_at = NOW()
      FROM due
      WHERE d.id = due.id
      RETURNING d.id
    `);

    for (const row of expired) {
      await tx.execute(sql`
        INSERT INTO deployment_events (deployment_id, from_status, to_status, reason)
        VALUES (
          ${row.id},
          'LIVE'::deployment_status,
          'EXPIRED'::deployment_status,
          'TTL expired (reconciler sweep)'
        )
      `);
    }

    return expired.map((r) => r.id);
  });
}

/**
 * Fences any deployment stuck in `QUEUED`, `BUILDING`, `STARTING`, or `TESTING`
 * whose `updated_at` is older than `maxAgeMinutes` (default: 20 minutes per PRD §6.1)
 * by transitioning it to `FAILED`.
 *
 * Note on lock ordering: locks only `deployments` (`ORDER BY id FOR UPDATE SKIP LOCKED`)
 * and never waits on `pull_requests`, avoiding any deadlock cycle.
 */
export async function fenceStuckDeployments(
  db: DrizzleClient,
  maxAgeMinutes = 20,
  opts?: { repoId?: string }
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const reason = `Build timed out or worker crashed (exceeded ${maxAgeMinutes}m reconciler fence)`;
    const repoFilter = opts?.repoId
      ? sql`AND pull_request_id IN (SELECT id FROM pull_requests WHERE repo_id = ${opts.repoId})`
      : sql``;

    const stuck = await tx.execute<{ id: string; status: DeploymentStatus }>(sql`
      WITH stale AS (
        SELECT id, status
        FROM deployments
        WHERE status IN ('QUEUED', 'BUILDING', 'STARTING', 'TESTING')
          AND updated_at <= NOW() - (${maxAgeMinutes} * INTERVAL '1 minute')
          ${repoFilter}
        ORDER BY id
        FOR UPDATE SKIP LOCKED
      )
      UPDATE deployments d
      SET status         = 'FAILED',
          failure_reason = ${reason},
          updated_at     = NOW()
      FROM stale
      WHERE d.id = stale.id
      RETURNING d.id, stale.status
    `);

    for (const row of stuck) {
      await tx.execute(sql`
        INSERT INTO deployment_events (deployment_id, from_status, to_status, reason)
        VALUES (
          ${row.id},
          ${row.status}::deployment_status,
          'FAILED'::deployment_status,
          ${reason}
        )
      `);
    }

    return stuck.map((r) => r.id);
  });
}

/**
 * Returns the set of deployment IDs that are legitimately allowed to own a
 * Docker container or image right now (`QUEUED`, `BUILDING`, `STARTING`, `TESTING`, or `LIVE`).
 * Any managed container or image whose `reapd.deployment_id` is NOT in this set is an orphan.
 */
export async function getActiveDeploymentIds(
  db: DrizzleClient
): Promise<{
  activeBuildOrLiveIds: Set<string>;
  activeContainerIds: Set<string>;
}> {
  const rows = await db.execute<{ id: string; status: DeploymentStatus }>(sql`
    SELECT id, status
    FROM deployments
    WHERE status IN ('QUEUED', 'BUILDING', 'STARTING', 'TESTING', 'LIVE')
  `);

  const activeBuildOrLiveIds = new Set<string>();
  const activeContainerIds = new Set<string>();

  for (const row of rows) {
    activeBuildOrLiveIds.add(row.id);
    if (
      row.status === 'STARTING' ||
      row.status === 'TESTING' ||
      row.status === 'LIVE'
    ) {
      activeContainerIds.add(row.id);
    }
  }

  return { activeBuildOrLiveIds, activeContainerIds };
}



