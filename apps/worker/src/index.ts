// apps/worker/src/index.ts
// Worker barrel & daemon entrypoint.
// When imported as a library, exports builder/job modules without side effects.
// When executed directly (`tsx src/index.ts`), starts the BullMQ worker + reconciler.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { buildJobHandler, type BuildJobPayload } from './jobs/build.js';
import { startReconciler } from './reconciler/index.js';

export * from './builder/git-clone.js';
export * from './builder/image-builder.js';
export * from './jobs/build.js';
export * from './reconciler/index.js';

const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  try {
    process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
  } catch {
    // .env is optional when variables are injected via the environment
  }

  const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const queueName = process.env['REAPD_BUILD_QUEUE'] ?? 'build';
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<BuildJobPayload>(queueName, buildJobHandler, {
    connection: redis,
    concurrency: 2,
  });

  const stopReconciler = startReconciler();

  worker.on('ready', () => {
    console.log('👷 BullMQ build worker ready and listening on queue "build"');
  });

  worker.on('completed', (job) => {
    console.log(`✅ Job ${job.id} (deployment ${job.data.deploymentId}) completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`❌ Job ${job?.id} (deployment ${job?.data.deploymentId}) failed: ${err.message}`);
  });

  worker.on('error', (err) => {
    console.error('❌ BullMQ worker error:', err.message);
  });

  const shutdown = async (): Promise<void> => {
    console.log('🛑 Shutting down worker...');
    stopReconciler();
    try {
      await worker.close();
    } finally {
      await redis.quit().catch(() => {});
      process.exit(0);
    }
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
