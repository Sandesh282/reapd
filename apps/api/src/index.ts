// apps/api/src/index.ts
// Fastify HTTP server — entry point for the reapd control plane.
//
// Routes:
//   GET  /health             → liveness probe (used by Traefik and smoke scripts)
//   POST /webhooks/github    → receives GitHub App webhook events

import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { db } from '@reapd/db';
import {
  findRepositoryByGithubId,
  upsertRepository,
  ingestPullRequestWebhook,
} from '@reapd/db';
import {
  PullRequestWebhookPayloadSchema,
  type VerifiedPrWebhook,
} from '@reapd/types';

try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
} catch {
  // .env is optional when variables are injected via the environment
}

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = Number(process.env['PORT'] ?? 3001);
const WEBHOOK_SECRET = process.env['GITHUB_WEBHOOK_SECRET'] ?? '';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

if (!WEBHOOK_SECRET) {
  console.warn('⚠️  GITHUB_WEBHOOK_SECRET is not set — all webhooks will fail HMAC verification');
}

// ── Infrastructure ────────────────────────────────────────────────────────────

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const buildQueue = new Queue('build', { connection: redis });

// ── Fastify ───────────────────────────────────────────────────────────────────

const app = Fastify({ logger: true });

/**
 * Custom content-type parser that saves the raw Buffer alongside the parsed
 * JSON body. Fastify's default JSON parser discards the raw bytes, but we
 * need them to verify the X-Hub-Signature-256 HMAC.
 */
app.addContentTypeParser(
  'application/json',
  { parseAs: 'buffer' },
  (req, body, done) => {
    try {
      const parsed = JSON.parse((body as Buffer).toString('utf8')) as unknown;
      (req as unknown as Record<string, unknown>)['rawBody'] = body;
      done(null, parsed);
    } catch (err) {
      done(err as Error);
    }
  },
);

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', async (_req, reply) => {
  await reply.send({ ok: true });
});

app.post('/webhooks/github', async (req, reply) => {
  // ── Step 1: Extract required headers ──────────────────────────────────────
  const sigHeader  = req.headers['x-hub-signature-256'] as string | undefined;
  const eventType  = req.headers['x-github-event']      as string | undefined;
  const deliveryId = req.headers['x-github-delivery']   as string | undefined;

  if (!sigHeader || !eventType || !deliveryId) {
    return reply.status(400).send({ error: 'Missing required GitHub webhook headers' });
  }

  // ── Step 2: HMAC verification ─────────────────────────────────────────────
  const rawBody = (req as unknown as Record<string, unknown>)['rawBody'] as Buffer | undefined;
  if (!rawBody) {
    return reply.status(500).send({ error: 'Raw body unavailable' });
  }

  if (!verifySignature(rawBody, sigHeader, WEBHOOK_SECRET)) {
    return reply.status(401).send({ error: 'Invalid webhook signature' });
  }

  // ── Step 3: Route by event type ───────────────────────────────────────────

  if (eventType === 'ping') {
    return reply.send({ received: true, ignored: true });
  }

  if (eventType === 'installation' || eventType === 'installation_repositories') {
    await handleInstallationEvent(req.body as Record<string, unknown>);
    return reply.send({ received: true });
  }

  if (eventType === 'pull_request') {
    const result = await handlePullRequestEvent(
      req.body as Record<string, unknown>,
      deliveryId,
    );
    return reply.send(result);
  }

  // Unknown / unhandled event — acknowledge without processing
  return reply.send({ received: true, ignored: true });
});

// ── Event handlers ────────────────────────────────────────────────────────────

/**
 * Handles `installation` and `installation_repositories` events.
 * Upserts each repository that was just granted access to the GitHub App.
 */
async function handleInstallationEvent(body: Record<string, unknown>): Promise<void> {
  const installationId = (body['installation'] as { id: number } | undefined)?.id;
  if (!installationId) return;

  const repos = (
    (body['repositories'] as Array<{ id: number; name: string; full_name: string }> | undefined) ??
    (body['repositories_added'] as Array<{ id: number; name: string; full_name: string }> | undefined) ??
    []
  );

  for (const repo of repos) {
    const [owner, name] = repo.full_name.split('/') as [string, string];
    await upsertRepository(db, {
      githubRepoId: repo.id,
      owner,
      name,
      installationId,
    });
    app.log.info({ repoId: repo.id, fullName: repo.full_name }, 'Repository upserted on installation');
  }
}

/**
 * Handles `pull_request` events.
 * Verifies the payload, looks up the repo, runs idempotent ingestion, and
 * enqueues a build job for new (non-duplicate) events.
 */
async function handlePullRequestEvent(
  body: Record<string, unknown>,
  deliveryId: string,
): Promise<{ received: boolean; duplicate?: boolean; ignored?: boolean }> {
  const parsed = PullRequestWebhookPayloadSchema.safeParse(body);
  if (!parsed.success) {
    app.log.warn({ error: parsed.error.flatten() }, 'pull_request payload failed schema validation');
    // Return 200 so GitHub doesn't retry malformed events indefinitely
    return { received: true, ignored: true };
  }

  const payload = parsed.data;

  // 'closed' PRs are handled by the Phase 4 reconciler
  if (payload.action === 'closed') {
    return { received: true, ignored: true };
  }

  // Look up the repository — if the `installation` webhook arrived before our
  // local server was listening, auto-register from the PR payload's installation block.
  let repo = await findRepositoryByGithubId(db, payload.repository.id);
  if (!repo && payload.installation?.id) {
    await upsertRepository(db, {
      githubRepoId: payload.repository.id,
      owner: payload.repository.owner.login,
      name: payload.repository.name,
      installationId: payload.installation.id,
    });
    repo = await findRepositoryByGithubId(db, payload.repository.id);
    app.log.info(
      { githubRepoId: payload.repository.id, fullName: payload.repository.full_name },
      'Repository auto-registered from pull_request webhook',
    );
  }

  if (!repo) {
    app.log.warn(
      { githubRepoId: payload.repository.id },
      'pull_request event for unknown repository without installation ID — ignoring',
    );
    // Return 200 (not 404) so GitHub doesn't permanently disable deliveries
    return { received: true, ignored: true };
  }

  const installationId =
    payload.installation?.id ?? repo.installationId;

  const webhook: VerifiedPrWebhook = {
    deliveryId,
    eventType: 'pull_request',
    action: payload.action,
    prNumber: payload.pull_request.number,
    prTitle: payload.pull_request.title,
    commitSha: payload.pull_request.head.sha,
    branchName: payload.pull_request.head.ref,
    authorLogin: payload.pull_request.user.login,
    repoId: repo.id,
    installationId,
    ttlSeconds: repo.defaultTtlSec,
  };

  const result = await ingestPullRequestWebhook(db, webhook);

  if (result.duplicate) {
    app.log.info({ deliveryId }, 'Duplicate delivery — skipping');
    return { received: true, duplicate: true };
  }

  // Publish cancel signals for every deployment we just superseded
  for (const supersededId of result.supersededIds) {
    await redis.publish(`cancel:deploy:${supersededId}`, '1');
    app.log.info({ supersededId }, 'Cancel signal published');
  }

  // Enqueue the new build job
  await buildQueue.add('build', { deploymentId: result.newDeploymentId });
  app.log.info(
    { deploymentId: result.newDeploymentId, prNumber: payload.pull_request.number },
    '🏗️  Build job enqueued',
  );

  return { received: true, duplicate: false };
}

// ── HMAC helper ───────────────────────────────────────────────────────────────

/**
 * Constant-time comparison of the GitHub-provided HMAC-SHA256 signature
 * against our own digest of the raw request body.
 */
function verifySignature(rawBody: Buffer, sigHeader: string, secret: string): boolean {
  if (!secret) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  try {
    return timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
  } catch {
    // Buffer lengths differ → signatures can't match
    return false;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`🚀 API server listening on :${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

process.on('SIGTERM', async () => {
  await app.close();
  await buildQueue.close();
  await redis.quit();
  process.exit(0);
});

