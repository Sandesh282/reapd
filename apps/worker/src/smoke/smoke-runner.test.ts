// apps/worker/src/smoke/smoke-runner.test.ts
// Unit tests for the Phase 6 Playwright smoke runner (`evaluateSmokeProbe`,
// `sanitizeSmokeErrorText`, `SmokeUnavailableError` -> `SKIPPED`, and `runPlaywrightSmokeCheck`).

import assert from 'node:assert/strict';
import test from 'node:test';
import { AbortError } from '@reapd/docker-client';
import {
  evaluateSmokeProbe,
  runPlaywrightSmokeCheck,
  sanitizeSmokeErrorText,
  SmokeUnavailableError,
  type SmokeCheckProbeResult,
} from './smoke-runner.js';

void test('evaluateSmokeProbe fails script-only blank SPA bodies and passes rendered text or visual media', () => {
  // 1. Healthy rendered text
  const clean = evaluateSmokeProbe({
    httpStatus: 200,
    renderedText: 'reapd-phase6-live',
    hasVisualElement: false,
    consoleErrors: [],
    pageErrors: [],
  });
  assert.equal(clean.passed, true);
  assert.equal(clean.consoleErrorCount, 0);
  assert.equal(clean.failureMessage, null);

  // 2. Canvas/SVG-only page (no innerText, but hasVisualElement = true)
  const canvasOnly = evaluateSmokeProbe({
    httpStatus: 200,
    renderedText: '   ',
    hasVisualElement: true,
    consoleErrors: [],
    pageErrors: [],
  });
  assert.equal(canvasOnly.passed, true);

  // 3. Crashed SPA shell (`<div id="root"></div><script src="app.js"></script>` -> empty innerText, no media)
  const scriptOnlyShell = evaluateSmokeProbe({
    httpStatus: 200,
    renderedText: '   \n  ',
    hasVisualElement: false,
    consoleErrors: [],
    pageErrors: [],
  });
  assert.equal(scriptOnlyShell.passed, false);
  assert.match(scriptOnlyShell.failureMessage ?? '', /Empty rendered root DOM/);

  // 4. HTTP 502 error
  const badStatus = evaluateSmokeProbe({
    httpStatus: 502,
    renderedText: 'Bad Gateway',
    hasVisualElement: false,
    consoleErrors: [],
    pageErrors: [],
  });
  assert.equal(badStatus.passed, false);
  assert.match(badStatus.failureMessage ?? '', /HTTP status 502/);
});

void test('evaluateSmokeProbe and sanitizeSmokeErrorText redact secrets BEFORE truncation', () => {
  // Build a console error where a GitHub token sits right across the 200-char boundary
  const prefix = 'x'.repeat(185);
  const leakedToken = 'ghs_1234567890abcdefghijklmnopqrstuvwxyz';
  const sanitized = sanitizeSmokeErrorText(`${prefix} ${leakedToken}`, 200);
  assert.ok(!sanitized.includes('ghs_'), `Expected token prefix to be redacted before slice: ${sanitized}`);
  assert.match(sanitized, /\[REDACTED_/);

  const evaluated = evaluateSmokeProbe({
    httpStatus: 200,
    renderedText: 'ok',
    hasVisualElement: false,
    consoleErrors: [`Auth leak: Bearer secret_token_value_1234567890`],
    pageErrors: [`Failed connecting to redis://:supersecretpass@127.0.0.1:6379`],
  });
  assert.equal(evaluated.passed, false);
  assert.equal(evaluated.consoleErrorCount, 2);
  assert.ok(!evaluated.failureMessage?.includes('secret_token_value_1234567890'));
  assert.ok(!evaluated.failureMessage?.includes('supersecretpass'));
  assert.match(evaluated.failureMessage ?? '', /Bearer \[REDACTED\]/);
  assert.match(evaluated.failureMessage ?? '', /redis:\/\/:\[REDACTED\]@127\.0\.0\.1:6379/);
});

void test('runPlaywrightSmokeCheck records PASSED, FAILED, TIMED_OUT, SKIPPED, and rethrows AbortError on cancel', async () => {
  const logs: string[] = [];

  // 1. Passing probe
  const passRes = await runPlaywrightSmokeCheck({
    previewUrl: 'https://pr-601.preview.localhost',
    onLog: (_stream, line) => logs.push(line),
    probePage: async (): Promise<SmokeCheckProbeResult> => ({
      httpStatus: 200,
      renderedText: 'Hello preview',
      hasVisualElement: false,
      consoleErrors: [],
      pageErrors: [],
    }),
  });
  assert.equal(passRes.status, 'PASSED');
  assert.equal(passRes.consoleErrorCount, 0);
  assert.equal(passRes.failureMessage, null);
  assert.ok(logs.some((l) => l.includes('Smoke check PASSED')));

  // 2. Failing probe (console.error)
  const failRes = await runPlaywrightSmokeCheck({
    previewUrl: 'https://pr-602.preview.localhost',
    probePage: async (): Promise<SmokeCheckProbeResult> => ({
      httpStatus: 200,
      renderedText: 'Hello preview',
      hasVisualElement: false,
      consoleErrors: ['Fatal runtime error with token ghp_abcdefgh1234567890'],
      pageErrors: [],
    }),
  });
  assert.equal(failRes.status, 'FAILED');
  assert.equal(failRes.consoleErrorCount, 1);
  assert.ok(!failRes.failureMessage?.includes('ghp_'));
  assert.match(failRes.failureMessage ?? '', /\[REDACTED_GITHUB_TOKEN\]/);

  // 3. Missing Chromium binary -> SmokeUnavailableError -> SKIPPED (does not fail deployment)
  const skipRes = await runPlaywrightSmokeCheck({
    previewUrl: 'https://pr-603.preview.localhost',
    probePage: async (): Promise<SmokeCheckProbeResult> => {
      throw new SmokeUnavailableError('No Chromium executable found');
    },
  });
  assert.equal(skipRes.status, 'SKIPPED');
  assert.equal(skipRes.consoleErrorCount, 0);
  assert.match(skipRes.failureMessage ?? '', /No Chromium executable found/);

  // 4. Timed-out probe
  const timeoutRes = await runPlaywrightSmokeCheck({
    previewUrl: 'https://pr-604.preview.localhost',
    timeoutMs: 30,
    probePage: async ({ signal }): Promise<SmokeCheckProbeResult> => {
      await new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Navigation timeout exceeded')), {
          once: true,
        });
      });
      throw new Error('unreachable');
    },
  });
  assert.equal(timeoutRes.status, 'TIMED_OUT');
  assert.match(timeoutRes.failureMessage ?? '', /Smoke check timed out/);

  // 5. Caller-initiated AbortSignal (superseding) must rethrow AbortError
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () =>
      runPlaywrightSmokeCheck({
        previewUrl: 'https://pr-605.preview.localhost',
        signal: ac.signal,
        probePage: async () => ({
          httpStatus: 200,
          renderedText: 'ok',
          hasVisualElement: false,
          consoleErrors: [],
          pageErrors: [],
        }),
      }),
    (err: unknown) => err instanceof AbortError,
  );
});
