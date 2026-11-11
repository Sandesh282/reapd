// apps/worker/src/logs/log-sink.ts
// Redis Streams build-log sink (`logs:build:<deploymentId>`).
//
// Design invariants (Phase 5 v2.1):
//   1. Best-effort: Redis log failures are caught and warned — a log failure NEVER aborts a build.
//   2. Secret redaction BEFORE truncation: strips GitHub installation/PAT tokens (`ghs_...`,
//      `ghp_...`, `github_pat_...`), `Authorization:` headers, and `Basic`/`Bearer` credentials
//      before slicing to `LOG_LINE_MAX_BYTES` (1 KB), so a token split across the boundary
//      cannot leak its prefix.
//   3. Bounded Redis memory (`MAXLEN ~ 2000` x 1 KB, `EXPIRE` refreshed on every flush):
//      Every pipeline flush executes `XADD ... MAXLEN ~ 2000 * ...` AND refreshes the 6h safety
//      TTL (`EXPIRE key 21600`), so a SIGKILL'd worker never leaves an immortal key in our
//      256 MB `noeviction` Redis instance.
//   4. Bounded in-memory queue (`maxQueueSize`, default 500): if Redis is slow or temporarily
//      unreachable, oldest queued lines are dropped and a single `[system] ... N log lines dropped`
//      notice is inserted when flushing resumes.
//   5. Deterministic end-of-stream ordering:
//      - `flush()` drains all pending lines (including any failure-reason `system` line) BEFORE
//        the caller commits the terminal DB status transition (`LIVE`, `FAILED`, `SUPERSEDED`).
//      - `end(status)` drains any remaining lines, writes the authoritative `end:<STATUS>` marker,
//        sets the 24h final TTL (`EXPIRE key 86400`), and permanently seals the sink so no late
//        `write()` can resurrect the key without a TTL.

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

/** Minimal pipeline subset used by `createLogSink` (injectable for deterministic unit tests). */
export interface LogRedisPipeline {
  xadd: (key: string, ...args: Array<string | number>) => unknown;
  expire: (key: string, seconds: number) => unknown;
  exec: () => Promise<unknown>;
}

/** Minimal Redis client subset used by `createLogSink`. */
export interface LogRedisClient {
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

const DEFAULT_MAX_QUEUE_SIZE = 500;
const DEFAULT_MAX_BATCH_SIZE = 100;
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
  // Remove trailing replacement character (\uFFFD) if we sliced mid-codepoint
  if (prefix.endsWith('\uFFFD')) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}${TRUNCATED_SUFFIX}`;
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
  } = opts;

  const streamKey = logBuildStreamKey(deploymentId);
  const ownsRedis = !opts.redis;

  // Dedicated Redis connection with `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`,
  // and `commandTimeout: 3000` so a Redis hiccup fails fast instead of hanging the worker.
  const redis: LogRedisClient =
    opts.redis ??
    new Redis(opts.redisUrl ?? process.env['REDIS_URL'] ?? '', {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 3000,
      lazyConnect: false,
    });

  const queue: PendingLogLine[] = [];
  let droppedCount = 0;
  let sealed = false;
  let activeDrain: Promise<void> | null = null;
  let microtaskScheduled = false;

  async function drainLoop(): Promise<void> {
    while (queue.length > 0 || droppedCount > 0) {
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
        await pipe.exec();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`⚠️  [log-sink] Failed to flush ${batch.length} log line(s) for ${deploymentId}: ${msg}`);
      }
    }
  }

  function scheduleDrain(): Promise<void> {
    if (!activeDrain) {
      activeDrain = Promise.resolve()
        .then(() => {
          microtaskScheduled = false;
          return drainLoop();
        })
        .finally(() => {
          activeDrain = null;
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
      await pipe.exec();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️  [log-sink] Failed to write end marker (${finalStatus}) for ${deploymentId}: ${msg}`);
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
