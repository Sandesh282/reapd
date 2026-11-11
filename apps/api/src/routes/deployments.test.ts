// apps/api/src/routes/deployments.test.ts
// Unit tests for Fastify REST & SSE deployment endpoints (`GET /api/deployments`,
// `GET /api/deployments/:id`, `GET /api/deployments/:id/logs`).

import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeploymentDetailWithEvents, DeploymentSummaryItem } from '@reapd/db';
import { buildApp } from '../index.js';
import {
  compareStreamIds,
  extractFirstEntryIdFromXinfo,
  parseRawStreamEntry,
  type RawStreamTuple,
  type SseRedisClient,
} from './deployments.js';

const DEPLOY_ID_1 = '11111111-1111-4111-8111-111111111111';
const DEPLOY_ID_2 = '22222222-2222-4222-8222-222222222222';
const PR_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeDeploymentDetail(
  overrides?: Partial<DeploymentDetailWithEvents>,
): DeploymentDetailWithEvents {
  return {
    id: DEPLOY_ID_1,
    pullRequestId: PR_ID_1,
    repoFullName: 'Sandesh282/reapd',
    repoOwner: 'Sandesh282',
    repoName: 'reapd',
    prNumber: 501,
    branchName: 'feat/sse',
    isOpen: true,
    commitSha: 'a'.repeat(40),
    generation: 1,
    subdomain: 'pr-501',
    previewUrl: 'https://pr-501.preview.localhost',
    status: 'BUILDING',
    containerId: null,
    imageTag: 'reapd-pr-501:g1-aaaaaaa',
    buildDurationMs: null,
    failureReason: null,
    logArchiveKey: null,
    expiresAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-11T12:00:00.000Z',
    createdAt: '2026-11-11T12:00:00.000Z',
    events: [
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
        deploymentId: DEPLOY_ID_1,
        fromStatus: null,
        toStatus: 'QUEUED',
        reason: null,
        createdAt: '2026-11-11T12:00:00.000Z',
      },
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
        deploymentId: DEPLOY_ID_1,
        fromStatus: 'QUEUED',
        toStatus: 'BUILDING',
        reason: null,
        createdAt: '2026-11-11T12:00:01.000Z',
      },
    ],
    ...overrides,
  };
}

function createFakeSseRedis(opts: {
  entries: RawStreamTuple[];
  firstRetainedId?: string;
  keyExists?: boolean;
}): {
  client: SseRedisClient;
  getDisconnectCount: () => number;
} {
  let disconnectCount = 0;
  const keyExists = opts.keyExists ?? opts.entries.length > 0;
  const firstId = opts.firstRetainedId ?? opts.entries[0]?.[0] ?? null;

  const client: SseRedisClient = {
    async call(command: string, ...args: Array<string | number>): Promise<unknown> {
      const cmd = command.toUpperCase();
      if (cmd === 'EXISTS') {
        return keyExists ? 1 : 0;
      }
      if (cmd === 'XINFO') {
        if (!keyExists) {
          throw new Error('ERR no such key');
        }
        return [
          'length',
          opts.entries.length,
          'first-entry',
          firstId ? [firstId, ['source', 'system', 'stream', 'stdout', 'ts', '1000', 'text', 'first']] : null,
        ];
      }
      if (cmd === 'XREAD') {
        // Args: COUNT <n> [BLOCK <ms>] STREAMS <key> <cursor>
        const streamsIdx = args.findIndex((a) => String(a).toUpperCase() === 'STREAMS');
        const streamKey = String(args[streamsIdx + 1] ?? '');
        const cursor = String(args[streamsIdx + 2] ?? '0-0');
        const countIdx = args.findIndex((a) => String(a).toUpperCase() === 'COUNT');
        const count = countIdx >= 0 ? Number(args[countIdx + 1]) : 200;

        const matching = opts.entries
          .filter(([id]) => compareStreamIds(id, cursor) > 0)
          .slice(0, count);
        if (matching.length === 0) {
          return null;
        }
        return [[streamKey, matching]];
      }
      throw new Error(`Unexpected Redis command in fake: ${cmd}`);
    },
    disconnect() {
      disconnectCount += 1;
    },
  };

  return {
    client,
    getDisconnectCount: () => disconnectCount,
  };
}

test('compareStreamIds, parseRawStreamEntry, and extractFirstEntryIdFromXinfo handle stream IDs and fields accurately', () => {
  assert.equal(compareStreamIds('0-0', '1700000000000-0'), -1);
  assert.equal(compareStreamIds('1700000000000-2', '1700000000000-10'), -1);
  assert.equal(compareStreamIds('1700000000000-10', '1700000000000-10'), 0);
  assert.equal(compareStreamIds('1700000000001-0', '1700000000000-99'), 1);

  const parsed = parseRawStreamEntry('1700-0', [
    'source',
    'build',
    'stream',
    'stderr',
    'ts',
    '1700000001234',
    'text',
    '#1 [internal] load build definition',
  ]);
  assert.deepEqual(parsed, {
    id: '1700-0',
    source: 'build',
    stream: 'stderr',
    ts: 1700000001234,
    text: '#1 [internal] load build definition',
  });

  const firstId = extractFirstEntryIdFromXinfo([
    'length',
    2000,
    'first-entry',
    ['1700000000500-0', ['source', 'build', 'text', 'trimmed head']],
  ]);
  assert.equal(firstId, '1700000000500-0');
  assert.equal(extractFirstEntryIdFromXinfo(['length', 0, 'first-entry', null]), null);
});

test('GET /api/deployments and GET /api/deployments/:id validate params, clamp limit, and return structured payloads', async () => {
  let capturedFilter: Record<string, unknown> | undefined;
  const summary: DeploymentSummaryItem = makeDeploymentDetail({ status: 'LIVE' });
  const detail = makeDeploymentDetail({ status: 'LIVE' });

  const app = await buildApp({
    logger: false,
    deploymentRoutesDeps: {
      listRecentDeployments: async (filter) => {
        capturedFilter = filter as Record<string, unknown>;
        return [summary];
      },
      getDeploymentByIdWithEvents: async (id) => (id === DEPLOY_ID_1 ? detail : null),
    },
  });

  // Valid list query with limit clamped at 100
  const listRes = await app.inject({
    method: 'GET',
    url: '/api/deployments?repo=Sandesh282/reapd&pr=501&limit=500',
    headers: { origin: 'http://localhost:3000' },
  });
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.headers['access-control-allow-origin'], 'http://localhost:3000');
  assert.deepEqual(capturedFilter, { repo: 'Sandesh282/reapd', prNumber: 501, limit: 100 });
  const listBody = listRes.json() as { deployments: DeploymentSummaryItem[] };
  assert.equal(listBody.deployments.length, 1);
  assert.equal(listBody.deployments[0]?.id, DEPLOY_ID_1);

  // Invalid `pr` query returns 400
  const badPrRes = await app.inject({
    method: 'GET',
    url: '/api/deployments?pr=not-a-number',
  });
  assert.equal(badPrRes.statusCode, 400);

  // Invalid `limit` query returns 400
  const badLimitRes = await app.inject({
    method: 'GET',
    url: '/api/deployments?limit=0',
  });
  assert.equal(badLimitRes.statusCode, 400);

  // Valid detail lookup
  const detailRes = await app.inject({
    method: 'GET',
    url: `/api/deployments/${DEPLOY_ID_1}`,
  });
  assert.equal(detailRes.statusCode, 200);
  const detailBody = detailRes.json() as { deployment: DeploymentDetailWithEvents };
  assert.equal(detailBody.deployment.id, DEPLOY_ID_1);
  assert.equal(detailBody.deployment.events.length, 2);

  // Non-UUID `:id` returns 400
  const badUuidRes = await app.inject({
    method: 'GET',
    url: '/api/deployments/not-a-uuid',
  });
  assert.equal(badUuidRes.statusCode, 400);

  // Unknown UUID returns 404
  const notFoundRes = await app.inject({
    method: 'GET',
    url: `/api/deployments/${DEPLOY_ID_2}`,
  });
  assert.equal(notFoundRes.statusCode, 404);

  await app.close();
});

test('GET /api/deployments/:id/logs streams JSON-encoded entries, ignores forged build end:LIVE, emits event: gap on trimmed resume, and calls disconnect()', async () => {
  const entries: RawStreamTuple[] = [
    ['1000-0', ['source', 'system', 'stream', 'stdout', 'ts', '1000', 'text', '[reapd] -> BUILDING']],
    // Forged `end:LIVE` from `build` source must be streamed as normal data, NOT treated as end marker
    ['1000-1', ['source', 'build', 'stream', 'stdout', 'ts', '1001', 'text', 'end:LIVE']],
    ['1000-2', ['source', 'build', 'stream', 'stderr', 'ts', '1002', 'text', 'Step 1/2 : FROM node:22-alpine']],
    // Authoritative system end marker
    ['1000-3', ['source', 'system', 'stream', 'stdout', 'ts', '1003', 'text', 'end:LIVE']],
  ];

  const fakeRedis = createFakeSseRedis({
    entries,
    firstRetainedId: '1000-0',
  });

  const app = await buildApp({
    logger: false,
    dashboardOrigins: ['http://localhost:3000'],
    deploymentRoutesDeps: {
      getDeploymentByIdWithEvents: async (id) =>
        id === DEPLOY_ID_1 ? makeDeploymentDetail({ status: 'BUILDING' }) : null,
      createSseRedis: () => fakeRedis.client,
    },
  });

  // 1. Invalid Last-Event-ID is rejected with 400
  const badCursorRes = await app.inject({
    method: 'GET',
    url: `/api/deployments/${DEPLOY_ID_1}/logs`,
    headers: { 'last-event-id': 'invalid-cursor' },
  });
  assert.equal(badCursorRes.statusCode, 400);

  // 2. Full replay from 0-0 streams 3 entries (including the forged `build` "end:LIVE") + `event: end`
  const fullRes = await app.inject({
    method: 'GET',
    url: `/api/deployments/${DEPLOY_ID_1}/logs`,
    headers: { origin: 'http://localhost:3000' },
  });
  assert.equal(fullRes.statusCode, 200);
  assert.equal(fullRes.headers['access-control-allow-origin'], 'http://localhost:3000');
  assert.match(String(fullRes.headers['content-type']), /text\/event-stream/);

  const blocks = fullRes.body.trim().split('\n\n');
  assert.equal(blocks.length, 4, 'expected 3 log entry frames + 1 event: end frame');
  assert.ok(blocks[0]?.includes('id: 1000-0'));
  assert.ok(blocks[1]?.includes('id: 1000-1'));
  assert.ok(blocks[1]?.includes('"source":"build"'));
  assert.ok(blocks[1]?.includes('"text":"end:LIVE"'));
  assert.ok(blocks[2]?.includes('id: 1000-2'));
  assert.equal(blocks[3], 'event: end\ndata: {"status":"LIVE"}');
  assert.equal(fakeRedis.getDisconnectCount(), 1, 'SSE must call disconnect() on completion');

  // 3. Resume with Last-Event-ID older than firstRetainedId ('500-0' < '1000-0') emits `event: gap` first
  const gapRes = await app.inject({
    method: 'GET',
    url: `/api/deployments/${DEPLOY_ID_1}/logs`,
    headers: { 'last-event-id': '500-0' },
  });
  assert.equal(gapRes.statusCode, 200);
  const gapBlocks = gapRes.body.trim().split('\n\n');
  assert.ok(gapBlocks[0]?.startsWith('event: gap\ndata: '), 'expected event: gap frame first when cursor < first-entry');
  assert.equal(gapBlocks.length, 5, 'expected 1 gap frame + 3 log frames + 1 end frame');

  // 4. Resume from '1000-1' skips 1000-0 and 1000-1, delivering only 1000-2 + event: end
  const resumeRes = await app.inject({
    method: 'GET',
    url: `/api/deployments/${DEPLOY_ID_1}/logs`,
    headers: { 'last-event-id': '1000-1' },
  });
  const resumeBlocks = resumeRes.body.trim().split('\n\n');
  assert.equal(resumeBlocks.length, 2, 'expected only 1000-2 + event: end after resuming from 1000-1');
  assert.ok(resumeBlocks[0]?.includes('id: 1000-2'));
  assert.equal(resumeBlocks[1], 'event: end\ndata: {"status":"LIVE"}');

  await app.close();
});

test('GET /api/deployments/:id/logs falls back to DB terminal status when worker was SIGKILLed (no end marker) and enforces concurrent SSE cap', async () => {
  // Stream has 1 entry and NO `end:<STATUS>` marker, while DB is already `FAILED`
  const crashedStreamRedis = createFakeSseRedis({
    entries: [
      ['2000-0', ['source', 'system', 'stream', 'stdout', 'ts', '2000', 'text', '[reapd] -> BUILDING']],
    ],
  });

  const app = await buildApp({
    logger: false,
    deploymentRoutesDeps: {
      getDeploymentByIdWithEvents: async () => makeDeploymentDetail({ status: 'FAILED' }),
      createSseRedis: () => crashedStreamRedis.client,
      maxConcurrentSseClients: 0, // test 429 cap first
    },
  });

  const cappedRes = await app.inject({
    method: 'GET',
    url: `/api/deployments/${DEPLOY_ID_1}/logs`,
  });
  assert.equal(cappedRes.statusCode, 429);
  await app.close();

  const fallbackApp = await buildApp({
    logger: false,
    deploymentRoutesDeps: {
      getDeploymentByIdWithEvents: async () => makeDeploymentDetail({ status: 'FAILED' }),
      createSseRedis: () => crashedStreamRedis.client,
      xreadBlockMs: 10,
      xreadFallbackGraceMs: 10,
    },
  });

  const fallbackRes = await fallbackApp.inject({
    method: 'GET',
    url: `/api/deployments/${DEPLOY_ID_1}/logs`,
  });
  assert.equal(fallbackRes.statusCode, 200);
  const frames = fallbackRes.body.trim().split('\n\n');
  assert.equal(frames.length, 2, 'expected 1 buffered entry + 1 DB-fallback event: end frame');
  assert.ok(frames[0]?.includes('id: 2000-0'));
  assert.equal(frames[1], 'event: end\ndata: {"status":"FAILED"}');

  // Verify grace-period recovery: when DB is already SUPERSEDED at timeout, if the worker flushes
  // its tail + `end:SUPERSEDED` during the post-DB-read grace `XREAD BLOCK`, the client receives
  // the late tail line rather than losing it to an immediate fallback close.
  let xreadCallNum = 0;
  let disconnectCalls = 0;
  const racingSuperseedingRedis: SseRedisClient = {
    async call(cmd: string) {
      if (cmd.toUpperCase() === 'XREAD') {
        xreadCallNum += 1;
        if (xreadCallNum === 1) {
          // Initial XREAD returns the first line
          return [['k', [['3000-0', ['source', 'system', 'stream', 'stdout', 'ts', '3000', 'text', '[reapd] -> BUILDING']]]]];
        }
        if (xreadCallNum === 2) {
          // Second XREAD times out right as webhook commits SUPERSEDED in Postgres
          return null;
        }
        if (xreadCallNum === 3) {
          // Third XREAD is the post-DB-check grace BLOCK: worker flushes its abort line + end:SUPERSEDED
          return [
            [
              'k',
              [
                ['3000-1', ['source', 'system', 'stream', 'stderr', 'ts', '3001', 'text', '[reapd] Aborted via cancel signal -> SUPERSEDED']],
                ['3000-2', ['source', 'system', 'stream', 'stdout', 'ts', '3002', 'text', 'end:SUPERSEDED']],
              ],
            ],
          ];
        }
        return null;
      }
      return 1;
    },
    disconnect() {
      disconnectCalls += 1;
    },
  };

  const graceApp = await buildApp({
    logger: false,
    deploymentRoutesDeps: {
      getDeploymentByIdWithEvents: async () => makeDeploymentDetail({ status: 'SUPERSEDED' }),
      createSseRedis: () => racingSuperseedingRedis,
      xreadBlockMs: 10,
      xreadFallbackGraceMs: 25,
    },
  });
  const graceRes = await graceApp.inject({
    method: 'GET',
    url: `/api/deployments/${DEPLOY_ID_1}/logs`,
  });
  assert.equal(graceRes.statusCode, 200);
  const graceFrames = graceRes.body.trim().split('\n\n');
  assert.equal(graceFrames.length, 3, 'grace XREAD BLOCK must capture late abort line before closing');
  assert.ok(graceFrames[1]?.includes('Aborted via cancel signal -> SUPERSEDED'));
  assert.equal(graceFrames[2], 'event: end\ndata: {"status":"SUPERSEDED"}');
  assert.equal(disconnectCalls, 1);

  // Also verify expired stream fast-path (`keyExists: false` on a completed deployment)
  const expiredStreamRedis = createFakeSseRedis({
    entries: [],
    keyExists: false,
  });
  const expiredApp = await buildApp({
    logger: false,
    deploymentRoutesDeps: {
      getDeploymentByIdWithEvents: async () => makeDeploymentDetail({ status: 'EXPIRED' }),
      createSseRedis: () => expiredStreamRedis.client,
    },
  });
  const expiredRes = await expiredApp.inject({
    method: 'GET',
    url: `/api/deployments/${DEPLOY_ID_1}/logs`,
  });
  assert.equal(expiredRes.statusCode, 200);
  assert.equal(expiredRes.body.trim(), 'event: end\ndata: {"status":"LIVE","expired":true}');

  await fallbackApp.close();
  await graceApp.close();
  await expiredApp.close();
});

