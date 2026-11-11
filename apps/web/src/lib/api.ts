// apps/web/src/lib/api.ts
// Typed API client and terminal log formatting helpers for the Phase 5 dashboard.
//
// Design note (BuildKit stderr):
//   `docker build --progress=plain` writes ALL build step progress to `stderr`.
//   Therefore, `formatTerminalLine()` never colors `stderr` lines red — real build
//   failures are surfaced via the system `[reapd] Build failed: ...` summary line
//   and the deployment's `failureReason` banner.

import type { BuildLogEndStatus, DeploymentStatus, LogEntry } from '@reapd/types';

export interface DeploymentSummaryItem {
  id: string;
  pullRequestId: string;
  repoFullName: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  branchName: string;
  isOpen: boolean;
  commitSha: string;
  generation: number;
  subdomain: string;
  previewUrl: string;
  status: DeploymentStatus;
  buildDurationMs: number | null;
  failureReason: string | null;
  expiresAt: string;
  updatedAt: string;
  createdAt: string;
}

export interface DeploymentEventItem {
  id: string;
  deploymentId: string;
  fromStatus: DeploymentStatus | null;
  toStatus: DeploymentStatus;
  reason: string | null;
  createdAt: string;
}

export interface DeploymentDetailWithEvents extends DeploymentSummaryItem {
  containerId: string | null;
  imageTag: string | null;
  logArchiveKey: string | null;
  events: DeploymentEventItem[];
}

export interface SseGapPayload {
  after: string;
  firstAvailableId: string;
  message: string;
}

export interface SseEndPayload {
  status: BuildLogEndStatus;
  expired?: boolean;
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3001';

/** Resolves the control-plane API base URL (without trailing slash). */
export function getApiBaseUrl(): string {
  // IMPORTANT: Must use literal `process.env.NEXT_PUBLIC_API_URL` member access so Next.js
  // statically inlines the value into the browser bundle at build time.
  const raw = process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_BASE_URL;
  return raw.replace(/\/+$/, '');
}

/** Extracts the display host (`pr-42.preview.localhost`) from a preview URL, falling back cleanly. */
export function formatPreviewHost(previewUrl: string, fallbackSubdomain?: string): string {
  try {
    return new URL(previewUrl).host;
  } catch {
    return fallbackSubdomain ? `${fallbackSubdomain}.preview.localhost` : previewUrl;
  }
}

/** Builds the SSE endpoint URL for a deployment's build logs. */
export function getDeploymentLogsSseUrl(
  deploymentId: string,
  baseUrl: string = getApiBaseUrl(),
): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/deployments/${encodeURIComponent(deploymentId)}/logs`;
}

/** Fetches the recent deployments list from `GET /api/deployments`. */
export async function fetchDeployments(options?: {
  repo?: string;
  pr?: number;
  limit?: number;
  signal?: AbortSignal;
  baseUrl?: string;
}): Promise<DeploymentSummaryItem[]> {
  const base = (options?.baseUrl ?? getApiBaseUrl()).replace(/\/+$/, '');
  const params = new URLSearchParams();
  if (options?.repo?.trim()) {
    params.set('repo', options.repo.trim());
  }
  if (options?.pr !== undefined && Number.isInteger(options.pr) && options.pr > 0) {
    params.set('pr', String(options.pr));
  }
  if (options?.limit !== undefined && Number.isInteger(options.limit) && options.limit > 0) {
    params.set('limit', String(options.limit));
  }
  const qs = params.toString();
  const url = `${base}/api/deployments${qs ? `?${qs}` : ''}`;

  const res = await fetch(url, {
    cache: 'no-store',
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch deployments (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { deployments?: DeploymentSummaryItem[] };
  return Array.isArray(body.deployments) ? body.deployments : [];
}

/** Fetches a single deployment and its `deployment_events` timeline from `GET /api/deployments/:id`. */
export async function fetchDeploymentDetail(
  id: string,
  options?: { signal?: AbortSignal; baseUrl?: string },
): Promise<DeploymentDetailWithEvents | null> {
  const base = (options?.baseUrl ?? getApiBaseUrl()).replace(/\/+$/, '');
  const url = `${base}/api/deployments/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    cache: 'no-store',
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch deployment ${id} (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { deployment?: DeploymentDetailWithEvents };
  return body.deployment ?? null;
}

/** Formats a millisecond build duration into a compact human-readable string (`14.2s`, `1m 12s`). */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return '—';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

/** Formats a commit SHA to its 7-character short prefix. */
export function shortSha(sha: string): string {
  return sha.trim().slice(0, 7);
}

/**
 * Formats a structured `LogEntry` into a single ANSI-styled line for `@xterm/xterm`.
 *
 * IMPORTANT: Do NOT color `entry.stream === 'stderr'` red! BuildKit (`docker build --progress=plain`)
 * writes all normal step progress to `stderr`. Instead, we style only the `[source]` prefix tag
 * and leave `git` / `build` line text in the default terminal foreground so BuildKit output reads
 * naturally. System failure lines (`[reapd] Build failed: ...`) are highlighted explicitly.
 */
export function formatTerminalLine(entry: Pick<LogEntry, 'source' | 'stream' | 'ts' | 'text'>): string {
  const timeStr =
    entry.ts > 0 ? new Date(entry.ts).toISOString().slice(11, 23) : '00:00:00.000';
  const dimTime = `\x1b[90m${timeStr}\x1b[0m`;

  if (entry.source === 'system') {
    const isFailure = entry.text.includes('Build failed:');
    const color = isFailure ? '\x1b[31;1m' : '\x1b[36m';
    return `${dimTime} \x1b[36m[system]\x1b[0m ${color}${entry.text}\x1b[0m`;
  }

  if (entry.source === 'git') {
    return `${dimTime} \x1b[35m[git]\x1b[0m    ${entry.text}`;
  }

  return `${dimTime} \x1b[34m[build]\x1b[0m  ${entry.text}`;
}

