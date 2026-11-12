// apps/worker/src/index.ts
// Worker barrel & daemon entrypoint.
// When imported as a library, exports builder/job modules without side effects.
// When executed directly (`tsx src/index.ts`), starts the BullMQ worker + reconciler
// and a lightweight HTTP server on :9091 exposing GET /metrics for Prometheus.

import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { db, countDeploymentsByStatus } from '@reapd/db';
import type { DeploymentStatus } from '@reapd/types';
import { abortAllActiveBuilds, buildJobHandler, type BuildJobPayload } from './jobs/build.js';
import { redactSecrets } from './logs/log-sink.js';
import {
  registry,
  queueWaiting,
  queueActive,
  activePreviews,
  deploymentsByStatus,
  metricsPollErrorsTotal,
  metricsPollLastSuccessTimestampSeconds,
} from './metrics.js';
import { startReconciler } from './reconciler/index.js';

export * from './builder/git-clone.js';
export * from './builder/image-builder.js';
export * from './jobs/build.js';
export * from './logs/log-sink.js';
export * from './reconciler/index.js';

export type WorkerRole = 'all' | 'worker' | 'reconciler';

export function parseWorkerRole(raw = process.env['REAPD_ROLE']): WorkerRole {
  const normalized = (raw ?? 'all').trim().toLowerCase();
  if (normalized === '' || normalized === 'all') return 'all';
  if (normalized === 'worker') return 'worker';
  if (normalized === 'reconciler') return 'reconciler';
  throw new Error(
    `Invalid REAPD_ROLE="${raw}". Expected "all", "worker", or "reconciler".`
  );
}

export function resolveMetricsPort(
  role: WorkerRole,
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw =
    role === 'reconciler'
      ? env['REAPD_RECONCILER_METRICS_PORT'] ?? env['REAPD_WORKER_METRICS_PORT'] ?? '9092'
      : env['REAPD_WORKER_METRICS_PORT'] ?? '9091';
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : role === 'reconciler' ? 9092 : 9091;
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

const isMainModule = checkIsMainModule();

if (isMainModule) {
  try {
    process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
  } catch {
    // .env is optional when variables are injected via the environment
  }

  const role = parseWorkerRole();
  const enableWorker = role === 'all' || role === 'worker';
  const enableReconciler = role === 'all' || role === 'reconciler';

  const redisUrl = process.env['REDIS_URL'];
  if (enableWorker && !redisUrl) {
    console.error('❌ REDIS_URL is not set — run `npm run env:init` to generate local credentials');
    process.exit(1);
  }
  const queueName = process.env['REAPD_BUILD_QUEUE'] ?? 'build';

  let redis: Redis | null = null;
  let worker: Worker<BuildJobPayload> | null = null;
  if (enableWorker && redisUrl) {
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    worker = new Worker<BuildJobPayload>(queueName, buildJobHandler, {
      connection: redis,
      concurrency: 2,
    });

    worker.on('ready', () => {
      console.log('👷 BullMQ build worker ready and listening on queue "build"');
    });

    worker.on('completed', (job) => {
      console.log(`✅ Job ${job.id} (deployment ${job.data.deploymentId}) completed`);
    });

    worker.on('failed', (job, err) => {
      console.error(
        `❌ Job ${job?.id} (deployment ${job?.data.deploymentId}) failed: ${redactSecrets(err.message)}`,
      );
    });

    worker.on('error', (err) => {
      console.error('❌ BullMQ worker error:', redactSecrets(err.message));
    });
  }

  const stopReconciler = enableReconciler
    ? startReconciler({ immediate: role === 'reconciler', unref: enableWorker })
    : null;

  // ── Prometheus queue-depth + DB status poller ────────────────────────────
  const metricsRedis = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: null }) : null;
  const metricsQueue = metricsRedis
    ? new Queue<BuildJobPayload>(queueName, {
        connection: metricsRedis,
      })
    : null;

  const METRICS_POLL_TIMEOUT_MS = 10_000;
  let isPollingMetrics = false;
  let lastMetricsWarnAt = 0;
  const pollMetrics = async (): Promise<void> => {
    if (isPollingMetrics) return;
    isPollingMetrics = true;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const [counts, statusCounts] = await Promise.race([
        Promise.all([
          metricsQueue ? metricsQueue.getJobCounts('waiting', 'active', 'delayed') : Promise.resolve(null),
          countDeploymentsByStatus(db),
        ]),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`Metrics poll timed out after ${METRICS_POLL_TIMEOUT_MS}ms`)),
            METRICS_POLL_TIMEOUT_MS,
          );
          timeoutId.unref();
        }),
      ]);
      if (counts) {
        queueWaiting.set((counts.waiting ?? 0) + (counts.delayed ?? 0));
        queueActive.set(counts.active ?? 0);
      }
      activePreviews.set(statusCounts.LIVE);
      for (const [status, count] of Object.entries(statusCounts) as Array<
        [DeploymentStatus, number]
      >) {
        deploymentsByStatus.set({ status }, count);
      }
      metricsPollLastSuccessTimestampSeconds.set(Date.now() / 1000);
    } catch (err) {
      metricsPollErrorsTotal.inc();
      // Non-fatal (metrics may lag during Redis/DB hiccups), but surface it at most once a minute
      // so a broken connection is visible instead of silently reporting stale numbers.
      if (Date.now() - lastMetricsWarnAt > 60_000) {
        lastMetricsWarnAt = Date.now();
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`⚠️  Metrics poll failed: ${redactSecrets(msg)}`);
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      isPollingMetrics = false;
    }
  };

  const metricsPoller = setInterval(() => void pollMetrics(), 15_000);
  void pollMetrics();

  // ── Metrics HTTP server (:9091 for worker/all, :9092 for standalone reconciler)
  const METRICS_PORT = resolveMetricsPort(role);
  const METRICS_HOST =
    (role === 'reconciler' ? process.env['REAPD_RECONCILER_METRICS_HOST'] : undefined) ??
    process.env['REAPD_WORKER_METRICS_HOST'] ??
    '127.0.0.1';
  const metricsServer = createServer(async (req, res) => {
    try {
      if (req.url === '/metrics' && req.method === 'GET') {
        const metrics = await registry.metrics();
        res.writeHead(200, { 'Content-Type': registry.contentType });
        res.end(metrics);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️  Failed to serialize worker metrics: ${redactSecrets(msg)}`);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end('Internal Server Error');
    }
  });
  // Metrics are best-effort: a port conflict (e.g. a second worker on the same host, or a smoke
  // script spawning its own worker) must never take down the build worker.
  metricsServer.on('error', (err: NodeJS.ErrnoException) => {
    console.warn(
      `⚠️  Metrics server disabled (${err.code ?? 'error'} on ${METRICS_HOST}:${METRICS_PORT}): ${err.message}`,
    );
  });
  metricsServer.listen(METRICS_PORT, METRICS_HOST, () => {
    console.log(
      `📊 ${role === 'reconciler' ? 'Reconciler' : 'Worker'} metrics available at http://${METRICS_HOST}:${METRICS_PORT}/metrics`,
    );
  });

  const shutdown = async (): Promise<void> => {
    console.log(`🛑 Shutting down ${role}...`);
    // Force exit after 8s if Redis or Docker sockets hang during shutdown.
    setTimeout(() => process.exit(1), 8_000).unref();
    // Stop timers and signal active builds to abort FIRST before awaiting any Redis/network close.
    clearInterval(metricsPoller);
    stopReconciler?.();
    abortAllActiveBuilds();
    // Prometheus keeps scrape connections alive; drop them so close() can complete immediately.
    metricsServer.closeAllConnections();
    metricsServer.close();
    try {
      await worker?.close();
    } finally {
      await metricsQueue?.close().catch(() => {});
      await metricsRedis?.quit().catch(() => {});
      await redis?.quit().catch(() => {});
      process.exit(0);
    }
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
