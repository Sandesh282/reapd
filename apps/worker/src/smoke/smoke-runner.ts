// apps/worker/src/smoke/smoke-runner.ts
// Phase 6 Playwright Smoke Runner (PRD §6.4).
//
// Navigates to the preview URL during the `TESTING` state and verifies:
//   1. HTTP response status < 400
//   2. Non-empty root DOM node (`document.body` contains visible/non-empty content)
//   3. Zero uncaught `pageerror` exceptions and zero `console.error` events
//
// Design invariants:
//   - Respects the job's `AbortSignal` (`ac.signal`) so a supersede cancel signal
//     immediately aborts an in-flight browser check and tears down the browser.
//   - Uses `--host-resolver-rules=MAP *.localhost 127.0.0.1` and `ignoreHTTPSErrors: true`
//     when launching headless Chromium so `https://pr-N.preview.localhost` resolves
//     deterministically across macOS and Linux CI.
//   - Injectable `browserCheck` seam for fast, deterministic unit tests and environments
//     where a Chromium binary is not installed.

import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { AbortError } from '@reapd/docker-client';
import type { TestRunStatus } from '@reapd/types';

export interface SmokeCheckProbeResult {
  httpStatus: number;
  hasNonEmptyRootDom: boolean;
  consoleErrors: string[];
  pageErrors: string[];
}

export interface RunSmokeCheckOptions {
  previewUrl: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  settleWaitMs?: number;
  onLog?: (stream: 'stdout' | 'stderr', line: string) => void;
  /** Optional override for unit tests; defaults to real Playwright headless Chromium. */
  probePage?: (opts: {
    previewUrl: string;
    signal: AbortSignal;
    timeoutMs: number;
    settleWaitMs: number;
  }) => Promise<SmokeCheckProbeResult>;
}

export interface SmokeTestRunSummary {
  status: TestRunStatus;
  durationMs: number;
  consoleErrorCount: number;
  failureMessage: string | null;
}

const DEFAULT_SMOKE_TIMEOUT_MS = 15_000;
const DEFAULT_SETTLE_WAIT_MS = 150;

const SYSTEM_CHROMIUM_CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

/** Resolves a Chromium/Chrome executable path (Playwright bundled or system-installed). */
export function resolveChromiumExecutablePath(): string | undefined {
  const fromEnv = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']?.trim();
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }
  try {
    const pwDefault = chromium.executablePath();
    if (pwDefault && existsSync(pwDefault)) {
      return pwDefault;
    }
  } catch {
    // ignore and check system candidates
  }
  for (const candidate of SYSTEM_CHROMIUM_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Default Playwright Chromium page probe:
 *   - Launches headless Chromium with `--host-resolver-rules=MAP *.localhost 127.0.0.1`
 *   - Collects `console.error` and `pageerror` events
 *   - Navigates to `previewUrl` (`waitUntil: 'domcontentloaded'`)
 *   - Checks `document.body.innerHTML.trim().length > 0`
 *   - Guaranteed `browser.close()` in `finally` and immediate teardown on `signal` abort
 */
export async function probeWithPlaywrightChromium(opts: {
  previewUrl: string;
  signal: AbortSignal;
  timeoutMs: number;
  settleWaitMs: number;
}): Promise<SmokeCheckProbeResult> {
  if (opts.signal.aborted) {
    throw new AbortError('Smoke test aborted before browser launch');
  }

  const executablePath = resolveChromiumExecutablePath();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--host-resolver-rules=MAP *.localhost 127.0.0.1, MAP *.preview.localhost 127.0.0.1',
    ],
  });

  const onAbort = (): void => {
    void browser.close().catch(() => {});
  };
  opts.signal.addEventListener('abort', onAbort, { once: true });

  try {
    if (opts.signal.aborted) {
      throw new AbortError('Smoke test aborted after browser launch');
    }

    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    page.on('pageerror', (err) => {
      pageErrors.push(err.message || String(err));
    });

    const response = await page.goto(opts.previewUrl, {
      waitUntil: 'domcontentloaded',
      timeout: opts.timeoutMs,
    });

    if (opts.signal.aborted) {
      throw new AbortError('Smoke test aborted during page navigation');
    }

    if (opts.settleWaitMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          opts.signal.removeEventListener('abort', abortWait);
          resolve();
        }, opts.settleWaitMs);
        const abortWait = (): void => {
          clearTimeout(timer);
          reject(new AbortError('Smoke test aborted during settle window'));
        };
        opts.signal.addEventListener('abort', abortWait, { once: true });
      });
    }

    const httpStatus = response ? response.status() : 599;
    const hasNonEmptyRootDom = await page.evaluate(() => {
      const doc = (globalThis as unknown as { document?: { body?: { innerHTML?: string } } }).document;
      const html = doc?.body?.innerHTML ?? '';
      return html.trim().length > 0;
    });

    return {
      httpStatus,
      hasNonEmptyRootDom,
      consoleErrors,
      pageErrors,
    };
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
    await browser.close().catch(() => {});
  }
}

/**
 * Evaluates a `SmokeCheckProbeResult` against PRD §6.4 criteria:
 *   1. `httpStatus < 400`
 *   2. `hasNonEmptyRootDom === true`
 *   3. `pageErrors.length === 0 && consoleErrors.length === 0`
 */
export function evaluateSmokeProbe(probe: SmokeCheckProbeResult): {
  passed: boolean;
  consoleErrorCount: number;
  failureMessage: string | null;
} {
  const consoleErrorCount = probe.consoleErrors.length + probe.pageErrors.length;
  const reasons: string[] = [];

  if (probe.httpStatus >= 400) {
    reasons.push(`HTTP status ${probe.httpStatus} (expected < 400)`);
  }
  if (!probe.hasNonEmptyRootDom) {
    reasons.push('Empty root DOM node (document.body had no content)');
  }
  for (const err of probe.pageErrors) {
    reasons.push(`Uncaught pageerror: ${err}`);
  }
  for (const err of probe.consoleErrors) {
    reasons.push(`console.error: ${err}`);
  }

  if (reasons.length === 0) {
    return {
      passed: true,
      consoleErrorCount: 0,
      failureMessage: null,
    };
  }

  return {
    passed: false,
    consoleErrorCount,
    failureMessage: reasons.join('; ').slice(0, 500),
  };
}

/**
 * Executes the Phase 6 smoke test against `previewUrl`.
 * Returns a `SmokeTestRunSummary` (`PASSED`, `FAILED`, or `TIMED_OUT`).
 * Rethrows `AbortError` when cancelled via `opts.signal` so the worker's
 * superseding handler marks the deployment `SUPERSEDED` instead of `FAILED`.
 */
export async function runPlaywrightSmokeCheck(
  opts: RunSmokeCheckOptions,
): Promise<SmokeTestRunSummary> {
  const startMs = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS;
  const settleWaitMs = opts.settleWaitMs ?? DEFAULT_SETTLE_WAIT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  opts.onLog?.(
    'stdout',
    `[reapd] Running Playwright smoke check against ${opts.previewUrl}...`,
  );

  const probeFn = opts.probePage ?? probeWithPlaywrightChromium;

  try {
    const probe = await probeFn({
      previewUrl: opts.previewUrl,
      signal: combinedSignal,
      timeoutMs,
      settleWaitMs,
    });

    if (opts.signal?.aborted) {
      throw new AbortError('Smoke check aborted by caller signal');
    }

    const durationMs = Math.max(1, Date.now() - startMs);
    const evaluated = evaluateSmokeProbe(probe);

    if (evaluated.passed) {
      opts.onLog?.(
        'stdout',
        `[reapd] Smoke check PASSED in ${durationMs}ms (HTTP ${probe.httpStatus}, 0 console/page errors)`,
      );
      return {
        status: 'PASSED',
        durationMs,
        consoleErrorCount: 0,
        failureMessage: null,
      };
    }

    opts.onLog?.(
      'stderr',
      `[reapd] Smoke check FAILED in ${durationMs}ms: ${evaluated.failureMessage}`,
    );
    return {
      status: 'FAILED',
      durationMs,
      consoleErrorCount: evaluated.consoleErrorCount,
      failureMessage: evaluated.failureMessage,
    };
  } catch (err) {
    // Caller-initiated abort (supersede or worker shutdown) must propagate as AbortError
    if (opts.signal?.aborted) {
      throw new AbortError('Smoke check aborted via cancel signal');
    }

    const durationMs = Math.max(1, Date.now() - startMs);
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout =
      timeoutSignal.aborted || /timeout|timed out/i.test(msg);

    const status: TestRunStatus = isTimeout ? 'TIMED_OUT' : 'FAILED';
    const failureMessage = `Smoke check ${status === 'TIMED_OUT' ? 'timed out' : 'error'}: ${msg}`.slice(
      0,
      500,
    );

    opts.onLog?.('stderr', `[reapd] ${failureMessage}`);
    return {
      status,
      durationMs,
      consoleErrorCount: 0,
      failureMessage,
    };
  }
}

