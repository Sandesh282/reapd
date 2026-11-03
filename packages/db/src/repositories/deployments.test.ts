// packages/db/src/repositories/deployments.test.ts
// Database integration tests for `transitionDeploymentStatus` and `ingestPullRequestWebhook`:
//  1. Stale generation is forced to SUPERSEDED
//  2. Terminal state early-exit returns { transitioned: false } without throwing
//  3. Prior LIVE deployment is atomically superseded when a newer generation reaches LIVE
//  4. Concurrent webhook ingestion + worker transition do not deadlock (lock hierarchy: pr -> d)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, closeDb } from '../client.js';
import {
  expireDueDeployments,
  fenceStuckDeployments,
  getActiveDeploymentIds,
  transitionDeploymentStatus,
} from './deployments.js';
import { ingestPullRequestWebhook, upsertRepository } from './webhook.js';

const TEST_PR_NUMBER = 401;
const SHA_1 = 'a'.repeat(40);
const SHA_2 = 'b'.repeat(40);
const SHA_3 = 'c'.repeat(40);

async function isPostgresReachable(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

test('transitionDeploymentStatus: stale generation, terminal early-exit, LIVE replacement, and lock order', async (t) => {
  if (!(await isPostgresReachable())) {
    t.skip('PostgreSQL is not reachable in this environment');
    return;
  }

  const testGithubRepoId = randomInt(800_000, 899_999);
  const deliveries: string[] = [];

  try {
    const repo = await upsertRepository(db, {
      githubRepoId: testGithubRepoId,
      owner: 'Sandesh282',
      name: 'reapd-db-test',
      installationId: 77701,
    });

    // ── 1. Ingest Gen 1 and walk it to LIVE ─────────────────────────────────
    const d1 = randomUUID();
    deliveries.push(d1);
    const gen1 = await ingestPullRequestWebhook(db, {
      deliveryId: d1,
      eventType: 'pull_request',
      action: 'opened',
      prNumber: TEST_PR_NUMBER,
      prTitle: 'DB test PR',
      commitSha: SHA_1,
      branchName: 'test/db',
      authorLogin: 'Sandesh282',
      repoId: repo.id,
      installationId: 77701,
      ttlSeconds: 3600,
    });
    assert.equal(gen1.duplicate, false);
    const gen1Id = gen1.newDeploymentId!;

    await transitionDeploymentStatus(db, { deploymentId: gen1Id, toStatus: 'BUILDING' });
    await transitionDeploymentStatus(db, { deploymentId: gen1Id, toStatus: 'STARTING' });
    await transitionDeploymentStatus(db, { deploymentId: gen1Id, toStatus: 'TESTING' });
    const live1 = await transitionDeploymentStatus(db, { deploymentId: gen1Id, toStatus: 'LIVE' });
    assert.equal(live1.transitioned, true);
    assert.equal(live1.finalStatus, 'LIVE');

    // ── 2. Ingest Gen 2, start BUILDING, then ingest Gen 3 concurrently ─────
    const d2 = randomUUID();
    deliveries.push(d2);
    const gen2 = await ingestPullRequestWebhook(db, {
      deliveryId: d2,
      eventType: 'pull_request',
      action: 'synchronize',
      prNumber: TEST_PR_NUMBER,
      prTitle: 'DB test PR',
      commitSha: SHA_2,
      branchName: 'test/db',
      authorLogin: 'Sandesh282',
      repoId: repo.id,
      installationId: 77701,
      ttlSeconds: 3600,
    });
    const gen2Id = gen2.newDeploymentId!;

    await transitionDeploymentStatus(db, { deploymentId: gen2Id, toStatus: 'BUILDING' });

    // Run Gen 3 webhook ingestion concurrently with Gen 2 transitioning to STARTING
    // to verify lock ordering (pull_requests -> deployments) never deadlocks.
    const d3 = randomUUID();
    deliveries.push(d3);
    const [gen3, gen2Trans] = await Promise.all([
      ingestPullRequestWebhook(db, {
        deliveryId: d3,
        eventType: 'pull_request',
        action: 'synchronize',
        prNumber: TEST_PR_NUMBER,
        prTitle: 'DB test PR',
        commitSha: SHA_3,
        branchName: 'test/db',
        authorLogin: 'Sandesh282',
        repoId: repo.id,
        installationId: 77701,
        ttlSeconds: 3600,
      }),
      transitionDeploymentStatus(db, { deploymentId: gen2Id, toStatus: 'STARTING' }),
    ]);

    const gen3Id = gen3.newDeploymentId!;

    // Whether Gen 2's STARTING ran before or after Gen 3's ingest, calling a
    // subsequent transition on Gen 2 now that Gen 3 is committed must either
    // force SUPERSEDED (if Gen 2 was still STARTING) or return early (if already SUPERSEDED).
    const gen2After = await transitionDeploymentStatus(db, {
      deploymentId: gen2Id,
      toStatus: 'TESTING',
    });
    assert.equal(gen2After.transitioned, false);
    assert.equal(gen2After.finalStatus, 'SUPERSEDED');
    void gen2Trans;

    // ── 3. Terminal early-exit: calling transition again on SUPERSEDED is a no-op
    const gen2Noop = await transitionDeploymentStatus(db, {
      deploymentId: gen2Id,
      toStatus: 'SUPERSEDED',
    });
    assert.equal(gen2Noop.transitioned, false);
    assert.equal(gen2Noop.finalStatus, 'SUPERSEDED');

    // ── 4. Walk Gen 3 to LIVE and assert Gen 1 (previously LIVE) is now SUPERSEDED
    await transitionDeploymentStatus(db, { deploymentId: gen3Id, toStatus: 'BUILDING' });
    await transitionDeploymentStatus(db, { deploymentId: gen3Id, toStatus: 'STARTING' });
    await transitionDeploymentStatus(db, { deploymentId: gen3Id, toStatus: 'TESTING' });
    const live3 = await transitionDeploymentStatus(db, { deploymentId: gen3Id, toStatus: 'LIVE' });
    assert.equal(live3.transitioned, true);
    assert.equal(live3.finalStatus, 'LIVE');

    const statusRows = await db.execute<{ id: string; status: string }>(sql`
      SELECT id, status FROM deployments WHERE id IN (${gen1Id}, ${gen3Id})
    `);
    const byId = new Map(statusRows.map((r) => [r.id, r.status]));
    assert.equal(byId.get(gen1Id), 'EXPIRED', 'prior LIVE deployment should be EXPIRED');
    assert.equal(byId.get(gen3Id), 'LIVE', 'new deployment should be LIVE');

    // ── 5. Stress lock hierarchy over 20 concurrent iterations (no 40P01 deadlock)
    let activeDeployId = gen3Id;
    for (let i = 0; i < 20; i++) {
      const deliv = randomUUID();
      deliveries.push(deliv);
      const [nextIngest] = await Promise.all([
        ingestPullRequestWebhook(db, {
          deliveryId: deliv,
          eventType: 'pull_request',
          action: 'synchronize',
          prNumber: TEST_PR_NUMBER,
          prTitle: 'DB test PR',
          commitSha: SHA_1,
          branchName: 'test/db',
          authorLogin: 'Sandesh282',
          repoId: repo.id,
          installationId: 77701,
          ttlSeconds: 3600,
        }),
        transitionDeploymentStatus(db, {
          deploymentId: activeDeployId,
          toStatus: i === 0 ? 'EXPIRED' : 'STARTING',
        }),
      ]);
      activeDeployId = nextIngest.newDeploymentId!;
      await transitionDeploymentStatus(db, { deploymentId: activeDeployId, toStatus: 'BUILDING' });
    }

    // ── 6. Reconciler DB queries: fenceStuckDeployments, expireDueDeployments, getActiveDeploymentIds
    // Backdate `activeDeployId` (currently BUILDING) by 25 minutes and verify fenceStuckDeployments marks it FAILED
    await db.execute(sql`
      UPDATE deployments
      SET updated_at = NOW() - INTERVAL '25 minutes'
      WHERE id = ${activeDeployId}
    `);
    const fenced = await fenceStuckDeployments(db, 20);
    assert.ok(fenced.includes(activeDeployId), 'stuck BUILDING row should be fenced to FAILED');

    // Ingest a new deployment, walk it to LIVE with an already-elapsed TTL, and verify expireDueDeployments
    const dTtl = randomUUID();
    deliveries.push(dTtl);
    const ttlIngest = await ingestPullRequestWebhook(db, {
      deliveryId: dTtl,
      eventType: 'pull_request',
      action: 'synchronize',
      prNumber: TEST_PR_NUMBER,
      prTitle: 'DB test PR',
      commitSha: SHA_2,
      branchName: 'test/db',
      authorLogin: 'Sandesh282',
      repoId: repo.id,
      installationId: 77701,
      ttlSeconds: -10, // already expired
    });
    const ttlDeployId = ttlIngest.newDeploymentId!;
    await transitionDeploymentStatus(db, { deploymentId: ttlDeployId, toStatus: 'BUILDING' });
    await transitionDeploymentStatus(db, { deploymentId: ttlDeployId, toStatus: 'STARTING' });
    await transitionDeploymentStatus(db, { deploymentId: ttlDeployId, toStatus: 'TESTING' });
    await transitionDeploymentStatus(db, { deploymentId: ttlDeployId, toStatus: 'LIVE' });

    const activeBeforeExpire = await getActiveDeploymentIds(db);
    assert.ok(activeBeforeExpire.activeContainerIds.has(ttlDeployId));

    const expiredDue = await expireDueDeployments(db);
    assert.ok(expiredDue.includes(ttlDeployId), 'TTL-elapsed LIVE row should be expired');

    const activeAfterExpire = await getActiveDeploymentIds(db);
    assert.ok(!activeAfterExpire.activeContainerIds.has(ttlDeployId));

    // ── 7. PR closed webhook: expires LIVE deployment and marks is_open = false
    const dReopen = randomUUID();
    deliveries.push(dReopen);
    const reopenIngest = await ingestPullRequestWebhook(db, {
      deliveryId: dReopen,
      eventType: 'pull_request',
      action: 'reopened',
      prNumber: TEST_PR_NUMBER,
      prTitle: 'DB test PR',
      commitSha: SHA_3,
      branchName: 'test/db',
      authorLogin: 'Sandesh282',
      repoId: repo.id,
      installationId: 77701,
      ttlSeconds: 3600,
    });
    const reopenDeployId = reopenIngest.newDeploymentId!;
    await transitionDeploymentStatus(db, { deploymentId: reopenDeployId, toStatus: 'BUILDING' });
    await transitionDeploymentStatus(db, { deploymentId: reopenDeployId, toStatus: 'STARTING' });
    await transitionDeploymentStatus(db, { deploymentId: reopenDeployId, toStatus: 'TESTING' });
    await transitionDeploymentStatus(db, { deploymentId: reopenDeployId, toStatus: 'LIVE' });

    const dClose = randomUUID();
    deliveries.push(dClose);
    const closeRes = await ingestPullRequestWebhook(db, {
      deliveryId: dClose,
      eventType: 'pull_request',
      action: 'closed',
      prNumber: TEST_PR_NUMBER,
      prTitle: 'DB test PR',
      commitSha: SHA_3,
      branchName: 'test/db',
      authorLogin: 'Sandesh282',
      repoId: repo.id,
      installationId: 77701,
      ttlSeconds: 3600,
    });
    assert.equal(closeRes.duplicate, false);
    assert.equal(closeRes.newDeploymentId, undefined);
    assert.deepEqual(closeRes.expiredIds, [reopenDeployId]);
  } finally {
    for (const deliv of deliveries) {
      await db.execute(sql`DELETE FROM webhook_deliveries WHERE delivery_id = ${deliv}`).catch(() => {});
    }
    await db.execute(sql`DELETE FROM repositories WHERE github_repo_id = ${testGithubRepoId}`).catch(() => {});
    await closeDb().catch(() => {});
  }
});
