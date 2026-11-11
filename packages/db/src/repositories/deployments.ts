// packages/db/src/repositories/deployments.ts
// Atomic deployment state transitions with audit trail.
// Worker lifecycle transitions go through `transitionDeploymentStatus`
// (webhook ingestion performs its batch supersede inside `ingestPullRequestWebhook`).

import { sql } from 'drizzle-orm';
import {
  assertValidTransition,
  TERMINAL_STATUSES,
  type DeploymentStatus,
  type TestRunStatus,
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
  pullRequestId: string;
  commitSha: string;
  generation: number;
  subdomain: string;
  previewUrl: string;
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
    pull_request_id: string;
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
      d.pull_request_id,
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
    pullRequestId: row.pull_request_id,
    commitSha: row.commit_sha.trim(),
    generation: row.generation,
    subdomain: row.subdomain,
    previewUrl: `https://${row.subdomain}.preview.localhost`,
    status: row.status,
    prNumber: row.pr_number,
    branchName: row.branch_name,
    owner: row.owner,
    name: row.name,
    installationId: Number(row.installation_id),
  };
}

/**
 * Reads the parent PR's current `sticky_comment_id` and `latest_generation`
 * so the worker only updates the sticky PR comment if its `generation` is still
 * the latest generation on the PR (preventing an older slow-failing generation from
 * overwriting a newer generation's comment).
 */
export async function getPullRequestStickyCommentState(
  db: DrizzleClient,
  pullRequestId: string
): Promise<{ stickyCommentId: number | null; latestGeneration: number } | null> {
  const rows = await db.execute<{
    sticky_comment_id: number | string | null;
    latest_generation: number;
  }>(sql`
    SELECT sticky_comment_id, latest_generation
    FROM pull_requests
    WHERE id = ${pullRequestId}
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    stickyCommentId:
      row.sticky_comment_id !== null && row.sticky_comment_id !== undefined
        ? Number(row.sticky_comment_id)
        : null,
    latestGeneration: Number(row.latest_generation),
  };
}

/**
 * Stores or updates `pull_requests.sticky_comment_id` after creating a new sticky comment on GitHub.
 * When `expectedGeneration` is supplied, the update only takes effect if `latest_generation <= expectedGeneration`
 * so a late-finishing older generation cannot overwrite a newer generation's comment ID.
 */
export async function setPullRequestStickyCommentId(
  db: DrizzleClient,
  pullRequestId: string,
  stickyCommentId: number | null,
  expectedGeneration?: number
): Promise<boolean> {
  const genGuard =
    expectedGeneration !== undefined
      ? sql`AND latest_generation <= ${expectedGeneration}`
      : sql``;
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE pull_requests
    SET sticky_comment_id = ${stickyCommentId}
    WHERE id = ${pullRequestId}
      ${genGuard}
    RETURNING id
  `);
  return rows.length > 0;
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

export interface DeploymentSummaryItem {
  id: string;
  pullRequestId: string;
  repoFullName: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  branchName: string;
  isOpen: boolean;
  commitSha: string;
  generation: number;
  subdomain: string;
  previewUrl: string;
  status: DeploymentStatus;
  buildDurationMs: number | null;
  failureReason: string | null;
  expiresAt: string;
  updatedAt: string;
  createdAt: string;
}

export interface ListRecentDeploymentsFilter {
  repo?: string;
  prNumber?: number;
  limit?: number;
}

export interface DeploymentEventItem {
  id: string;
  deploymentId: string;
  fromStatus: DeploymentStatus | null;
  toStatus: DeploymentStatus;
  reason: string | null;
  createdAt: string;
}

export interface TestRunSummaryItem {
  id: string;
  deploymentId: string;
  status: TestRunStatus;
  durationMs: number;
  consoleErrorCount: number;
  traceR2Key: string | null;
  screenshotR2Key: string | null;
  failureMessage: string | null;
  createdAt: string;
}

export interface UpsertTestRunInput {
  deploymentId: string;
  status: TestRunStatus;
  durationMs: number;
  consoleErrorCount?: number;
  traceR2Key?: string | null;
  screenshotR2Key?: string | null;
  failureMessage?: string | null;
}

export interface DeploymentDetailWithEvents extends DeploymentSummaryItem {
  containerId: string | null;
  imageTag: string | null;
  logArchiveKey: string | null;
  events: DeploymentEventItem[];
  testRun: TestRunSummaryItem | null;
}

const DEFAULT_DEPLOYMENTS_LIMIT = 50;
const MAX_DEPLOYMENTS_LIMIT = 100;

function toIsoString(val: Date | string): string {
  return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
}

/**
 * Lists recent deployments ordered by `created_at DESC, generation DESC` with optional
 * repository (`owner/name` or `name`) and PR number filters.
 * Server-side `limit` is clamped to `[1, 100]` (default 50).
 */
export async function listRecentDeployments(
  db: DrizzleClient,
  filter?: ListRecentDeploymentsFilter
): Promise<DeploymentSummaryItem[]> {
  const rawLimit = filter?.limit ?? DEFAULT_DEPLOYMENTS_LIMIT;
  const clampedLimit = Math.min(
    MAX_DEPLOYMENTS_LIMIT,
    Math.max(1, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : DEFAULT_DEPLOYMENTS_LIMIT)
  );

  const repoTrimmed = filter?.repo?.trim();
  const repoClause = repoTrimmed
    ? repoTrimmed.includes('/')
      ? sql`AND LOWER(r.owner || '/' || r.name) = LOWER(${repoTrimmed})`
      : sql`AND LOWER(r.name) = LOWER(${repoTrimmed})`
    : sql``;

  const prClause =
    filter?.prNumber !== undefined && Number.isInteger(filter.prNumber) && filter.prNumber > 0
      ? sql`AND pr.pr_number = ${filter.prNumber}`
      : sql``;

  const rows = await db.execute<{
    id: string;
    pull_request_id: string;
    repo_owner: string;
    repo_name: string;
    pr_number: number;
    branch_name: string;
    is_open: boolean;
    commit_sha: string;
    generation: number;
    subdomain: string;
    status: DeploymentStatus;
    build_duration_ms: number | null;
    failure_reason: string | null;
    expires_at: Date | string;
    updated_at: Date | string;
    created_at: Date | string;
  }>(sql`
    SELECT
      d.id,
      d.pull_request_id,
      r.owner       AS repo_owner,
      r.name        AS repo_name,
      pr.pr_number,
      pr.branch_name,
      pr.is_open,
      d.commit_sha,
      d.generation,
      d.subdomain,
      d.status,
      d.build_duration_ms,
      d.failure_reason,
      d.expires_at,
      d.updated_at,
      d.created_at
    FROM deployments d
    JOIN pull_requests pr ON pr.id = d.pull_request_id
    JOIN repositories  r  ON r.id  = pr.repo_id
    WHERE TRUE
      ${repoClause}
      ${prClause}
    ORDER BY d.created_at DESC, d.generation DESC
    LIMIT ${clampedLimit}
  `);

  return rows.map((row) => ({
    id: row.id,
    pullRequestId: row.pull_request_id,
    repoFullName: `${row.repo_owner}/${row.repo_name}`,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    prNumber: row.pr_number,
    branchName: row.branch_name,
    isOpen: row.is_open,
    commitSha: row.commit_sha.trim(),
    generation: row.generation,
    subdomain: row.subdomain,
    previewUrl: `https://${row.subdomain}.preview.localhost`,
    status: row.status,
    buildDurationMs: row.build_duration_ms,
    failureReason: row.failure_reason,
    expiresAt: toIsoString(row.expires_at),
    updatedAt: toIsoString(row.updated_at),
    createdAt: toIsoString(row.created_at),
  }));
}

/**
 * Fetches a single deployment joined with its parent PR, repository, and ordered
 * `deployment_events` timeline (`created_at ASC, id ASC`).
 * Returns `null` if the deployment does not exist.
 */
export async function getDeploymentByIdWithEvents(
  db: DrizzleClient,
  deploymentId: string
): Promise<DeploymentDetailWithEvents | null> {
  const rows = await db.execute<{
    id: string;
    pull_request_id: string;
    repo_owner: string;
    repo_name: string;
    pr_number: number;
    branch_name: string;
    is_open: boolean;
    commit_sha: string;
    generation: number;
    subdomain: string;
    status: DeploymentStatus;
    container_id: string | null;
    image_tag: string | null;
    build_duration_ms: number | null;
    failure_reason: string | null;
    log_archive_key: string | null;
    expires_at: Date | string;
    updated_at: Date | string;
    created_at: Date | string;
  }>(sql`
    SELECT
      d.id,
      d.pull_request_id,
      r.owner       AS repo_owner,
      r.name        AS repo_name,
      pr.pr_number,
      pr.branch_name,
      pr.is_open,
      d.commit_sha,
      d.generation,
      d.subdomain,
      d.status,
      d.container_id,
      d.image_tag,
      d.build_duration_ms,
      d.failure_reason,
      d.log_archive_key,
      d.expires_at,
      d.updated_at,
      d.created_at
    FROM deployments d
    JOIN pull_requests pr ON pr.id = d.pull_request_id
    JOIN repositories  r  ON r.id  = pr.repo_id
    WHERE d.id = ${deploymentId}
    LIMIT 1
  `);

  const row = rows[0];
  if (!row) return null;

  const eventRows = await db.execute<{
    id: string;
    deployment_id: string;
    from_status: DeploymentStatus | null;
    to_status: DeploymentStatus;
    reason: string | null;
    created_at: Date | string;
  }>(sql`
    SELECT
      id,
      deployment_id,
      from_status,
      to_status,
      reason,
      created_at
    FROM deployment_events
    WHERE deployment_id = ${deploymentId}
    ORDER BY created_at ASC, id ASC
  `);

  const testRunRows = await db.execute<{
    id: string;
    deployment_id: string;
    status: TestRunStatus;
    duration_ms: number;
    console_error_count: number;
    trace_r2_key: string | null;
    screenshot_r2_key: string | null;
    failure_message: string | null;
    created_at: Date | string;
  }>(sql`
    SELECT
      id,
      deployment_id,
      status,
      duration_ms,
      console_error_count,
      trace_r2_key,
      screenshot_r2_key,
      failure_message,
      created_at
    FROM test_runs
    WHERE deployment_id = ${deploymentId}
    LIMIT 1
  `);

  const tr = testRunRows[0];

  return {
    id: row.id,
    pullRequestId: row.pull_request_id,
    repoFullName: `${row.repo_owner}/${row.repo_name}`,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    prNumber: row.pr_number,
    branchName: row.branch_name,
    isOpen: row.is_open,
    commitSha: row.commit_sha.trim(),
    generation: row.generation,
    subdomain: row.subdomain,
    previewUrl: `https://${row.subdomain}.preview.localhost`,
    status: row.status,
    containerId: row.container_id,
    imageTag: row.image_tag,
    buildDurationMs: row.build_duration_ms,
    failureReason: row.failure_reason,
    logArchiveKey: row.log_archive_key,
    expiresAt: toIsoString(row.expires_at),
    updatedAt: toIsoString(row.updated_at),
    createdAt: toIsoString(row.created_at),
    events: eventRows.map((ev) => ({
      id: ev.id,
      deploymentId: ev.deployment_id,
      fromStatus: ev.from_status,
      toStatus: ev.to_status,
      reason: ev.reason,
      createdAt: toIsoString(ev.created_at),
    })),
    testRun: tr
      ? {
          id: tr.id,
          deploymentId: tr.deployment_id,
          status: tr.status,
          durationMs: Number(tr.duration_ms),
          consoleErrorCount: Number(tr.console_error_count),
          traceR2Key: tr.trace_r2_key,
          screenshotR2Key: tr.screenshot_r2_key,
          failureMessage: tr.failure_message,
          createdAt: toIsoString(tr.created_at),
        }
      : null,
  };
}

/**
 * Upserts a `test_runs` row for a deployment (`UNIQUE (deployment_id)` per PRD v2.2 fix #4).
 * Ensures retry runs or repeated invocations overwrite the single test_run record cleanly.
 */
export async function upsertTestRun(
  db: DrizzleClient,
  input: UpsertTestRunInput
): Promise<TestRunSummaryItem> {
  const durationMs = Math.max(0, Math.trunc(input.durationMs));
  const consoleErrorCount = Math.max(0, Math.trunc(input.consoleErrorCount ?? 0));
  const traceR2Key = input.traceR2Key ?? null;
  const screenshotR2Key = input.screenshotR2Key ?? null;
  const failureMessage = input.failureMessage ?? null;

  const rows = await db.execute<{
    id: string;
    deployment_id: string;
    status: TestRunStatus;
    duration_ms: number;
    console_error_count: number;
    trace_r2_key: string | null;
    screenshot_r2_key: string | null;
    failure_message: string | null;
    created_at: Date | string;
  }>(sql`
    INSERT INTO test_runs (
      deployment_id,
      status,
      duration_ms,
      console_error_count,
      trace_r2_key,
      screenshot_r2_key,
      failure_message
    )
    VALUES (
      ${input.deploymentId},
      ${input.status}::test_run_status,
      ${durationMs},
      ${consoleErrorCount},
      ${traceR2Key},
      ${screenshotR2Key},
      ${failureMessage}
    )
    ON CONFLICT (deployment_id) DO UPDATE
      SET status              = EXCLUDED.status,
          duration_ms         = EXCLUDED.duration_ms,
          console_error_count = EXCLUDED.console_error_count,
          trace_r2_key        = EXCLUDED.trace_r2_key,
          screenshot_r2_key   = EXCLUDED.screenshot_r2_key,
          failure_message     = EXCLUDED.failure_message,
          created_at          = NOW()
    RETURNING
      id,
      deployment_id,
      status,
      duration_ms,
      console_error_count,
      trace_r2_key,
      screenshot_r2_key,
      failure_message,
      created_at
  `);

  const row = rows[0]!;
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    status: row.status,
    durationMs: Number(row.duration_ms),
    consoleErrorCount: Number(row.console_error_count),
    traceR2Key: row.trace_r2_key,
    screenshotR2Key: row.screenshot_r2_key,
    failureMessage: row.failure_message,
    createdAt: toIsoString(row.created_at),
  };
}

