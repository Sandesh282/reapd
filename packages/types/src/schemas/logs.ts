// packages/types/src/schemas/logs.ts
// Shared schemas, constants, and key helpers for build log streaming (Phase 5).
// Pure Domain Layer — zero I/O dependencies beyond `zod`.

import { z } from 'zod';

export const LOG_SOURCES = ['git', 'build', 'system'] as const;
export type LogSource = (typeof LOG_SOURCES)[number];
export const LogSourceSchema = z.enum(LOG_SOURCES);

export const LOG_STREAMS = ['stdout', 'stderr'] as const;
export type LogStream = (typeof LOG_STREAMS)[number];
export const LogStreamSchema = z.enum(LOG_STREAMS);

export const BUILD_LOG_END_STATUSES = ['LIVE', 'FAILED', 'SUPERSEDED'] as const;
export type BuildLogEndStatus = (typeof BUILD_LOG_END_STATUSES)[number];
export const BuildLogEndStatusSchema = z.enum(BUILD_LOG_END_STATUSES);

/**
 * Maximum entries retained per deployment build stream in Redis (`XADD MAXLEN ~`).
 * Bounded to ~2,000 entries x 1 KB max per line (~2 MB worst case per deployment)
 * to protect the 256 MB `noeviction` Redis budget shared with BullMQ.
 */
export const LOG_STREAM_MAXLEN = 2000;

/** Maximum byte/character length of a single log line after secret redaction. */
export const LOG_LINE_MAX_BYTES = 1024;

/** Safety TTL refreshed on every batch flush so a SIGKILL'd worker never leaves an immortal key. */
export const LOG_SAFETY_TTL_SECONDS = 6 * 60 * 60; // 6 hours

/** Final TTL applied when `end(status)` is written at the end of a build. */
export const LOG_FINAL_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export const LogEntrySchema = z.object({
  id: z.string().regex(/^\d+-\d+$/),
  source: LogSourceSchema,
  stream: LogStreamSchema,
  ts: z.number().int().nonnegative(),
  text: z.string(),
});

export type LogEntry = z.infer<typeof LogEntrySchema>;

/** Canonical Redis Stream key for a deployment's build logs. */
export function logBuildStreamKey(deploymentId: string): string {
  return `logs:build:${deploymentId}`;
}

/** Formats the authoritative end-of-build system marker text (`end:LIVE`, `end:FAILED`, `end:SUPERSEDED`). */
export function formatBuildLogEndMarker(status: BuildLogEndStatus): string {
  return `end:${status}`;
}

/**
 * Parses an `end:<STATUS>` marker from a log entry (`{ source, text }`), returning the terminal
 * build status or `null`.
 *
 * SECURITY: Requires `entry.source === 'system'` so repo-controlled `git` or `build` output
 * containing a literal `"end:LIVE"` line can never forge an early end-of-stream marker.
 */
export function parseBuildLogEndMarker(entry: {
  source: string;
  text: string;
}): BuildLogEndStatus | null {
  if (entry.source !== 'system' || !entry.text.startsWith('end:')) return null;
  const raw = entry.text.slice(4);
  const parsed = BuildLogEndStatusSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

