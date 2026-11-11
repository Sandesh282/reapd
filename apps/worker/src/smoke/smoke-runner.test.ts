// apps/worker/src/smoke/smoke-runner.test.ts
// Unit tests for the Phase 6 Playwright smoke runner (`evaluateSmokeProbe` and `runPlaywrightSmokeCheck`).

import assert from 'node:assert/strict';
import test from 'node:test';
import { AbortError } from '@reapd/docker-client';
import {
  evaluateSmokeProbe,
  runPlaywrightSmokeCheck,
  type SmokeCheckProbeResult,
} from './smoke-runner.js';

void test('evaluateSmokeProbe passes only when HTTP < 400, root DOM is non-empty, and zero console/page errors occur', () => {
  const clean = evaluateSmokeProbe({
    httpStatus: 200,
    hasNonEmptyRootDom: true,
    consoleErrors: [],
    pageErrors: [],
  });
  assert.equal(clean.passed, true);
  assert.equal(clean.consoleErrorCount, 0);
  assert.equal(clean.failureMessage, null);

  const badStatus = evaluateSmokeProbe({
    httpStatus: 502,
    hasNonEmptyRootDom: true,
    consoleErrors: [],
    pageErrors: [],
  });
  assert.equal(badStatus.passed, false);
  assert.match(badStatus.failureMessage ?? '', /HTTP status 502/);

  const emptyDom = evaluateSmokeProbe({
    httpStatus: 200,
    hasNonEmptyRootDom: false,
    consoleErrors: [],
    pageErrors: [],
  });
  assert.equal(emptyDom.passed, false);
  assert.match(emptyDom.failureMessage ?? '', /Empty root DOM/);

  const consoleAndPageErr = evaluateSmokeProbe({
    httpStatus: 200,
    hasNonEmptyRootDom: true,
    consoleErrors: ['Hydration mismatch'],
    pageErrors: ['TypeError: x is undefined'],
  });
  assert.equal(consoleAndPageErr.passed, false);
  assert.equal(consoleAndPageErr.consoleErrorCount, 2);
  assert.match(consoleAndPageErr.failureMessage ?? '', /Uncaught pageerror: TypeError: x is undefined/);
  assert.match(consoleAndPageErr.failureMessage ?? '', /console\.error: Hydration mismatch/);
});

void test('runPlaywrightSmokeCheck records PASSED, FAILED, TIMED_OUT, and rethrows AbortError on caller cancel', async () => {
  const logs: string[] = [];

  // 1. Passing probe
  const passRes = await runPlaywrightSmokeCheck({
    previewUrl: 'https://pr-601.preview.localhost',
    onLog: (_stream, line) => logs.push(line),
    probePage: async (): Promise<SmokeCheckProbeResult> => ({
      httpStatus: 200,
      hasNonEmptyRootDom: true,
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
      hasNonEmptyRootDom: true,
      consoleErrors: ['Fatal runtime error'],
      pageErrors: [],
    }),
  });
  assert.equal(failRes.status, 'FAILED');
  assert.equal(failRes.consoleErrorCount, 1);
  assert.match(failRes.failureMessage ?? '', /console\.error: Fatal runtime error/);

  // 3. Timed-out probe
  const timeoutRes = await runPlaywrightSmokeCheck({
    previewUrl: 'https://pr-603.preview.localhost',
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

  // 4. Caller-initiated AbortSignal (superseding) must rethrow AbortError
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () =>
      runPlaywrightSmokeCheck({
        previewUrl: 'https://pr-604.preview.localhost',
        signal: ac.signal,
        probePage: async () => ({
          httpStatus: 200,
          hasNonEmptyRootDom: true,
          consoleErrors: [],
          pageErrors: [],
        }),
      }),
    (err: unknown) => err instanceof AbortError,
  );
});

