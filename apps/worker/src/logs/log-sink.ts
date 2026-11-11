// apps/worker/src/logs/log-sink.ts
// Redis Streams build-log sink (`logs:build:<deploymentId>`).
//
// Design invariants (Phase 5 v2.1):
//   1. Best-effort: Redis log failures are caught and warned (rate-limited) — a log failure
//      NEVER aborts a build.
//   2. Secret redaction BEFORE truncation: strips GitHub installation/PAT tokens (`ghs_...`,
//      `ghp_...`, `github_pat_...`), `Authorization:` headers, and `Basic`/`Bearer` credentials
//      before slicing to `LOG_LINE_MAX_BYTES` (1 KB), so a token split across the boundary
//      cannot leak its prefix.
//   3. Bounded Redis memory (`MAXLEN ~ 2000` x 1 KB, `EXPIRE` refreshed on every flush):
//      Every pipeline flush executes `XADD ... MAXLEN ~ 2000 * ...` AND refreshes the 6h safety
//      TTL (`EXPIRE key 21600`), so a SIGKILL'd worker never leaves an immortal key in our
//      256 MB `noeviction` Redis instance.
//   4. Bounded in-memory queue (`maxQueueSize`, default 5,000 >= `LOG_STREAM_MAXLEN` so a 1,000+
//      line stdout burst never drops lines against a healthy Redis): if Redis is slow or
//      unreachable, oldest queued lines are dropped and a single `[reapd] N log line(s) dropped`
//      notice is inserted when flushing resumes.
//   5. Waits for the Redis client to reach `ready` (with a timeout) before the first `exec()` so
//      early `write()` calls made while the TCP socket is still connecting (`enableOfflineQueue:
//      false`) stay buffered in `queue` instead of failing before connection readiness.
//   6. Inspects `pipeline.exec()`'s per-command `[err, result]` tuples (in addition to promise
//      rejection) so Redis OOM (`noeviction`), `NOAUTH`, or `WRONGTYPE` errors are detected.

import { Redis } from 'ioredis';
import {
  type BuildLogEndStatus,
  formatBuildLogEndMarker,
  LOG_FINAL_TTL_SECONDS,
  LOG_LINE_MAX_BYTES,
  LOG_SAFETY_TTL_SECONDS,
  LOG_STREAM_MAXLEN,
  logBuildStreamKey,
  type LogSource,
  type LogStream,
} from '@reapd/types';

export interface PendingLogLine {
  source: LogSource;
  stream: LogStream;
  ts: number;
  text: string;
}

export type PipelineExecResult = Array<[Error | null, unknown]> | null;

/** Minimal pipeline subset used by `createLogSink` (injectable for deterministic unit tests). */
export interface LogRedisPipeline {
  xadd: (key: string, ...args: Array<string | number>) => unknown;
  expire: (key: string, seconds: number) => unknown;
  exec: () => Promise<PipelineExecResult>;
}

/** Minimal Redis client subset used by `createLogSink`. */
export interface LogRedisClient {
  status?: string;
  once?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  pipeline: () => LogRedisPipeline;
  quit: () => Promise<unknown>;
  disconnect: () => void;
}

export interface CreateLogSinkOptions {
  deploymentId: string;
  /** Optional injected client for unit tests; when omitted, creates a dedicated ioredis client. */
  redis?: LogRedisClient;
  redisUrl?: string;
  maxQueueSize?: number;
  maxBatchSize?: number;
  maxLineBytes?: number;
  streamMaxLen?: number;
  safetyTtlSeconds?: number;
  finalTtlSeconds?: number;
  readyTimeoutMs?: number;
}

export interface LogSink {
  /** Enqueues a log line and triggers an asynchronous background flush. Never throws. */
  write: (source: LogSource, stream: LogStream, text: string, ts?: number) => void;
  /** Waits for all currently queued lines to be flushed to Redis. Never throws. */
  flush: () => Promise<void>;
  /**
   * Flushes any pending lines, appends the authoritative `end:<STATUS>` system marker,
   * sets the final 24h TTL on the stream key, seals the sink against future writes,
   * and closes the dedicated Redis connection (if owned by the sink). Never throws.
   */
  end: (finalStatus: BuildLogEndStatus) => Promise<void>;
}

const DEFAULT_MAX_QUEUE_SIZE = 5000;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_READY_TIMEOUT_MS = 3000;
const WARN_RATE_LIMIT_MS = 5000;
const TRUNCATED_SUFFIX = ' ... [truncated]';

/**
 * Redacts credentials and tokens from raw log text BEFORE length truncation:
 *   - GitHub tokens (`ghs_...`, `ghp_...`, `gho_...`, `ghu_...`, `ghr_...`, `github_pat_...`)
 *   - `Authorization: <scheme> <token>` headers (including `GIT_CONFIG_VALUE_*` extraheaders)
 *   - `Basic <base64>` and `Bearer <token>` credentials
 *   - URL userinfo credentials (`https://user:pass@host`)
 */
export function redactSecrets(input: string): string {
  return input
    .replace(/(gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/(Authorization\s*:\s*)(?:Basic|Bearer|token)\s+[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=_.-]{8,}/gi, '$1 [REDACTED]')
    .replace(/(https?:\/\/[^/\s:@]+:)[^@\s/]+(@)/gi, '$1[REDACTED]$2');
}

/**
 * Redacts secrets first, strips lone `\r` characters so terminal lines stay clean,
 * and caps the UTF-8 byte length to `maxBytes` (default 1024 bytes).
 */
export function sanitizeAndTruncateLine(
  rawText: string,
  maxBytes: number = LOG_LINE_MAX_BYTES,
): string {
  const redacted = redactSecrets(rawText).replace(/\r/g, '');
  if (Buffer.byteLength(redacted, 'utf8') <= maxBytes) {
    return redacted;
  }

  const budget = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATED_SUFFIX, 'utf8'));
  // Slice by buffer and decode cleanly without splitting multi-byte UTF-8 code points at the tail
  const buf = Buffer.from(redacted, 'utf8').subarray(0, budget);
  let prefix = buf.toString('utf8');
  if (prefix.endsWith('\uFFFD')) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}${TRUNCATED_SUFFIX}`;
}

/**
 * Inspects an ioredis `pipeline.exec()` result tuple array and throws the first per-command
 * `Error` if any command in the pipeline failed (e.g., `OOM command not allowed when used memory > 'maxmemory'`,
 * `NOAUTH`, `WRONGTYPE`).
 */
function assertPipelineExecSucceeded(res: PipelineExecResult): void {
  if (!Array.isArray(res)) return;
  for (const tuple of res) {
    if (Array.isArray(tuple) && tuple[0] instanceof Error) {
      throw tuple[0];
    }
  }
}

/**
 * Waits until an ioredis client reaches `status === 'ready'` (or resolves immediately for
 * injected unit-test clients that do not expose `.status`). Because the sink uses
 * `enableOfflineQueue: false`, sending `pipeline.exec()` before the TCP + AUTH handshake
 * finishes would otherwise reject and drop the very first build log lines.
 */
async function waitForRedisReady(client: LogRedisClient, timeoutMs: number): Promise<void> {
  if (!client.status || client.status === 'ready' || !client.once) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Redis log sink connection timed out after ${timeoutMs}ms (status=${client.status})`));
    }, timeoutMs);

    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown): void => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      client.off?.('ready', onReady);
      client.off?.('error', onError);
    };

    client.once?.('ready', onReady);
    client.once?.('error', onError);
  });
}

export function createLogSink(opts: CreateLogSinkOptions): LogSink {
  const {
    deploymentId,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
    maxBatchSize = DEFAULT_MAX_BATCH_SIZE,
    maxLineBytes = LOG_LINE_MAX_BYTES,
    streamMaxLen = LOG_STREAM_MAXLEN,
    safetyTtlSeconds = LOG_SAFETY_TTL_SECONDS,
    finalTtlSeconds = LOG_FINAL_TTL_SECONDS,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  } = opts;

  const streamKey = logBuildStreamKey(deploymentId);
  const ownsRedis = !opts.redis;

  let redis: LogRedisClient;
  if (opts.redis) {
    redis = opts.redis;
  } else {
    const resolvedUrl = opts.redisUrl ?? process.env['REDIS_URL'];
    if (!resolvedUrl) {
      throw new Error('createLogSink requires `redisUrl` or `REDIS_URL` environment variable');
    }
    const ioredis = new Redis(resolvedUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 3000,
      lazyConnect: false,
    });
    // Attach a no-op error listener so transient connection errors never crash the process as unhandled
    ioredis.on('error', () => {});
    redis = ioredis;
  }

  const queue: PendingLogLine[] = [];
  let droppedCount = 0;
  let sealed = false;
  let activeDrain: Promise<void> | null = null;
  let microtaskScheduled = false;
  let lastWarnAt = 0;
  let suppressedWarnings = 0;

  function warnRateLimited(context: string, err: unknown): void {
    const now = Date.now();
    const msg = err instanceof Error ? err.message : String(err);
    if (now - lastWarnAt >= WARN_RATE_LIMIT_MS) {
      const suffix = suppressedWarnings > 0 ? ` (+${suppressedWarnings} similar warning(s) suppressed)` : '';
      console.warn(`⚠️  [log-sink] ${context} for ${deploymentId}: ${msg}${suffix}`);
      lastWarnAt = now;
      suppressedWarnings = 0;
    } else {
      suppressedWarnings += 1;
    }
  }

  async function drainLoop(): Promise<void> {
    try {
      while (queue.length > 0 || droppedCount > 0) {
        try {
          await waitForRedisReady(redis, readyTimeoutMs);
        } catch (err) {
          // Discard the current backlog so we don't spin infinitely when Redis is down on boot
          const lost = queue.length + droppedCount;
          queue.length = 0;
          droppedCount = 0;
          warnRateLimited(`Redis not ready (dropped ${lost} line(s))`, err);
          break;
        }

        const batch: PendingLogLine[] = [];

        if (droppedCount > 0) {
          const dropped = droppedCount;
          droppedCount = 0;
          batch.push({
            source: 'system',
            stream: 'stderr',
            ts: Date.now(),
            text: `[reapd] ${dropped} log line(s) dropped due to backpressure`,
          });
        }

        while (queue.length > 0 && batch.length < maxBatchSize) {
          const next = queue.shift();
          if (next) batch.push(next);
        }

        if (batch.length === 0) break;

        try {
          const pipe = redis.pipeline();
          for (const item of batch) {
            pipe.xadd(
              streamKey,
              'MAXLEN',
              '~',
              String(streamMaxLen),
              '*',
              'source',
              item.source,
              'stream',
              item.stream,
              'ts',
              String(item.ts),
              'text',
              item.text,
            );
          }
          pipe.expire(streamKey, safetyTtlSeconds);
          const execResult = await pipe.exec();
          assertPipelineExecSucceeded(execResult);
        } catch (err) {
          warnRateLimited(`Failed to flush ${batch.length} log line(s)`, err);
        }
      }
    } finally {
      // Clear `activeDrain` synchronously in the same tick as the loop exit check so a `write()`
      // arriving immediately after the while condition sees `activeDrain === null` and schedules.
      activeDrain = null;
      if ((queue.length > 0 || droppedCount > 0) && !microtaskScheduled) {
        microtaskScheduled = true;
        void scheduleDrain();
      }
    }
  }

  function scheduleDrain(): Promise<void> {
    if (!activeDrain) {
      activeDrain = Promise.resolve().then(() => {
        microtaskScheduled = false;
        return drainLoop();
      });
    }
    return activeDrain;
  }

  function write(
    source: LogSource,
    stream: LogStream,
    rawText: string,
    ts: number = Date.now(),
  ): void {
    if (sealed) return;

    const text = sanitizeAndTruncateLine(rawText, maxLineBytes);
    if (text.length === 0) return;

    if (queue.length >= maxQueueSize) {
      queue.shift();
      droppedCount += 1;
    }

    queue.push({ source, stream, ts, text });
    if (!microtaskScheduled && !activeDrain) {
      microtaskScheduled = true;
      void scheduleDrain();
    }
  }

  async function flush(): Promise<void> {
    while (activeDrain || queue.length > 0 || droppedCount > 0) {
      await (activeDrain ?? scheduleDrain());
    }
  }

  async function end(finalStatus: BuildLogEndStatus): Promise<void> {
    if (sealed) return;
    sealed = true;

    try {
      await flush();
      await waitForRedisReady(redis, readyTimeoutMs);

      const endText = formatBuildLogEndMarker(finalStatus);
      const pipe = redis.pipeline();
      pipe.xadd(
        streamKey,
        'MAXLEN',
        '~',
        String(streamMaxLen),
        '*',
        'source',
        'system',
        'stream',
        'stdout',
        'ts',
        String(Date.now()),
        'text',
        endText,
      );
      pipe.expire(streamKey, finalTtlSeconds);
      const execResult = await pipe.exec();
      assertPipelineExecSucceeded(execResult);
    } catch (err) {
      warnRateLimited(`Failed to write end marker (${finalStatus})`, err);
    } finally {
      if (ownsRedis) {
        await redis.quit().catch(() => {
          redis.disconnect();
        });
      }
    }
  }

  return { write, flush, end };
}
