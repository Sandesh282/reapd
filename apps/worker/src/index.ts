// apps/worker/src/index.ts
// Worker barrel & daemon entrypoint.
// When imported as a library, exports builder/job modules without side effects.
// When executed directly (`tsx src/index.ts`), starts the BullMQ worker + reconciler.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { abortAllActiveBuilds, buildJobHandler, type BuildJobPayload } from './jobs/build.js';
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
    // Clear the reconciler interval (any in-flight sweep is idempotent if interrupted by exit)
    stopReconciler();
    abortAllActiveBuilds();
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
