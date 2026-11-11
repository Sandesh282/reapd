// apps/worker/src/logs/log-sink.test.ts
// Unit tests for `createLogSink`, `redactSecrets`, and `sanitizeAndTruncateLine`.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatBuildLogEndMarker,
  LOG_FINAL_TTL_SECONDS,
  LOG_SAFETY_TTL_SECONDS,
  LOG_STREAM_MAXLEN,
  logBuildStreamKey,
  parseBuildLogEndMarker,
} from '@reapd/types';
import {
  createLogSink,
  type LogRedisClient,
  type LogRedisPipeline,
  redactSecrets,
  sanitizeAndTruncateLine,
} from './log-sink.js';

interface RecordedXadd {
  key: string;
  maxLen: string;
  source: string;
  stream: string;
  ts: string;
  text: string;
}

interface RecordedExpire {
  key: string;
  seconds: number;
}

function createFakeRedis(opts?: { failExecCount?: number; delayMs?: number }): {
  client: LogRedisClient;
  xadds: RecordedXadd[];
  expires: RecordedExpire[];
  execCalls: number;
} {
  const xadds: RecordedXadd[] = [];
  const expires: RecordedExpire[] = [];
  let remainingFailures = opts?.failExecCount ?? 0;
  const state = { execCalls: 0 };

  const client: LogRedisClient = {
    pipeline(): LogRedisPipeline {
      const stagedXadds: RecordedXadd[] = [];
      const stagedExpires: RecordedExpire[] = [];
      return {
        xadd(key: string, ...args: Array<string | number>) {
          // Expected call: xadd(key, 'MAXLEN', '~', maxLen, '*', 'source', s, 'stream', st, 'ts', ts, 'text', text)
          stagedXadds.push({
            key,
            maxLen: String(args[2]),
            source: String(args[5]),
            stream: String(args[7]),
            ts: String(args[9]),
            text: String(args[11]),
          });
        },
        expire(key: string, seconds: number) {
          stagedExpires.push({ key, seconds });
        },
        async exec() {
          state.execCalls += 1;
          if (opts?.delayMs) {
            await new Promise((r) => setTimeout(r, opts.delayMs));
          }
          if (remainingFailures > 0) {
            remainingFailures -= 1;
            throw new Error('simulated Redis OOM / timeout');
          }
          xadds.push(...stagedXadds);
          expires.push(...stagedExpires);
          return [];
        },
      };
    },
    async quit() {
      return 'OK';
    },
    disconnect() {
      // no-op
    },
  };

  return {
    client,
    xadds,
    expires,
    get execCalls() {
      return state.execCalls;
    },
  };
}

test('redactSecrets strips GitHub tokens, Authorization headers, Basic/Bearer credentials, and URL passwords before truncation', () => {
  const ghsToken = `ghs_${'a1B2c3D4e5'.repeat(4)}`;
  const patToken = `github_pat_${'Z9y8X7w6'.repeat(4)}`;
  const raw = [
    `token=${ghsToken}`,
    `pat=${patToken}`,
    'GIT_CONFIG_VALUE_1=Authorization: Basic dXNlcjpzZWNyZXRfcGFzc3dvcmQ=',
    'Header: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.secret',
    'Cloning https://x-access-token:ghs_supersecret@github.com/Sandesh282/reapd.git',
  ].join(' | ');

  const redacted = redactSecrets(raw);
  assert.ok(!redacted.includes(ghsToken), 'ghs_ token must be redacted');
  assert.ok(!redacted.includes(patToken), 'github_pat_ token must be redacted');
  assert.ok(!redacted.includes('dXNlcjpzZWNyZXRfcGFzc3dvcmQ='), 'Basic base64 payload must be redacted');
  assert.ok(!redacted.includes('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9'), 'Bearer token must be redacted');
  assert.ok(!redacted.includes('ghs_supersecret'), 'URL password must be redacted');

  // Redaction happens BEFORE truncation so a token spanning the maxBytes boundary cannot leak its prefix
  const prefixPadding = 'x '.repeat(35);
  const boundaryInput = `${prefixPadding}${ghsToken} ${'y'.repeat(40)}`;
  const truncated = sanitizeAndTruncateLine(boundaryInput, 100);
  assert.ok(!truncated.includes('ghs_'), 'token crossing truncation boundary must be redacted prior to slice');
  assert.ok(Buffer.byteLength(truncated, 'utf8') <= 100, 'truncated line must respect byte cap');
  assert.ok(truncated.endsWith(' ... [truncated]'), 'truncated line must end with marker');
});

test('createLogSink batches XADDs in order, refreshes 6h safety TTL on every flush, writes end marker with 24h TTL, and ignores writes after end()', async () => {
  const deploymentId = '00000000-0000-0000-0000-000000000501';
  const fake = createFakeRedis();
  const sink = createLogSink({
    deploymentId,
    redis: fake.client,
  });

  sink.write('git', 'stdout', 'Cloning repository...', 1000);
  sink.write('build', 'stderr', '#1 [internal] load build definition', 1001);
  await sink.flush();

  const expectedKey = logBuildStreamKey(deploymentId);
  assert.equal(fake.xadds.length, 2);
  assert.deepEqual(
    fake.xadds.map((x) => ({
      key: x.key,
      maxLen: x.maxLen,
      source: x.source,
      stream: x.stream,
      ts: x.ts,
      text: x.text,
    })),
    [
      {
        key: expectedKey,
        maxLen: String(LOG_STREAM_MAXLEN),
        source: 'git',
        stream: 'stdout',
        ts: '1000',
        text: 'Cloning repository...',
      },
      {
        key: expectedKey,
        maxLen: String(LOG_STREAM_MAXLEN),
        source: 'build',
        stream: 'stderr',
        ts: '1001',
        text: '#1 [internal] load build definition',
      },
    ],
  );
  assert.equal(fake.expires.length, 1);
  assert.deepEqual(fake.expires[0], { key: expectedKey, seconds: LOG_SAFETY_TTL_SECONDS });

  // End the stream with LIVE
  await sink.end('LIVE');

  assert.equal(fake.xadds.length, 3);
  const endEntry = fake.xadds[2];
  assert.ok(endEntry);
  assert.equal(endEntry.source, 'system');
  assert.equal(endEntry.text, formatBuildLogEndMarker('LIVE'));
  assert.equal(parseBuildLogEndMarker(endEntry.text), 'LIVE');

  assert.equal(fake.expires.length, 2);
  assert.deepEqual(fake.expires[1], { key: expectedKey, seconds: LOG_FINAL_TTL_SECONDS });

  // Writes and duplicate end() calls after seal must be ignored (cannot resurrect key without TTL)
  sink.write('build', 'stdout', 'late line after end');
  await sink.flush();
  await sink.end('FAILED');
  assert.equal(fake.xadds.length, 3);
});

test('createLogSink drops oldest lines under backpressure and emits a dropped-lines system notice, and swallows Redis errors without throwing', async () => {
  const deploymentId = '00000000-0000-0000-0000-000000000502';
  const fake = createFakeRedis({ delayMs: 25 });
  const sink = createLogSink({
    deploymentId,
    redis: fake.client,
    maxQueueSize: 3,
    maxBatchSize: 2,
  });

  // First write starts an async drain (batches up to 2 items) while we enqueue 5 more into a maxQueueSize=3 buffer
  for (let i = 1; i <= 6; i++) {
    sink.write('build', 'stderr', `line-${i}`, 2000 + i);
  }
  await sink.flush();

  const texts = fake.xadds.map((x) => x.text);
  assert.ok(
    texts.some((t) => t.includes('log line(s) dropped due to backpressure')),
    'expected backpressure drop notice in stream',
  );
  assert.equal(texts.at(-1), 'line-6', 'newest lines must be preserved when oldest are dropped');

  // Verify Redis pipeline failures are swallowed (never reject flush or end)
  const failingFake = createFakeRedis({ failExecCount: 10 });
  const resilientSink = createLogSink({
    deploymentId,
    redis: failingFake.client,
  });
  resilientSink.write('system', 'stdout', 'should not throw on Redis failure');
  await assert.doesNotReject(() => resilientSink.flush());
  await assert.doesNotReject(() => resilientSink.end('FAILED'));
});
