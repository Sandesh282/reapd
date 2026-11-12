// apps/api/src/index.ts
// Fastify HTTP server — entry point for the reapd control plane.
//
// Routes:
//   GET  /health                     → liveness probe (used by Traefik and smoke scripts)
//   POST /webhooks/github            → receives GitHub App webhook events
//   GET  /api/deployments            → recent deployments list (?repo=, ?pr=, ?limit=)
//   GET  /api/deployments/:id        → deployment detail + ordered `deployment_events` timeline
//   GET  /api/deployments/:id/logs   → Server-Sent Events (SSE) build log stream (`XREAD BLOCK`)

import { createHmac, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  db,
  deleteRepositoriesByInstallationId,
  deleteRepositoryByGithubId,
  findRepositoryByGithubId,
  upsertRepository,
  ingestPullRequestWebhook,
} from '@reapd/db';
import {
  PullRequestWebhookPayloadSchema,
  type VerifiedPrWebhook,
} from '@reapd/types';
import { registerDeploymentRoutes, type DeploymentRoutesDeps } from './routes/deployments.js';
import {
  registry as metricsRegistry,
  webhookRejectionsTotal,
  webhookRequestsTotal,
} from './metrics.js';

export * from './routes/deployments.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLED_PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'closed']);

export interface BuildAppOptions {
  logger?: boolean;
  webhookSecret?: string;
  dashboardOrigins?: string[];
  publishCancel?: (deploymentId: string) => Promise<void>;
  enqueueBuildJob?: (deploymentId: string) => Promise<void>;
  deploymentRoutesDeps?: DeploymentRoutesDeps;
}

/**
 * Constant-time comparison of the GitHub-provided HMAC-SHA256 signature
 * against our own digest of the raw request body.
 */
export function verifySignature(rawBody: Buffer, sigHeader: string, secret: string): boolean {
  if (!secret) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  try {
    return timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
  } catch {
    // Buffer lengths differ → signatures can't match
    return false;
  }
}

/**
 * Constructs and configures the Fastify control-plane instance without binding a port
 * or requiring live Redis/BullMQ connections when test dependencies are injected.
 */
export async function buildApp(opts?: BuildAppOptions): Promise<FastifyInstance> {
  const webhookSecret = opts?.webhookSecret ?? process.env['GITHUB_WEBHOOK_SECRET'] ?? '';
  const allowedOriginsList =
    opts?.dashboardOrigins ??
    (process.env['REAPD_DASHBOARD_ORIGIN'] ?? 'http://localhost:3000,http://127.0.0.1:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const allowedOriginsSet = new Set(allowedOriginsList);

  const publishCancel =
    opts?.publishCancel ??
    (async (): Promise<void> => {
      throw new Error('publishCancel is not configured on this Fastify instance');
    });
  const enqueueBuildJob =
    opts?.enqueueBuildJob ??
    (async (): Promise<void> => {
      throw new Error('enqueueBuildJob is not configured on this Fastify instance');
    });

  const app = Fastify({
    logger: opts?.logger ?? true,
    bodyLimit: 1024 * 1024, // 1 MB cap; HMAC is verified on the raw Buffer before JSON.parse
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow requests with no Origin header (curl, server-to-server, webhooks) or matching dashboard origins
      if (!origin || allowedOriginsSet.has(origin)) {
        cb(null, true);
        return;
      }
      cb(null, false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  /**
   * Custom content-type parser that preserves the raw Buffer without running
   * `JSON.parse` upfront. The webhook handler verifies the X-Hub-Signature-256
   * HMAC over the raw bytes first and only parses JSON for authenticated payloads.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      (req as unknown as Record<string, unknown>)['rawBody'] = body;
      // Defer JSON.parse on the webhook route until after HMAC verification
      if (req.url.split('?')[0] === '/webhooks/github') {
        done(null, body);
        return;
      }
      try {
        done(null, JSON.parse((body as Buffer).toString('utf8')));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  // ── Core Routes ───────────────────────────────────────────────────────────────

  app.get('/health', async (_req, reply) => {
    await reply.send({ ok: true });
  });

  // Prometheus scrape endpoint. Rejects proxied/tunneled requests (`X-Forwarded-*`) so a
  // webhook tunnel (e.g. ngrok / Cloudflare Tunnel) pointing at :3001 never exposes /metrics.
  app.get('/metrics', async (req, reply) => {
    if (
      req.headers['x-forwarded-for'] !== undefined ||
      req.headers['x-forwarded-host'] !== undefined ||
      req.headers['x-forwarded-proto'] !== undefined
    ) {
      return reply.status(403).send({ error: 'Metrics endpoint is not accessible via proxy' });
    }
    const body = await metricsRegistry.metrics();
    await reply.header('Content-Type', metricsRegistry.contentType).send(body);
  });

  await registerDeploymentRoutes(app, {
    allowedCorsOrigins: allowedOriginsSet,
    ...opts?.deploymentRoutesDeps,
  });

  app.post('/webhooks/github', async (req, reply) => {
    // ── Step 1: Extract and validate required headers ─────────────────────────
    const sigHeader  = req.headers['x-hub-signature-256'] as string | undefined;
    const eventType  = req.headers['x-github-event']      as string | undefined;
    const deliveryId = req.headers['x-github-delivery']   as string | undefined;

    if (!sigHeader || !eventType || !deliveryId || !UUID_REGEX.test(deliveryId)) {
      webhookRejectionsTotal.inc({ reason: 'invalid_headers' });
      return reply.status(400).send({ error: 'Missing or invalid required GitHub webhook headers' });
    }

    // ── Step 2: HMAC verification (runs before JSON.parse) ────────────────────
    const rawBody = (req as unknown as Record<string, unknown>)['rawBody'] as Buffer | undefined;
    if (!rawBody) {
      webhookRejectionsTotal.inc({ reason: 'invalid_headers' });
      return reply.status(415).send({ error: 'Expected application/json webhook payload' });
    }

    if (!verifySignature(rawBody, sigHeader, webhookSecret)) {
      webhookRejectionsTotal.inc({ reason: 'invalid_signature' });
      return reply.status(401).send({ error: 'Invalid webhook signature' });
    }

    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      webhookRejectionsTotal.inc({ reason: 'malformed_json' });
      return reply.status(400).send({ error: 'Malformed JSON body' });
    }

    // ── Step 3: Route by event type ───────────────────────────────────────────

    // Label values are clamped to known sets so a signed-but-unexpected payload can never
    // create unbounded Prometheus time series.
    const rawActionLabel = parsedBody['action'];
    webhookRequestsTotal.inc({
      event: eventType === 'pull_request' || eventType === 'ping' ? eventType : 'other',
      action:
        typeof rawActionLabel === 'string' && HANDLED_PR_ACTIONS.has(rawActionLabel)
          ? rawActionLabel
          : 'other',
    });

    if (eventType === 'ping') {
      return reply.send({ received: true, ignored: true });
    }

    if (eventType === 'installation' || eventType === 'installation_repositories') {
      await handleInstallationEvent(parsedBody);
      return reply.send({ received: true });
    }

    if (eventType === 'pull_request') {
      const result = await handlePullRequestEvent(parsedBody, deliveryId);
      return reply.send(result);
    }

    // Unknown / unhandled event — acknowledge without processing
    return reply.send({ received: true, ignored: true });
  });

  async function handleInstallationEvent(body: Record<string, unknown>): Promise<void> {
    const action = body['action'] as string | undefined;
    const installationId = (body['installation'] as { id: number } | undefined)?.id;
    if (!installationId) return;

    if (action === 'deleted') {
      const activeIds = await deleteRepositoriesByInstallationId(db, installationId);
      for (const deployId of activeIds) {
        await publishCancel(deployId);
      }
      app.log.info(
        { installationId, cancelledBuilds: activeIds.length },
        'Repositories removed on installation deleted',
      );
      return;
    }

    if (action === 'removed') {
      const removedRepos =
        (body['repositories_removed'] as Array<{ id: number; full_name?: string }> | undefined) ?? [];
      for (const repo of removedRepos) {
        const activeIds = await deleteRepositoryByGithubId(db, repo.id, installationId);
        for (const deployId of activeIds) {
          await publishCancel(deployId);
        }
        app.log.info(
          { repoId: repo.id, fullName: repo.full_name, cancelledBuilds: activeIds.length },
          'Repository removed from installation',
        );
      }
      return;
    }

    if (action !== 'created' && action !== 'added') return;

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

  async function handlePullRequestEvent(
    body: Record<string, unknown>,
    deliveryId: string,
  ): Promise<{ received: boolean; duplicate?: boolean; ignored?: boolean }> {
    const rawAction = body['action'];
    if (typeof rawAction !== 'string' || !HANDLED_PR_ACTIONS.has(rawAction)) {
      return { received: true, ignored: true };
    }

    const parsed = PullRequestWebhookPayloadSchema.safeParse(body);
    if (!parsed.success) {
      app.log.warn({ error: parsed.error.flatten() }, 'pull_request payload failed schema validation');
      return { received: true, ignored: true };
    }

    const payload = parsed.data;

    // Reject PRs originating from external or deleted forks so untrusted code never runs in BuildKit
    // (allow `closed` events through even when head.repo is null/missing because the author deleted their fork branch)
    const headRepo = payload.pull_request.head.repo;
    if (
      payload.action !== 'closed' &&
      (!headRepo || headRepo.id !== payload.repository.id)
    ) {
      webhookRejectionsTotal.inc({ reason: 'fork_rejected' });
      app.log.warn(
        { headRepoId: headRepo?.id ?? null, baseRepoId: payload.repository.id },
        'Ignoring pull_request from external or deleted fork',
      );
      return { received: true, ignored: true };
    }

    let repo = await findRepositoryByGithubId(db, payload.repository.id);
    if (!repo && payload.installation?.id) {
      repo = await upsertRepository(db, {
        githubRepoId: payload.repository.id,
        owner: payload.repository.owner.login,
        name: payload.repository.name,
        installationId: payload.installation.id,
      });
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
      webhookRejectionsTotal.inc({ reason: 'duplicate' });
      app.log.info({ deliveryId }, 'Duplicate delivery — skipping');
      return { received: true, duplicate: true };
    }

    for (const supersededId of result.supersededIds) {
      await publishCancel(supersededId);
      app.log.info({ supersededId }, 'Cancel signal published');
    }

    if (payload.action === 'closed') {
      app.log.info(
        {
          prNumber: payload.pull_request.number,
          supersededCount: result.supersededIds.length,
          expiredCount: result.expiredIds?.length ?? 0,
        },
        '🔒 PR closed — expired LIVE and superseded in-flight deployments',
      );
      return { received: true, duplicate: false };
    }

    if (!result.newDeploymentId) {
      throw new Error(`Expected newDeploymentId for pull_request action=${payload.action}`);
    }

    await enqueueBuildJob(result.newDeploymentId);
    app.log.info(
      { deploymentId: result.newDeploymentId, prNumber: payload.pull_request.number },
      '🏗️  Build job enqueued',
    );

    return { received: true, duplicate: false };
  }

  return app;
}

function checkIsMainModule(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  try {
    return realpathSync(entryArg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(entryArg) === fileURLToPath(import.meta.url);
  }
}

if (checkIsMainModule()) {
  try {
    process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
  } catch {
    // .env is optional when variables are injected via the environment
  }

  const PORT = Number(process.env['PORT'] ?? 3001);
  const HOST = process.env['REAPD_API_HOST']?.trim() || '127.0.0.1';
  const WEBHOOK_SECRET = process.env['GITHUB_WEBHOOK_SECRET'] ?? '';
  const REDIS_URL = process.env['REDIS_URL'];
  if (!REDIS_URL) {
    console.error('❌ REDIS_URL is not set — run `npm run env:init` to generate local credentials');
    process.exit(1);
  }
  const BUILD_QUEUE_NAME = process.env['REAPD_BUILD_QUEUE'] ?? 'build';

  if (!LOOPBACK_HOSTS.has(HOST)) {
    console.warn(`⚠️  API is binding to non-loopback host "${HOST}" — read endpoints are unauthenticated`);
  }

  if (!WEBHOOK_SECRET) {
    console.warn('⚠️  GITHUB_WEBHOOK_SECRET is not set — all webhooks will fail HMAC verification');
  }

  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });
  const buildQueue = new Queue<{ deploymentId: string }>(BUILD_QUEUE_NAME, {
    connection: redis,
  });

  const app = await buildApp({
    webhookSecret: WEBHOOK_SECRET,
    publishCancel: async (deploymentId: string) => {
      await redis.publish(`cancel:deploy:${deploymentId}`, '1');
    },
    enqueueBuildJob: async (deploymentId: string) => {
      await buildQueue.add(
        'build',
        { deploymentId },
        {
          jobId: deploymentId,
          attempts: 1,
          removeOnComplete: 100,
          removeOnFail: 200,
        },
      );
    },
  });

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`🚀 API server listening on ${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (): Promise<void> => {
    try {
      await app.close();
    } finally {
      await buildQueue.close().catch(() => {});
      await redis.quit().catch(() => {});
      process.exit(0);
    }
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
