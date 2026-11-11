// apps/worker/src/logs/log-sink.test.ts
// Unit tests for `createLogSink`, `redactSecrets`, `sanitizeAndTruncateLine`, and `parseBuildLogEndMarker`.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
  type PipelineExecResult,
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

function createFakeRedis(opts?: {
  failExecCount?: number;
  tupleErrorCount?: number;
  delayMs?: number;
  initialStatus?: 'ready' | 'connecting';
  readyAfterMs?: number;
}): {
  client: LogRedisClient;
  xadds: RecordedXadd[];
  expires: RecordedExpire[];
  execCalls: number;
} {
  const xadds: RecordedXadd[] = [];
  const expires: RecordedExpire[] = [];
  let remainingRejections = opts?.failExecCount ?? 0;
  let remainingTupleErrors = opts?.tupleErrorCount ?? 0;
  const state = {
    execCalls: 0,
    status: opts?.initialStatus ?? 'ready',
  };
  const emitter = new EventEmitter();

  if (state.status === 'connecting' && opts?.readyAfterMs !== undefined) {
    setTimeout(() => {
      state.status = 'ready';
      emitter.emit('ready');
    }, opts.readyAfterMs);
  }

  const client: LogRedisClient = {
    get status() {
      return state.status;
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      emitter.once(event, listener);
      return client;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      emitter.off(event, listener);
      return client;
    },
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
        async exec(): Promise<PipelineExecResult> {
          state.execCalls += 1;
          if (opts?.delayMs) {
            await new Promise((r) => setTimeout(r, opts.delayMs));
          }
          if (remainingRejections > 0) {
            remainingRejections -= 1;
            throw new Error('simulated Redis socket rejection');
          }
          if (remainingTupleErrors > 0) {
            remainingTupleErrors -= 1;
            return [[new Error("OOM command not allowed when used memory > 'maxmemory'"), null]];
          }
          xadds.push(...stagedXadds);
          expires.push(...stagedExpires);
          return stagedXadds.map((_, idx) => [null, `1000-${idx}`]);
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

test('parseBuildLogEndMarker requires source === "system" and rejects forged git/build lines', () => {
  assert.equal(
    parseBuildLogEndMarker({ source: 'system', text: 'end:LIVE' }),
    'LIVE',
  );
  assert.equal(
    parseBuildLogEndMarker({ source: 'system', text: 'end:FAILED' }),
    'FAILED',
  );
  assert.equal(
    parseBuildLogEndMarker({ source: 'system', text: 'end:SUPERSEDED' }),
    'SUPERSEDED',
  );
  // Repo-controlled git/build output with literal `end:LIVE` must NEVER be treated as an end marker
  assert.equal(
    parseBuildLogEndMarker({ source: 'build', text: 'end:LIVE' }),
    null,
  );
  assert.equal(
    parseBuildLogEndMarker({ source: 'git', text: 'end:FAILED' }),
    null,
  );
  assert.equal(
    parseBuildLogEndMarker({ source: 'system', text: 'end:EXPIRED' }),
    null,
  );
});

test('createLogSink waits for Redis ready before first flush so early lines are never lost, refreshes 6h safety TTL, writes end marker with 24h TTL, and seals after end()', async () => {
  const deploymentId = '00000000-0000-0000-0000-000000000501';
  // Simulate ioredis socket still connecting when the first write() fires
  const fake = createFakeRedis({ initialStatus: 'connecting', readyAfterMs: 25 });
  const sink = createLogSink({
    deploymentId,
    redis: fake.client,
  });

  sink.write('system', 'stdout', '[reapd] Deployment -> BUILDING', 999);
  sink.write('git', 'stdout', 'Cloning repository...', 1000);
  sink.write('build', 'stderr', '#1 [internal] load build definition', 1001);
  await sink.flush();

  const expectedKey = logBuildStreamKey(deploymentId);
  assert.equal(fake.xadds.length, 3, 'all 3 initial lines (including -> BUILDING) must be preserved while connecting');
  assert.equal(fake.xadds[0]?.text, '[reapd] Deployment -> BUILDING');
  assert.equal(fake.xadds[0]?.maxLen, String(LOG_STREAM_MAXLEN));
  assert.equal(fake.expires.length, 1);
  assert.deepEqual(fake.expires[0], { key: expectedKey, seconds: LOG_SAFETY_TTL_SECONDS });

  await sink.end('LIVE');

  assert.equal(fake.xadds.length, 4);
  const endEntry = fake.xadds[3];
  assert.ok(endEntry);
  assert.equal(endEntry.source, 'system');
  assert.equal(endEntry.text, formatBuildLogEndMarker('LIVE'));
  assert.equal(parseBuildLogEndMarker({ source: endEntry.source, text: endEntry.text }), 'LIVE');

  assert.equal(fake.expires.length, 2);
  assert.deepEqual(fake.expires[1], { key: expectedKey, seconds: LOG_FINAL_TTL_SECONDS });

  // Writes and duplicate end() calls after seal must be ignored
  sink.write('build', 'stdout', 'late line after end');
  await sink.flush();
  await sink.end('FAILED');
  assert.equal(fake.xadds.length, 4);
});

test('createLogSink handles a 1,500-line synchronous stdout burst with zero drops against a healthy fake', async () => {
  const deploymentId = '00000000-0000-0000-0000-000000000503';
  const fake = createFakeRedis();
  const sink = createLogSink({
    deploymentId,
    redis: fake.client,
  });

  for (let i = 1; i <= 1500; i++) {
    sink.write('build', 'stderr', `burst-line-${i}`, 3000 + i);
  }
  await sink.flush();

  assert.equal(fake.xadds.length, 1500, 'all 1,500 synchronous burst lines must be flushed without drops');
  assert.ok(
    !fake.xadds.some((x) => x.text.includes('dropped due to backpressure')),
    'zero drop notices expected for 1,500-line burst',
  );
  assert.equal(fake.xadds[0]?.text, 'burst-line-1');
  assert.equal(fake.xadds[1499]?.text, 'burst-line-1500');
});

test('createLogSink drops oldest lines when maxQueueSize is exceeded and surfaces both rejected and tuple-level pipeline.exec() errors without throwing', async () => {
  const deploymentId = '00000000-0000-0000-0000-000000000502';
  const fake = createFakeRedis({ delayMs: 25 });
  const sink = createLogSink({
    deploymentId,
    redis: fake.client,
    maxQueueSize: 3,
    maxBatchSize: 2,
  });

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

  // Verify tuple-level OOM errors (`[[Error("OOM..."), null]]`) and rejected promises are caught & rate-limited
  const tupleErrorFake = createFakeRedis({ tupleErrorCount: 5, failExecCount: 2 });
  const resilientSink = createLogSink({
    deploymentId,
    redis: tupleErrorFake.client,
    maxBatchSize: 1,
  });
  for (let i = 0; i < 4; i++) {
    resilientSink.write('system', 'stdout', `fail-line-${i}`);
  }
  await assert.doesNotReject(() => resilientSink.flush());
  await assert.doesNotReject(() => resilientSink.end('FAILED'));
});
