// apps/worker/src/reconciler/reconciler.test.ts
// Unit tests for `runReconcileSweep` and `sweepStaleTempBuildDirs`:
//  1. Lists Docker containers & images BEFORE reading active IDs from Postgres (prevents TOCTOU race)
//  2. Preserves active and `cli-*` resources while removing orphaned containers & images
//  3. Does not count failed removals in `removedContainerIds` / `removedImageTags`
//  4. Sweeps stale `reapd-build-*` temp directories while keeping fresh ones

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Dockerode from 'dockerode';
import type { DrizzleClient } from '@reapd/db';
import { parseWorkerRole, resolveMetricsPort } from '../index.js';
import { registry } from '../metrics.js';
import { runReconcileSweep, sweepStaleTempBuildDirs } from './index.js';

test('runReconcileSweep snapshots Docker before querying active DB IDs, preserves cli-* & active resources, and skips failed removals', async () => {
  const callOrder: string[] = [];
  const removedContainers: string[] = [];
  const removedImages: string[] = [];

  const fakeDocker = {
    listContainers: async () => {
      callOrder.push('docker:listContainers');
      return [
        {
          Id: 'cont-active-111111111111',
          Names: ['/reapd-pr-101'],
          Labels: {
            'reapd.managed': 'true',
            'reapd.deployment_id': 'deploy-live-1',
            'reapd.subdomain': 'pr-101',
          },
          Image: 'reapd-pr-101:g1-aaaaaaa',
          State: 'running',
          Status: 'Up 1 minute',
        },
        {
          Id: 'cont-cli-222222222222',
          Names: ['/reapd-pr-102'],
          Labels: {
            'reapd.managed': 'true',
            'reapd.deployment_id': 'cli-pr-102-12345678',
            'reapd.subdomain': 'pr-102',
          },
          Image: 'reapd-pr-102:bbbbbbb',
          State: 'running',
          Status: 'Up 1 minute',
        },
        {
          Id: 'cont-orphan-333333333333',
          Names: ['/reapd-pr-103'],
          Labels: {
            'reapd.managed': 'true',
            'reapd.deployment_id': 'deploy-expired-3',
            'reapd.subdomain': 'pr-103',
          },
          Image: 'reapd-pr-103:g1-ccccccc',
          State: 'running',
          Status: 'Up 5 minutes',
        },
        {
          Id: 'cont-fail-444444444444',
          Names: ['/reapd-pr-104'],
          Labels: {
            'reapd.managed': 'true',
            'reapd.deployment_id': 'deploy-expired-4',
            'reapd.subdomain': 'pr-104',
          },
          Image: 'reapd-pr-104:g1-ddddddd',
          State: 'running',
          Status: 'Up 5 minutes',
        },
      ];
    },
    listImages: async () => {
      callOrder.push('docker:listImages');
      return [
        {
          Id: 'sha256:1111',
          RepoTags: ['reapd-pr-101:g1-aaaaaaa'],
          Labels: {
            'reapd.managed': 'true',
            'reapd.deployment_id': 'deploy-building-2',
            'reapd.subdomain': 'pr-101',
          },
        },
        {
          Id: 'sha256:2222',
          RepoTags: ['reapd-pr-102:bbbbbbb'],
          Labels: {
            'reapd.managed': 'true',
            'reapd.deployment_id': 'cli-pr-102-12345678',
            'reapd.subdomain': 'pr-102',
          },
        },
        {
          Id: 'sha256:3333',
          RepoTags: ['reapd-pr-103:g1-ccccccc'],
          Labels: {
            'reapd.managed': 'true',
            'reapd.deployment_id': 'deploy-expired-3',
            'reapd.subdomain': 'pr-103',
          },
        },
      ];
    },
    getContainer: (id: string) => ({
      remove: async () => {
        if (id === 'cont-fail-444444444444') {
          throw new Error('simulated docker error');
        }
        removedContainers.push(id);
      },
    }),
    getImage: (tag: string) => ({
      remove: async () => {
        removedImages.push(tag);
      },
    }),
  } as unknown as Dockerode;

  let txCount = 0;
  const fakeDb = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      txCount++;
      const currentTx = txCount;
      const fakeTx = {
        execute: async () => {
          // tx 1 = expireDueDeployments, tx 2 = fenceStuckDeployments
          if (currentTx === 1) return [{ id: 'deploy-expired-3' }];
          if (currentTx === 2) return [];
          return [];
        },
      };
      return fn(fakeTx);
    },
    execute: async () => {
      callOrder.push('db:getActiveDeploymentIds');
      return [
        { id: 'deploy-live-1', status: 'LIVE' },
        { id: 'deploy-building-2', status: 'BUILDING' },
      ];
    },
  } as unknown as DrizzleClient;

  const tmpRoot = await mkdtemp(join(tmpdir(), 'reapd-reconcile-unit-'));
  try {
    const staleDir = join(tmpRoot, 'reapd-build-stale-1');
    const freshDir = join(tmpRoot, 'reapd-build-fresh-2');
    await mkdir(staleDir);
    await mkdir(freshDir);
    const oldTime = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(staleDir, oldTime, oldTime);

    const res = await runReconcileSweep({
      dbClient: fakeDb,
      dockerClient: fakeDocker,
      tmpRootDir: tmpRoot,
      tmpDirMaxAgeMs: 10 * 60 * 1000,
    });

    // Verify Docker snapshot happened BEFORE db:getActiveDeploymentIds
    const listContainersIdx = callOrder.indexOf('docker:listContainers');
    const listImagesIdx = callOrder.indexOf('docker:listImages');
    const dbActiveIdx = callOrder.indexOf('db:getActiveDeploymentIds');
    assert.ok(listContainersIdx >= 0 && listContainersIdx < dbActiveIdx);
    assert.ok(listImagesIdx >= 0 && listImagesIdx < dbActiveIdx);

    // Only cont-orphan-333333333333 succeeded; cont-fail threw and must not be in removedContainerIds
    assert.deepEqual(res.removedContainerIds, ['cont-orphan-333333333333']);
    assert.deepEqual(removedContainers, ['cont-orphan-333333333333']);

    // deploy-building-2 image is preserved (in activeBuildOrLiveIds), cli image preserved, expired-3 pruned
    assert.deepEqual(res.removedImageTags, ['reapd-pr-103:g1-ccccccc']);
    assert.deepEqual(removedImages, ['reapd-pr-103:g1-ccccccc']);

    // Stale temp build dir removed, fresh one kept
    assert.deepEqual(res.removedTmpDirs, [staleDir]);
    const remainingSweep = await sweepStaleTempBuildDirs(10 * 60 * 1000, tmpRoot);
    assert.deepEqual(remainingSweep, []);

    // Verify runReconcileSweep incremented Prometheus counters only for succeeded operations
    const metricsOutput = await registry.metrics();
    assert.match(metricsOutput, /reapd_reconciler_expired_total\{[^}]*\}\s+[1-9]\d*/);
    assert.match(metricsOutput, /reapd_deployments_total\{[^}]*status="EXPIRED"[^}]*\}\s+[1-9]\d*/);
    assert.match(metricsOutput, /reapd_reconciler_orphans_removed_total\{[^}]*kind="container"[^}]*\}\s+[1-9]\d*/);
    assert.match(metricsOutput, /reapd_reconciler_orphans_removed_total\{[^}]*kind="image"[^}]*\}\s+[1-9]\d*/);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test('runReconcileSweep fences stuck deployments and increments fenced + FAILED counters', async () => {
  const fakeDocker = {
    listContainers: async () => [],
    listImages: async () => [],
  } as unknown as Dockerode;

  let txCount = 0;
  const fakeDb = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      txCount++;
      const currentTx = txCount;
      const fakeTx = {
        execute: async () => {
          if (currentTx === 1) return [];
          // tx 2 = fenceStuckDeployments
          if (currentTx === 2) return [{ id: 'deploy-stuck-999', status: 'BUILDING' }];
          return [];
        },
      };
      return fn(fakeTx);
    },
    execute: async () => [],
  } as unknown as DrizzleClient;

  const tmpRoot = await mkdtemp(join(tmpdir(), 'reapd-reconcile-fence-'));
  try {
    const res = await runReconcileSweep({
      dbClient: fakeDb,
      dockerClient: fakeDocker,
      stuckBuildMinutes: 0.05,
      tmpRootDir: tmpRoot,
    });

    assert.deepEqual(res.fencedDeploymentIds, ['deploy-stuck-999']);
    const metricsOutput = await registry.metrics();
    assert.match(metricsOutput, /reapd_reconciler_fenced_total\{[^}]*\}\s+[1-9]\d*/);
    assert.match(metricsOutput, /reapd_deployments_total\{[^}]*status="FAILED"[^}]*\}\s+[1-9]\d*/);
    assert.match(
      metricsOutput,
      /reapd_reconciler_last_success_timestamp_seconds\{[^}]*\}\s+[1-9]\d*/
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test('parseWorkerRole and resolveMetricsPort support standalone worker and reconciler modes', () => {
  assert.equal(parseWorkerRole(undefined), 'all');
  assert.equal(parseWorkerRole(''), 'all');
  assert.equal(parseWorkerRole('ALL'), 'all');
  assert.equal(parseWorkerRole('worker'), 'worker');
  assert.equal(parseWorkerRole('reconciler'), 'reconciler');
  assert.throws(() => parseWorkerRole('invalid-role'), /Invalid REAPD_ROLE/);

  assert.equal(resolveMetricsPort('all', {}), 9091);
  assert.equal(resolveMetricsPort('worker', { REAPD_WORKER_METRICS_PORT: '19091' }), 19091);
  assert.equal(resolveMetricsPort('reconciler', {}), 9092);
  assert.equal(
    resolveMetricsPort('reconciler', { REAPD_RECONCILER_METRICS_PORT: '19095' }),
    19095
  );
});

