// apps/worker/src/github/pr-comment.ts
// Sticky GitHub PR comment formatter and upsert helper (Phase 6b, PRD §6.4).
//
// Design invariants:
//   1. Best-effort: comment failures are caught and warned — a GitHub comment API outage
//      or missing permission NEVER fails a deployment that already reached LIVE or FAILED.
//   2. Generation fencing: before creating/updating the sticky comment on a PR, we read
//      `pull_requests.latest_generation` (`getPullRequestStickyCommentState`). If a newer
//      commit generation has already arrived (`deployment.generation < latestGeneration`),
//      we skip updating the comment so an older slow-failing build never overwrites a newer
//      generation's status table.
//   3. Sticky upsert (`PATCH` -> fallback `POST`):
//      - When `sticky_comment_id` is stored on `pull_requests`, we `PATCH`
//        `/repos/:owner/:repo/issues/comments/:comment_id`.
//      - If `sticky_comment_id` is `null` OR if GitHub returns `404` (e.g. a user deleted
//        the sticky comment on the PR), we `POST` `/repos/:owner/:repo/issues/:pr_number/comments`
//        and persist the new `comment_id` via `setPullRequestStickyCommentId`.
//   4. Secret redaction: `failureReason` and `testRun.failureMessage` are passed through
//      `redactSecrets` and escaped for Markdown table cells before posting to GitHub.

import type { DeploymentStatus, TestRunStatus } from '@reapd/types';
import { getGitHubApiBaseUrl, getInstallationToken } from './auth.js';
import { redactSecrets } from '../logs/log-sink.js';

export const STICKY_COMMENT_MARKER = '<!-- reapd-sticky-comment -->';

export interface PrCommentSmokeSummary {
  status: TestRunStatus;
  durationMs: number;
  consoleErrorCount: number;
  failureMessage: string | null;
}

export interface FormatPrCommentInput {
  deploymentId: string;
  prNumber: number;
  commitSha: string;
  generation: number;
  status: Extract<DeploymentStatus, 'LIVE' | 'FAILED'>;
  previewUrl: string;
  dashboardBaseUrl?: string;
  buildDurationMs?: number | null;
  failureReason?: string | null;
  smoke?: PrCommentSmokeSummary | null;
}

export interface UpsertPrCommentOptions extends FormatPrCommentInput {
  pullRequestId: string;
  owner: string;
  repo: string;
  installationId: number;
  apiBaseUrl?: string;
  /** Optional explicit token override (for tests); when omitted, mints via `getInstallationToken`. */
  authToken?: string;
  getStickyState: (
    pullRequestId: string,
  ) => Promise<{ stickyCommentId: number | null; latestGeneration: number } | null>;
  setStickyCommentId: (
    pullRequestId: string,
    commentId: number,
    generation?: number,
  ) => Promise<boolean | void>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface UpsertPrCommentResult {
  action: 'created' | 'updated' | 'skipped';
  commentId: number | null;
  reason?: string;
}

const DEFAULT_DASHBOARD_BASE_URL = 'http://localhost:3000';

function escapeMarkdownCell(input: string, maxLen = 240): string {
  const redacted = redactSecrets(input)
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
  if (redacted.length <= maxLen) return redacted;
  return `${redacted.slice(0, maxLen)}...`;
}

function formatDurationCell(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return '—';
  }
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Renders the deterministic Markdown body for the sticky GitHub PR comment.
 * Includes the hidden `<!-- reapd-sticky-comment -->` HTML marker on line 1.
 */
export function formatPrCommentMarkdown(input: FormatPrCommentInput): string {
  const shortSha = input.commitSha.trim().slice(0, 7);
  const dashBase = (
    input.dashboardBaseUrl ??
    process.env['REAPD_DASHBOARD_PUBLIC_URL'] ??
    DEFAULT_DASHBOARD_BASE_URL
  ).replace(/\/+$/, '');
  const logsUrl = `${dashBase}/deployments/${encodeURIComponent(input.deploymentId)}`;

  const statusHeading =
    input.status === 'LIVE' ? '🟢 **reapd Preview — LIVE**' : '🔴 **reapd Preview — FAILED**';
  const previewCell =
    input.status === 'LIVE'
      ? `[${input.previewUrl}](${input.previewUrl})`
      : `\`${input.previewUrl}\` *(not live)*`;

  let smokeCell = '—';
  if (input.smoke) {
    const dur = formatDurationCell(input.smoke.durationMs);
    if (input.smoke.status === 'PASSED') {
      smokeCell = `✅ \`PASSED\` (${dur}, 0 errors)`;
    } else if (input.smoke.status === 'SKIPPED') {
      smokeCell = `⚪ \`SKIPPED\``;
    } else {
      const errSuffix =
        input.smoke.consoleErrorCount > 0
          ? `, ${input.smoke.consoleErrorCount} error${input.smoke.consoleErrorCount === 1 ? '' : 's'}`
          : '';
      smokeCell = `❌ \`${input.smoke.status}\` (${dur}${errSuffix})`;
    }
  }

  const lines: string[] = [
    STICKY_COMMENT_MARKER,
    `### ${statusHeading}`,
    '',
    '| Field | Value |',
    '| :--- | :--- |',
    `| **Status** | \`${input.status}\` |`,
    `| **Commit** | \`${shortSha}\` (generation \`${input.generation}\`) |`,
    `| **Preview URL** | ${previewCell} |`,
    `| **Build Duration** | \`${formatDurationCell(input.buildDurationMs)}\` |`,
    `| **Playwright Smoke** | ${smokeCell} |`,
    `| **Build Logs** | [View live logs & timeline](${logsUrl}) |`,
  ];

  if (input.status === 'FAILED' && input.failureReason) {
    lines.push('');
    lines.push(`> **Failure reason:** ${escapeMarkdownCell(input.failureReason, 320)}`);
  }

  return lines.join('\n');
}

/**
 * Creates or updates the sticky PR comment on GitHub (or an injected mock server in smoke tests).
 * Never throws when called through `safeUpsertPrComment`.
 */
export async function upsertPrComment(
  opts: UpsertPrCommentOptions,
): Promise<UpsertPrCommentResult> {
  const state = await opts.getStickyState(opts.pullRequestId);
  if (!state) {
    return { action: 'skipped', commentId: null, reason: 'pull_request row not found' };
  }

  // Generation fence: never allow an older generation to overwrite a newer generation's comment
  if (opts.generation < state.latestGeneration) {
    return {
      action: 'skipped',
      commentId: state.stickyCommentId,
      reason: `stale generation (${opts.generation} < ${state.latestGeneration})`,
    };
  }

  const token =
    opts.authToken ??
    (await getInstallationToken({
      installationId: opts.installationId,
      repoName: opts.repo,
      permissions: { pull_requests: 'write', issues: 'write' },
      ...(opts.apiBaseUrl ? { apiBaseUrl: opts.apiBaseUrl } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }));

  if (!token) {
    return {
      action: 'skipped',
      commentId: state.stickyCommentId,
      reason: 'GitHub App credentials not configured',
    };
  }

  const baseUrl = getGitHubApiBaseUrl(opts.apiBaseUrl);
  const fetchFn = opts.fetchImpl ?? fetch;
  const bodyMarkdown = formatPrCommentMarkdown(opts);

  const timeoutSignal = AbortSignal.timeout(10_000);
  const combinedSignal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'reapd-worker',
  };

  // 1. If a stickyCommentId is already recorded, attempt PATCH first
  if (state.stickyCommentId !== null && state.stickyCommentId > 0) {
    const patchUrl = `${baseUrl}/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(
      opts.repo,
    )}/issues/comments/${state.stickyCommentId}`;

    const patchRes = await fetchFn(patchUrl, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ body: bodyMarkdown }),
      signal: combinedSignal,
    });

    if (patchRes.ok) {
      const data = (await patchRes.json().catch(() => ({}))) as { id?: number };
      return {
        action: 'updated',
        commentId: typeof data.id === 'number' ? data.id : state.stickyCommentId,
      };
    }

    // If the comment was deleted on GitHub (404), fall through to POST a fresh sticky comment
    if (patchRes.status !== 404) {
      const errBody = await patchRes.text().catch(() => '');
      throw new Error(
        `Failed to PATCH GitHub PR comment ${state.stickyCommentId} (HTTP ${patchRes.status}): ${redactSecrets(errBody).slice(0, 200)}`,
      );
    }
  }

  // 2. Create a new sticky comment via POST and store its ID on pull_requests
  const postUrl = `${baseUrl}/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(
    opts.repo,
  )}/issues/${opts.prNumber}/comments`;

  const postRes = await fetchFn(postUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body: bodyMarkdown }),
    signal: combinedSignal,
  });

  if (!postRes.ok) {
    const errBody = await postRes.text().catch(() => '');
    throw new Error(
      `Failed to POST GitHub PR comment on PR #${opts.prNumber} (HTTP ${postRes.status}): ${redactSecrets(errBody).slice(0, 200)}`,
    );
  }

  const created = (await postRes.json()) as { id?: number };
  if (typeof created.id !== 'number' || !Number.isInteger(created.id) || created.id <= 0) {
    throw new Error('GitHub issue comment response did not include a numeric id');
  }

  await opts.setStickyCommentId(opts.pullRequestId, created.id, opts.generation);
  return {
    action: 'created',
    commentId: created.id,
  };
}
