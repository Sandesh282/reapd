// packages/db/src/repositories/webhook.ts
// Idempotent webhook ingestion — the entry point for every pull_request event.
// All DB writes for a single delivery happen in one transaction.

import { sql } from 'drizzle-orm';
import type { VerifiedPrWebhook } from '@reapd/types';
import type { DrizzleClient } from '../client.js';

export interface IngestResult {
  duplicate: boolean;
  newDeploymentId?: string;
  supersededIds: string[];
  expiredIds?: string[];
}

/**
 * Processes a verified pull_request webhook delivery.
 *
 * Idempotency: the delivery_id (X-GitHub-Delivery UUID) is inserted with
 * ON CONFLICT DO NOTHING. A duplicate delivery returns immediately without
 * touching any other table.
 *
 * Within a single transaction:
 *  - For `opened` / `synchronize` / `reopened`:
 *    1. Gate on delivery_id uniqueness
 *    2. Upsert the PR row, incrementing latest_generation and setting is_open = TRUE
 *    3. Supersede all in-flight deployments (QUEUED/BUILDING/STARTING/TESTING)
 *    4. Insert a new QUEUED deployment + its initial audit event
 *  - For `closed`:
 *    1. Gate on delivery_id uniqueness
 *    2. Upsert/lock the PR row, incrementing latest_generation (fences any in-flight workers) and setting is_open = FALSE
 *    3. Supersede all in-flight deployments (QUEUED/BUILDING/STARTING/TESTING)
 *    4. Expire all LIVE deployments on this PR (LIVE → EXPIRED)
 *
 * After the transaction commits, the caller is responsible for:
 *  - Publishing cancel signals to Redis for each supersededId
 *  - Enqueuing the new deployment to BullMQ (when newDeploymentId is present)
 */
export async function ingestPullRequestWebhook(
  db: DrizzleClient,
  payload: VerifiedPrWebhook
): Promise<IngestResult> {
  return db.transaction(async (tx) => {

    // ── Step 1: Atomic idempotency gate ────────────────────────────────────
    const delivered = await tx.execute<{ delivery_id: string }>(sql`
      INSERT INTO webhook_deliveries (delivery_id, event_type)
      VALUES (${payload.deliveryId}, ${payload.eventType})
      ON CONFLICT (delivery_id) DO NOTHING
      RETURNING delivery_id
    `);

    if (delivered.length === 0) {
      return { duplicate: true, supersededIds: [] };
    }

    const isClose = payload.action === 'closed';

    // ── Step 2: Upsert PR, increment generation ─────────────────────────────
    const prs = await tx.execute<{ id: string; latest_generation: number }>(sql`
      INSERT INTO pull_requests (repo_id, pr_number, branch_name, latest_generation, is_open)
      VALUES (${payload.repoId}, ${payload.prNumber}, ${payload.branchName}, 1, ${!isClose})
      ON CONFLICT (repo_id, pr_number) DO UPDATE
        SET branch_name       = EXCLUDED.branch_name,
            latest_generation = pull_requests.latest_generation + 1,
            is_open           = ${!isClose}
      RETURNING id, latest_generation
    `);

    const pr = prs[0]!;

    // ── Step 3: Supersede all in-flight deployments ─────────────────────────
    const supersedeFailureReason = isClose
      ? `Superseded by PR #${payload.prNumber} close (gen ${pr.latest_generation})`
      : `Superseded by commit ${payload.commitSha.slice(0, 7)} (gen ${pr.latest_generation})`;
    const supersedeEventReason = isClose
      ? `Pull request closed (generation ${pr.latest_generation})`
      : `Superseded by generation ${pr.latest_generation}`;

    const superseded = await tx.execute<{ id: string; status: string }>(sql`
      UPDATE deployments
      SET
        status         = 'SUPERSEDED',
        failure_reason = ${supersedeFailureReason},
        updated_at     = NOW()
      WHERE pull_request_id = ${pr.id}
        AND status IN ('QUEUED', 'BUILDING', 'STARTING', 'TESTING')
      RETURNING id, status
    `);

    for (const old of superseded) {
      await tx.execute(sql`
        INSERT INTO deployment_events (deployment_id, from_status, to_status, reason)
        VALUES (
          ${old.id},
          ${old.status}::deployment_status,
          'SUPERSEDED',
          ${supersedeEventReason}
        )
      `);
    }

    // ── Step 4a: On PR close, expire any LIVE deployments and return ────────
    if (isClose) {
      const expired = await tx.execute<{ id: string }>(sql`
        UPDATE deployments
        SET status     = 'EXPIRED',
            updated_at = NOW()
        WHERE pull_request_id = ${pr.id}
          AND status = 'LIVE'
        RETURNING id
      `);

      for (const exp of expired) {
        await tx.execute(sql`
          INSERT INTO deployment_events (deployment_id, from_status, to_status, reason)
          VALUES (
            ${exp.id},
            'LIVE'::deployment_status,
            'EXPIRED'::deployment_status,
            'Pull request closed'
          )
        `);
      }

      return {
        duplicate: false,
        supersededIds: superseded.map((r) => r.id),
        expiredIds: expired.map((r) => r.id),
      };
    }

    // ── Step 4b: Insert new QUEUED deployment + initial audit event ──────────
    const newDeploys = await tx.execute<{ id: string }>(sql`
      INSERT INTO deployments (
        pull_request_id, commit_sha, generation, subdomain, status, expires_at
      )
      VALUES (
        ${pr.id},
        ${payload.commitSha},
        ${pr.latest_generation},
        ${'pr-' + payload.prNumber},
        'QUEUED',
        NOW() + (${payload.ttlSeconds} * INTERVAL '1 second')
      )
      RETURNING id
    `);

    const newDeploy = newDeploys[0]!;

    await tx.execute(sql`
      INSERT INTO deployment_events (deployment_id, from_status, to_status, reason)
      VALUES (${newDeploy.id}, NULL, 'QUEUED', 'Webhook received and verified')
    `);

    return {
      duplicate: false,
      newDeploymentId: newDeploy.id,
      supersededIds: superseded.map((r) => r.id),
    };
  });
}

/**
 * Looks up a repository row by its GitHub repo ID.
 * Returns null if the app hasn't been installed on this repo yet.
 */
export async function findRepositoryByGithubId(
  db: DrizzleClient,
  githubRepoId: number
): Promise<{ id: string; defaultTtlSec: number; installationId: number } | null> {
  const rows = await db.execute<{
    id: string;
    default_ttl_sec: number;
    installation_id: number;
  }>(sql`
    SELECT id, default_ttl_sec, installation_id
    FROM repositories
    WHERE github_repo_id = ${githubRepoId}
    LIMIT 1
  `);

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    defaultTtlSec: Number(row.default_ttl_sec),
    installationId: Number(row.installation_id),
  };
}

/**
 * Upserts a repository row when the GitHub App is installed.
 * Called by the `installation` webhook handler.
 */
export async function upsertRepository(
  db: DrizzleClient,
  repo: {
    githubRepoId: number;
    owner: string;
    name: string;
    installationId: number;
  }
): Promise<{ id: string; defaultTtlSec: number; installationId: number }> {
  const rows = await db.execute<{
    id: string;
    default_ttl_sec: number;
    installation_id: number;
  }>(sql`
    INSERT INTO repositories (github_repo_id, owner, name, installation_id)
    VALUES (${repo.githubRepoId}, ${repo.owner}, ${repo.name}, ${repo.installationId})
    ON CONFLICT (github_repo_id) DO UPDATE
      SET installation_id = EXCLUDED.installation_id,
          owner           = EXCLUDED.owner,
          name            = EXCLUDED.name
    RETURNING id, default_ttl_sec, installation_id
  `);
  const row = rows[0]!;
  return {
    id: row.id,
    defaultTtlSec: Number(row.default_ttl_sec),
    installationId: Number(row.installation_id),
  };
}

/**
 * Deletes a repository row by its GitHub repo ID (cascades to PRs and deployments).
 * Any running preview containers for that repo become orphans and are cleaned up
 * on the next reconciler sweep.
 */
export async function deleteRepositoryByGithubId(
  db: DrizzleClient,
  githubRepoId: number
): Promise<void> {
  await db.execute(sql`
    DELETE FROM repositories WHERE github_repo_id = ${githubRepoId}
  `);
}

/**
 * Deletes all repository rows belonging to a uninstalled GitHub App installation.
 */
export async function deleteRepositoriesByInstallationId(
  db: DrizzleClient,
  installationId: number
): Promise<void> {
  await db.execute(sql`
    DELETE FROM repositories WHERE installation_id = ${installationId}
  `);
}


