// apps/api/src/routes/deployments.ts
// Read-only REST + SSE log-streaming routes for the Phase 5 dashboard & CLI.
//
// Architectural boundary: this Route Layer module delegates all SQL queries to
// `@reapd/db` repository functions and never imports `drizzle-orm` or `dockerode`.
//
// Routes:
//   GET /api/deployments            → Recent deployments (filtered by ?repo=, ?pr=, ?limit=)
//   GET /api/deployments/:id        → Single deployment + ordered `deployment_events` timeline
//   GET /api/deployments/:id/logs   → Server-Sent Events (SSE) stream backed by Redis Streams (`XREAD BLOCK`)

import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import {
  db as defaultDb,
  getDeploymentByIdWithEvents as defaultGetDeploymentByIdWithEvents,
  listRecentDeployments as defaultListRecentDeployments,
  type DeploymentDetailWithEvents,
  type DeploymentSummaryItem,
  type ListRecentDeploymentsFilter,
} from '@reapd/db';
import {
  type BuildLogEndStatus,
  type DeploymentStatus,
  logBuildStreamKey,
  type LogEntry,
  LogSourceSchema,
  LogStreamSchema,
  parseBuildLogEndMarker,
  TERMINAL_STATUSES,
} from '@reapd/types';

export type RawStreamTuple = [id: string, fields: string[]];
export type XreadReply = Array<[key: string, entries: RawStreamTuple[]]> | null;

/** Minimal Redis Stream client interface required by the SSE route (injectable for unit tests). */
export interface SseRedisClient {
  call: (command: string, ...args: Array<string | number>) => Promise<unknown>;
  disconnect: () => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface DeploymentRoutesDeps {
  listRecentDeployments?: (filter?: ListRecentDeploymentsFilter) => Promise<DeploymentSummaryItem[]>;
  getDeploymentByIdWithEvents?: (id: string) => Promise<DeploymentDetailWithEvents | null>;
  createSseRedis?: () => SseRedisClient;
  allowedCorsOrigins?: ReadonlySet<string>;
  maxConcurrentSseClients?: number;
  xreadBlockMs?: number;
  xreadFallbackGraceMs?: number;
  xreadCount?: number;
  keepaliveIntervalMs?: number;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STREAM_ID_REGEX = /^\d+-\d+$/;
const DEFAULT_MAX_CONCURRENT_SSE = 50;
const DEFAULT_XREAD_BLOCK_MS = 5000;
const DEFAULT_XREAD_FALLBACK_GRACE_MS = 1000;
const DEFAULT_XREAD_COUNT = 200;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000;
const WRITE_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Compares two Redis Stream IDs (`<ms>-<seq>`).
 * Returns `-1` if `a < b`, `0` if `a === b`, and `1` if `a > b`.
 */
export function compareStreamIds(a: string, b: string): -1 | 0 | 1 {
  const [aMsRaw = '0', aSeqRaw = '0'] = a.split('-');
  const [bMsRaw = '0', bSeqRaw = '0'] = b.split('-');
  const aMs = BigInt(aMsRaw);
  const bMs = BigInt(bMsRaw);
  if (aMs !== bMs) return aMs < bMs ? -1 : 1;
  const aSeq = BigInt(aSeqRaw);
  const bSeq = BigInt(bSeqRaw);
  if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
  return 0;
}

/**
 * Parses a flat Redis Stream field-value array (`['source', 'git', 'stream', 'stdout', ...]`)
 * into a structured `LogEntry`.
 */
export function parseRawStreamEntry(id: string, fields: string[]): LogEntry {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const k = fields[i];
    const v = fields[i + 1];
    if (k !== undefined && v !== undefined) {
      map.set(k, v);
    }
  }
  const rawSource = map.get('source') ?? 'system';
  const rawStream = map.get('stream') ?? 'stdout';
  const rawTs = Number(map.get('ts') ?? 0);
  const text = map.get('text') ?? '';

  const sourceParsed = LogSourceSchema.safeParse(rawSource);
  const streamParsed = LogStreamSchema.safeParse(rawStream);

  return {
    id,
    source: sourceParsed.success ? sourceParsed.data : 'system',
    stream: streamParsed.success ? streamParsed.data : 'stdout',
    ts: Number.isFinite(rawTs) && rawTs >= 0 ? Math.trunc(rawTs) : 0,
    text,
  };
}

/**
 * Extracts the first retained stream entry ID from an `XINFO STREAM <key>` response array.
 * Returns `null` if the stream does not exist or has 0 entries.
 */
export function extractFirstEntryIdFromXinfo(info: unknown): string | null {
  if (!Array.isArray(info)) return null;
  for (let i = 0; i + 1 < info.length; i += 2) {
    if (info[i] === 'first-entry') {
      const firstEntry = info[i + 1];
      if (Array.isArray(firstEntry) && typeof firstEntry[0] === 'string' && STREAM_ID_REGEX.test(firstEntry[0])) {
        return firstEntry[0];
      }
      return null;
    }
  }
  return null;
}

function toBuildEndStatusFromDb(status: DeploymentStatus): BuildLogEndStatus {
  if (status === 'LIVE' || status === 'EXPIRED') return 'LIVE';
  if (status === 'SUPERSEDED') return 'SUPERSEDED';
  return 'FAILED';
}

function isBuildCompleteInDb(status: DeploymentStatus): boolean {
  return status === 'LIVE' || TERMINAL_STATUSES.has(status);
}

async function writeSseChunk(res: ServerResponse, chunk: string): Promise<boolean> {
  if (res.writableEnded || res.destroyed) return false;
  const ok = res.write(chunk);
  if (!ok && !res.writableEnded && !res.destroyed) {
    // Abort the losing listener and enforce a 30s drain timeout so a half-open slow client
    // that stops reading without closing its socket cannot hold an SSE slot forever.
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, WRITE_DRAIN_TIMEOUT_MS);
    await Promise.race([
      once(res, 'drain', { signal: ac.signal }),
      once(res, 'close', { signal: ac.signal }),
    ])
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        ac.abort();
      });
    if (timedOut) {
      res.destroy();
      return false;
    }
  }
  return !res.writableEnded && !res.destroyed;
}

export async function registerDeploymentRoutes(
  app: FastifyInstance,
  deps?: DeploymentRoutesDeps,
): Promise<void> {
  const listDeployments =
    deps?.listRecentDeployments ?? ((filter) => defaultListRecentDeployments(defaultDb, filter));
  const getDeployment =
    deps?.getDeploymentByIdWithEvents ?? ((id) => defaultGetDeploymentByIdWithEvents(defaultDb, id));
  const createSseRedis =
    deps?.createSseRedis ??
    ((): SseRedisClient => {
      const url = process.env['REDIS_URL'];
      if (!url) {
        throw new Error('REDIS_URL is required to open an SSE Redis connection');
      }
      const client = new Redis(url, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: true,
        connectTimeout: 3000,
      });
      client.on('error', () => {});
      return client as unknown as SseRedisClient;
    });

  const allowedOrigins =
    deps?.allowedCorsOrigins ??
    new Set(
      (process.env['REAPD_DASHBOARD_ORIGIN'] ?? 'http://localhost:3000,http://127.0.0.1:3000')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

  const maxConcurrentSse = deps?.maxConcurrentSseClients ?? DEFAULT_MAX_CONCURRENT_SSE;
  const xreadBlockMs = deps?.xreadBlockMs ?? DEFAULT_XREAD_BLOCK_MS;
  const xreadFallbackGraceMs = deps?.xreadFallbackGraceMs ?? DEFAULT_XREAD_FALLBACK_GRACE_MS;
  const xreadCount = deps?.xreadCount ?? DEFAULT_XREAD_COUNT;
  const keepaliveIntervalMs = deps?.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;

  let activeSseCount = 0;

  // ── 1. GET /api/deployments ─────────────────────────────────────────────────
  app.get('/api/deployments', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const repo = query['repo']?.trim() || undefined;

    let prNumber: number | undefined;
    if (query['pr'] !== undefined && query['pr'] !== '') {
      const parsedPr = Number(query['pr']);
      if (!Number.isInteger(parsedPr) || parsedPr <= 0) {
        return reply.status(400).send({ error: 'Invalid query parameter `pr`: must be a positive integer' });
      }
      prNumber = parsedPr;
    }

    let limit = 50;
    if (query['limit'] !== undefined && query['limit'] !== '') {
      const parsedLimit = Number(query['limit']);
      if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
        return reply.status(400).send({ error: 'Invalid query parameter `limit`: must be a positive integer' });
      }
      limit = Math.min(100, parsedLimit);
    }

    const deployments = await listDeployments({
      ...(repo ? { repo } : {}),
      ...(prNumber !== undefined ? { prNumber } : {}),
      limit,
    });

    return reply.send({ deployments });
  });

  // ── 2. GET /api/deployments/:id ─────────────────────────────────────────────
  app.get('/api/deployments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_REGEX.test(id)) {
      return reply.status(400).send({ error: 'Invalid deployment ID: must be a UUID' });
    }

    const deployment = await getDeployment(id);
    if (!deployment) {
      return reply.status(404).send({ error: 'Deployment not found' });
    }

    return reply.send({ deployment });
  });

  // ── 3. GET /api/deployments/:id/logs (SSE) ──────────────────────────────────
  app.get('/api/deployments/:id/logs', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_REGEX.test(id)) {
      return reply.status(400).send({ error: 'Invalid deployment ID: must be a UUID' });
    }

    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const lastEventIdHeader = req.headers['last-event-id'];
    const rawResumeId =
      (typeof lastEventIdHeader === 'string' && lastEventIdHeader.trim()) ||
      query['after']?.trim() ||
      undefined;

    if (rawResumeId !== undefined && !STREAM_ID_REGEX.test(rawResumeId)) {
      return reply.status(400).send({
        error: 'Invalid Last-Event-ID / after cursor: must match <ms>-<seq> (e.g. "0-0")',
      });
    }

    // Reserve the slot BEFORE any await so concurrent requests can't all pass the cap check
    // while a slow DB lookup is in flight; every early return below must release it.
    if (activeSseCount >= maxConcurrentSse) {
      return reply.status(429).send({
        error: `Too many concurrent log streams (max ${maxConcurrentSse})`,
      });
    }
    activeSseCount += 1;
    let sseRedis: SseRedisClient | null = null;
    let closed = false;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      activeSseCount = Math.max(0, activeSseCount - 1);
      if (sseRedis) {
        try {
          // IMPORTANT: Use `disconnect()` (never `quit()`) because `XREAD BLOCK` holds the
          // connection in a blocking state and `QUIT` would queue behind the block until timeout.
          sseRedis.disconnect();
        } catch {
          // ignore disconnect errors
        }
        sseRedis = null;
      }
    };

    // Register `reply.raw` 'close' immediately after reserving the slot (before any `await`)
    // so a client disconnecting during `getDeployment(id)` still releases its slot right away.
    // (`req.raw` 'close' is intentionally NOT used because on modern Node it fires as soon as
    // the empty GET request body is consumed.)
    reply.raw.once('close', cleanup);
    if (reply.raw.destroyed || reply.raw.writableEnded) {
      cleanup();
      return;
    }

    let initialDeployment: DeploymentDetailWithEvents | null;
    try {
      initialDeployment = await getDeployment(id);
    } catch (err) {
      cleanup();
      throw err;
    }
    if (!initialDeployment) {
      cleanup();
      return reply.status(404).send({ error: 'Deployment not found' });
    }
    if (closed || reply.raw.destroyed) {
      cleanup();
      return;
    }

    try {
      sseRedis = createSseRedis();
    } catch (err) {
      cleanup();
      req.log.error({ err, deploymentId: id }, 'Failed to create SSE Redis client');
      return reply.status(503).send({ error: 'Log streaming service unavailable' });
    }

    // Hijack the response to stream raw SSE frames; set CORS headers explicitly since
    // `reply.hijack()` bypasses Fastify's normal `onSend` lifecycle hooks.
    reply.hijack();
    const res = reply.raw;
    const reqOrigin = req.headers['origin'];
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    };
    if (typeof reqOrigin === 'string' && allowedOrigins.has(reqOrigin)) {
      headers['Access-Control-Allow-Origin'] = reqOrigin;
      headers['Vary'] = 'Origin';
    }
    res.writeHead(200, headers);
    res.flushHeaders?.();

    const streamKey = logBuildStreamKey(id);
    let cursor = rawResumeId ?? '0-0';
    let lastKeepaliveAt = Date.now();

    try {
      // ── Step 1: Gap detection on resume (`XINFO STREAM`) ─────────────────────
      if (rawResumeId && rawResumeId !== '0-0' && sseRedis) {
        try {
          const info = await sseRedis.call('XINFO', 'STREAM', streamKey);
          const firstEntryId = extractFirstEntryIdFromXinfo(info);
          if (firstEntryId && compareStreamIds(rawResumeId, firstEntryId) < 0) {
            const gapPayload = JSON.stringify({
              after: rawResumeId,
              firstAvailableId: firstEntryId,
              message: `Log entries before ${firstEntryId} were trimmed by MAXLEN cap`,
            });
            await writeSseChunk(res, `event: gap\ndata: ${gapPayload}\n\n`);
          }
        } catch {
          // Key does not exist yet or expired — handled by the main XREAD loop below
        }
      }

      // ── Step 2: Fast-path check when stream key is already expired on a completed build
      if (!closed && sseRedis && isBuildCompleteInDb(initialDeployment.status)) {
        const exists = Number(await sseRedis.call('EXISTS', streamKey).catch(() => 0));
        if (exists === 0) {
          const endStatus = toBuildEndStatusFromDb(initialDeployment.status);
          const endPayload = JSON.stringify({ status: endStatus, expired: true });
          await writeSseChunk(res, `event: end\ndata: ${endPayload}\n\n`);
          res.end();
          return;
        }
      }

      // ── Step 3: Unified replay + live-tail loop (`XREAD COUNT 200 BLOCK 5000`) ──
      // Starting from `0-0` (or `Last-Event-ID`), history replay and live tail use the exact
      // same code path, guaranteeing strictly monotonic stream IDs with zero duplicates.
      const drainEntries = async (replyData: XreadReply): Promise<BuildLogEndStatus | null> => {
        if (!replyData || !Array.isArray(replyData)) return null;
        for (const [, entries] of replyData) {
          if (!Array.isArray(entries)) continue;
          for (const tuple of entries) {
            if (closed) return null;
            const [entryId, rawFields] = tuple;
            if (!entryId || !Array.isArray(rawFields)) continue;
            cursor = entryId;
            const entry = parseRawStreamEntry(entryId, rawFields);
            const endMarker = parseBuildLogEndMarker(entry);
            if (endMarker) {
              return endMarker;
            }
            const frame = `id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`;
            const writable = await writeSseChunk(res, frame);
            if (!writable) return null;
          }
        }
        return null;
      };

      while (!closed && sseRedis) {
        const replyData = (await sseRedis.call(
          'XREAD',
          'COUNT',
          String(xreadCount),
          'BLOCK',
          String(xreadBlockMs),
          'STREAMS',
          streamKey,
          cursor,
        )) as XreadReply;

        if (closed) break;

        if (replyData) {
          const endMarker = await drainEntries(replyData);
          lastKeepaliveAt = Date.now();
          if (endMarker) {
            await writeSseChunk(res, `event: end\ndata: ${JSON.stringify({ status: endMarker })}\n\n`);
            res.end();
            return;
          }
          continue;
        }

        // `XREAD BLOCK` timed out with no new entries (`replyData === null`).
        // Emit `: keepalive` comment every ~15s to prevent idle proxy timeouts.
        const now = Date.now();
        if (now - lastKeepaliveAt >= keepaliveIntervalMs) {
          const writable = await writeSseChunk(res, ': keepalive\n\n');
          if (!writable) break;
          lastKeepaliveAt = now;
        }

        // Dead-worker / missing-end-marker fallback: check Postgres status on timeout.
        // Because webhook-committed SUPERSEDED and reconciler-committed FAILED land in Postgres
        // BEFORE the worker writes its final fenced line + `end:<STATUS>` marker (or if the worker
        // was SIGKILL'd and never wrote `end:<STATUS>`), we perform one bounded blocking grace read
        // (`xreadFallbackGraceMs`, default 1000ms) followed by a drain loop after observing the
        // terminal DB status so a racing worker has time to flush its tail + `end:<STATUS>` marker.
        const current = await getDeployment(id).catch(() => null);
        if (!current || closed || !sseRedis) break;

        if (isBuildCompleteInDb(current.status)) {
          let firstGraceRead = true;
          while (!closed && sseRedis) {
            const finalBatch = (await (firstGraceRead && xreadFallbackGraceMs > 0
              ? sseRedis.call(
                  'XREAD',
                  'COUNT',
                  String(xreadCount),
                  'BLOCK',
                  String(xreadFallbackGraceMs),
                  'STREAMS',
                  streamKey,
                  cursor,
                )
              : sseRedis.call('XREAD', 'COUNT', String(xreadCount), 'STREAMS', streamKey, cursor)
            ).catch(() => null)) as XreadReply;
            firstGraceRead = false;
            if (!finalBatch) break;
            const endMarker = await drainEntries(finalBatch);
            if (endMarker) {
              await writeSseChunk(res, `event: end\ndata: ${JSON.stringify({ status: endMarker })}\n\n`);
              res.end();
              return;
            }
          }
          const fallbackStatus = toBuildEndStatusFromDb(current.status);
          await writeSseChunk(res, `event: end\ndata: ${JSON.stringify({ status: fallbackStatus })}\n\n`);
          res.end();
          return;
        }
      }
    } catch (err) {
      if (!closed) {
        req.log.warn({ err, deploymentId: id }, 'SSE log stream terminated after error');
      }
    } finally {
      cleanup();
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    }
  });
}

