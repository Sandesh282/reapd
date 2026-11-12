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
} from './metrics.js';
import { startReconciler } from './reconciler/index.js';

export * from './builder/git-clone.js';
export * from './builder/image-builder.js';
export * from './jobs/build.js';
export * from './logs/log-sink.js';
export * from './reconciler/index.js';

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

  const redisUrl = process.env['REDIS_URL'];
  if (!redisUrl) {
    console.error('❌ REDIS_URL is not set — run `npm run env:init` to generate local credentials');
    process.exit(1);
  }
  const queueName = process.env['REAPD_BUILD_QUEUE'] ?? 'build';
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<BuildJobPayload>(queueName, buildJobHandler, {
    connection: redis,
    concurrency: 2,
  });

  const stopReconciler = startReconciler();

  // ── Prometheus queue-depth + DB status poller ────────────────────────────
  const metricsRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const metricsQueue = new Queue<BuildJobPayload>(queueName, {
    connection: metricsRedis,
  });

  let isPollingMetrics = false;
  let lastMetricsWarnAt = 0;
  const pollMetrics = async (): Promise<void> => {
    if (isPollingMetrics) return;
    isPollingMetrics = true;
    try {
      const [counts, statusCounts] = await Promise.all([
        metricsQueue.getJobCounts('waiting', 'active', 'delayed'),
        countDeploymentsByStatus(db),
      ]);
      queueWaiting.set((counts.waiting ?? 0) + (counts.delayed ?? 0));
      queueActive.set(counts.active ?? 0);
      activePreviews.set(statusCounts.LIVE);
      for (const [status, count] of Object.entries(statusCounts) as Array<
        [DeploymentStatus, number]
      >) {
        deploymentsByStatus.set({ status }, count);
      }
    } catch (err) {
      // Non-fatal (metrics may lag during Redis/DB hiccups), but surface it at most once a minute
      // so a broken connection is visible instead of silently reporting stale numbers.
      if (Date.now() - lastMetricsWarnAt > 60_000) {
        lastMetricsWarnAt = Date.now();
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`⚠️  Metrics poll failed: ${redactSecrets(msg)}`);
      }
    } finally {
      isPollingMetrics = false;
    }
  };

  const metricsPoller = setInterval(() => void pollMetrics(), 15_000);
  void pollMetrics();

  // ── Metrics HTTP server on :9091 ─────────────────────────────────────────
  const METRICS_PORT = Number(process.env['REAPD_WORKER_METRICS_PORT'] ?? 9091);
  const METRICS_HOST = process.env['REAPD_WORKER_METRICS_HOST'] ?? '127.0.0.1';
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
    console.log(`📊 Worker metrics available at http://${METRICS_HOST}:${METRICS_PORT}/metrics`);
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

  const shutdown = async (): Promise<void> => {
    console.log('🛑 Shutting down worker...');
    // Stop timers and signal active builds to abort FIRST before awaiting any Redis/network close.
    clearInterval(metricsPoller);
    stopReconciler();
    abortAllActiveBuilds();
    // Prometheus keeps scrape connections alive; drop them so close() can complete immediately.
    metricsServer.closeAllConnections();
    metricsServer.close();
    try {
      await worker.close();
    } finally {
      await metricsQueue.close().catch(() => {});
      await metricsRedis.quit().catch(() => {});
      await redis.quit().catch(() => {});
      process.exit(0);
    }
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
