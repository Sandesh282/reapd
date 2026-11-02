// apps/worker/src/index.ts
// Worker daemon entrypoint — runs the BullMQ `build` queue worker and the 60s reconciler.

import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { buildJobHandler, type BuildJobPayload } from './jobs/build.js';
import { startReconciler } from './reconciler/index.js';

export * from './builder/git-clone.js';
export * from './builder/image-builder.js';
export * from './jobs/build.js';
export * from './reconciler/index.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker<BuildJobPayload>('build', buildJobHandler, {
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

async function shutdown(): Promise<void> {
  console.log('🛑 Shutting down worker...');
  stopReconciler();
  await worker.close();
  await redis.quit();
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
