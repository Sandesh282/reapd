// apps/worker/src/github/pr-comment.test.ts
// Unit tests for sticky GitHub PR comment formatting, secret redaction,
// generation fencing, and PATCH -> 404 POST fallback.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPrCommentMarkdown,
  STICKY_COMMENT_MARKER,
  upsertPrComment,
} from './pr-comment.js';

describe('formatPrCommentMarkdown', () => {
  it('renders LIVE comment with PASSED smoke summary and hidden sticky marker', () => {
    const md = formatPrCommentMarkdown({
      deploymentId: '11111111-2222-3333-4444-555555555555',
      prNumber: 42,
      commitSha: '984059a92f313ed45552ef4a923ba95cf9a8abc7',
      generation: 1,
      status: 'LIVE',
      previewUrl: 'https://pr-42.preview.localhost',
      dashboardBaseUrl: 'http://localhost:3000/',
      buildDurationMs: 1450,
      smoke: {
        status: 'PASSED',
        durationMs: 320,
        consoleErrorCount: 0,
        failureMessage: null,
      },
    });

    assert.ok(md.startsWith(`${STICKY_COMMENT_MARKER}\n`), 'Must start with sticky HTML marker');
    assert.match(md, /🟢 \*\*reapd Preview — LIVE\*\*/);
    assert.match(md, /\| \*\*Commit\*\* \| `984059a` \(generation `1`\) \|/);
    assert.match(md, /\| \*\*Preview URL\*\* \| \[https:\/\/pr-42\.preview\.localhost\]\(https:\/\/pr-42\.preview\.localhost\) \|/);
    assert.match(md, /\| \*\*Build Duration\*\* \| `1\.4s` \|/);
    assert.match(md, /\| \*\*Playwright Smoke\*\* \| ✅ `PASSED` \(320ms, 0 errors\) \|/);
    assert.match(
      md,
      /\| \*\*Build Logs\*\* \| \[View live logs & timeline\]\(http:\/\/localhost:3000\/deployments\/11111111-2222-3333-4444-555555555555\) \|/,
    );
  });

  it('redacts secrets and escapes Markdown pipes in FAILED comment failureReason', () => {
    const fakeToken = `ghs_${'A'.repeat(36)}`;
    const md = formatPrCommentMarkdown({
      deploymentId: '22222222-3333-4444-5555-666666666666',
      prNumber: 42,
      commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
      generation: 2,
      status: 'FAILED',
      previewUrl: 'https://pr-42.preview.localhost',
      buildDurationMs: 820,
      failureReason: `Console error (1): leaked ${fakeToken} | pipe_hazard\nsecond_line`,
      smoke: {
        status: 'FAILED',
        durationMs: 410,
        consoleErrorCount: 1,
        failureMessage: 'Console error (1): boom',
      },
    });

    assert.match(md, /🔴 \*\*reapd Preview — FAILED\*\*/);
    assert.match(md, /\| \*\*Playwright Smoke\*\* \| ❌ `FAILED` \(410ms, 1 error\) \|/);
    assert.ok(!md.includes(fakeToken), 'GitHub token in failureReason must be redacted');
    assert.match(md, /\[REDACTED_GITHUB_TOKEN\]/);
    assert.match(md, /\\\| pipe_hazard second_line/, 'Pipes and newlines must be escaped');
  });
});

describe('upsertPrComment', () => {
  it('POSTs a new comment when stickyCommentId is null and persists the returned id', async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    let savedSticky: { prId: string; commentId: number; gen?: number } | null = null;

    const res = await upsertPrComment({
      deploymentId: 'dep-1',
      pullRequestId: 'pr-uuid-1',
      prNumber: 601,
      owner: 'Sandesh282',
      repo: 'reapd',
      installationId: 55501,
      commitSha: 'a'.repeat(40),
      generation: 1,
      status: 'LIVE',
      previewUrl: 'https://pr-601.preview.localhost',
      buildDurationMs: 900,
      smoke: { status: 'PASSED', durationMs: 250, consoleErrorCount: 0, failureMessage: null },
      authToken: 'test-token',
      apiBaseUrl: 'http://127.0.0.1:19999',
      getStickyState: async () => ({ stickyCommentId: null, latestGeneration: 1 }),
      setStickyCommentId: async (prId, commentId, gen) => {
        savedSticky = { prId, commentId, ...(gen !== undefined ? { gen } : {}) };
      },
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: init?.method ?? 'GET',
          body: String(init?.body ?? ''),
        });
        return new Response(JSON.stringify({ id: 9001 }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });

    assert.equal(res.action, 'created');
    assert.equal(res.commentId, 9001);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'POST');
    assert.equal(calls[0]?.url, 'http://127.0.0.1:19999/repos/Sandesh282/reapd/issues/601/comments');
    assert.deepEqual(savedSticky, { prId: 'pr-uuid-1', commentId: 9001, gen: 1 });
  });

  it('PATCHes existing comment in-place when stickyCommentId is present', async () => {
    const calls: { url: string; method: string }[] = [];
    let setCalled = false;

    const res = await upsertPrComment({
      deploymentId: 'dep-2',
      pullRequestId: 'pr-uuid-1',
      prNumber: 601,
      owner: 'Sandesh282',
      repo: 'reapd',
      installationId: 55501,
      commitSha: 'b'.repeat(40),
      generation: 2,
      status: 'FAILED',
      previewUrl: 'https://pr-601.preview.localhost',
      failureReason: 'Console error (1): deliberate error',
      smoke: {
        status: 'FAILED',
        durationMs: 310,
        consoleErrorCount: 1,
        failureMessage: 'Console error (1): deliberate error',
      },
      authToken: 'test-token',
      apiBaseUrl: 'http://127.0.0.1:19999',
      getStickyState: async () => ({ stickyCommentId: 9001, latestGeneration: 2 }),
      setStickyCommentId: async () => {
        setCalled = true;
      },
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? 'GET' });
        return new Response(JSON.stringify({ id: 9001 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });

    assert.equal(res.action, 'updated');
    assert.equal(res.commentId, 9001);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'PATCH');
    assert.equal(calls[0]?.url, 'http://127.0.0.1:19999/repos/Sandesh282/reapd/issues/comments/9001');
    assert.equal(setCalled, false, 'PATCH should not re-persist stickyCommentId');
  });

  it('falls back to POST and updates stickyCommentId when PATCH returns 404 (deleted comment)', async () => {
    const calls: { url: string; method: string }[] = [];
    let newId: number | null = null;

    const res = await upsertPrComment({
      deploymentId: 'dep-3',
      pullRequestId: 'pr-uuid-1',
      prNumber: 601,
      owner: 'Sandesh282',
      repo: 'reapd',
      installationId: 55501,
      commitSha: 'c'.repeat(40),
      generation: 3,
      status: 'LIVE',
      previewUrl: 'https://pr-601.preview.localhost',
      authToken: 'test-token',
      apiBaseUrl: 'http://127.0.0.1:19999',
      getStickyState: async () => ({ stickyCommentId: 9001, latestGeneration: 3 }),
      setStickyCommentId: async (_prId, commentId) => {
        newId = commentId;
      },
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url: String(url), method });
        if (method === 'PATCH') {
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        }
        return new Response(JSON.stringify({ id: 9002 }), { status: 201 });
      }) as typeof fetch,
    });

    assert.equal(res.action, 'created');
    assert.equal(res.commentId, 9002);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.method, 'PATCH');
    assert.equal(calls[1]?.method, 'POST');
    assert.equal(newId, 9002);
  });

  it('skips updating when deployment generation is older than pull_requests.latest_generation', async () => {
    let fetchCalled = false;

    const res = await upsertPrComment({
      deploymentId: 'dep-stale',
      pullRequestId: 'pr-uuid-1',
      prNumber: 601,
      owner: 'Sandesh282',
      repo: 'reapd',
      installationId: 55501,
      commitSha: 'a'.repeat(40),
      generation: 1,
      status: 'FAILED',
      previewUrl: 'https://pr-601.preview.localhost',
      authToken: 'test-token',
      getStickyState: async () => ({ stickyCommentId: 9001, latestGeneration: 2 }),
      setStickyCommentId: async () => {},
      fetchImpl: (async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });

    assert.equal(res.action, 'skipped');
    assert.match(res.reason ?? '', /stale generation/);
    assert.equal(fetchCalled, false, 'Stale generation must not call GitHub REST API');
  });
});
