// apps/worker/src/smoke/smoke-runner.ts
// Phase 6 Playwright Smoke Runner (PRD §6.4).
//
// Navigates to the preview URL during the `TESTING` state and verifies:
//   1. HTTP response status < 400
//   2. Non-empty rendered root DOM (`innerText.trim().length > 0` or rendered visual media
//      element `img|canvas|svg|video|iframe`, so a blank SPA shell with only `<div id="root"></div><script>`
//      fails as intended)
//   3. Zero uncaught `pageerror` exceptions and zero `console.error` events
//
// Design invariants:
//   - Secret redaction BEFORE truncation (`redactSecrets` on every console/page error and exception
//     message before slicing to 200 chars and joining to 500 chars) so page-logged tokens can never
//     leak into `test_runs.failure_message`, `deployments.failure_reason`, or the unauthenticated API.
//   - Graceful `SKIPPED` handling via `SmokeUnavailableError`: if no Chromium binary is installed
//     on the host (or `chromium.launch` fails before any page navigation), the smoke check records
//     `status: 'SKIPPED'` rather than failing the user's deployment. Provision Chromium via
//     `npx playwright install chromium` or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.
//   - SSRF / loopback request guard (`page.route('**/*', ...)`): aborts any subresource or fetch
//     request targeting a hostname other than the preview's own hostname so PR-authored JS cannot
//     probe loopback control-plane services (`127.0.0.1:3001`, Postgres, Redis, socket-proxy).
//   - Conditional `--no-sandbox`: enabled only when running as root (`process.getuid?.() === 0`)
//     or when `REAPD_CHROMIUM_NO_SANDBOX=1` is explicitly set.

import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { AbortError } from '@reapd/docker-client';
import type { TestRunStatus } from '@reapd/types';
import { redactSecrets } from '../logs/log-sink.js';

export class SmokeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmokeUnavailableError';
  }
}

export interface SmokeCheckProbeResult {
  httpStatus: number;
  /** Rendered visible text (`document.body.innerText`) or fallback text content */
  renderedText: string;
  /** Whether the body contains a visual media/canvas element (`img,canvas,svg,video,iframe`) */
  hasVisualElement: boolean;
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
const DEFAULT_SETTLE_WAIT_MS = 350;
const BROWSER_CLOSE_TIMEOUT_MS = 3_000;
const PER_ERROR_MAX_CHARS = 200;
const FAILURE_MESSAGE_MAX_CHARS = 500;

const SYSTEM_CHROMIUM_CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

/** Redacts secrets BEFORE truncating a single error string to `maxChars`. */
export function sanitizeSmokeErrorText(raw: string, maxChars: number = PER_ERROR_MAX_CHARS): string {
  const redacted = redactSecrets(raw).replace(/\s+/g, ' ').trim();
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}...`;
}

/** Resolves a Chromium/Chrome executable path (Playwright bundled or system-installed). */
export function resolveChromiumExecutablePath(): string | undefined {
  const fromEnv = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']?.trim();
  if (fromEnv) {
    if (existsSync(fromEnv)) return fromEnv;
    return undefined;
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

/** Bounds `browser.close()` with a 3s timer so a wedged Chromium process never hangs the worker. */
async function closeBrowserBounded(browser: Browser): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      browser.close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // ignore close errors
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Default Playwright Chromium page probe:
 *   - Throws `SmokeUnavailableError` if no Chromium executable exists or `chromium.launch` fails
 *   - Uses `--host-resolver-rules=MAP *.localhost 127.0.0.1`
 *   - Enforces same-host request policy via `page.route` so preview JS cannot
 *     issue requests to loopback control-plane ports (`127.0.0.1:3001`, etc.)
 *   - Waits for `load` + `settleWaitMs` so React/SPA hydration errors are captured
 *   - Evaluates rendered `innerText` and visual media elements rather than raw `<script>` markup
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
  if (!executablePath) {
    throw new SmokeUnavailableError(
      'No Chromium executable found (install via `npx playwright install chromium` or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)',
    );
  }

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const forceNoSandbox = process.env['REAPD_CHROMIUM_NO_SANDBOX'] === '1' || isRoot;
  const launchArgs = [
    '--disable-dev-shm-usage',
    '--host-resolver-rules=MAP *.localhost 127.0.0.1',
    ...(forceNoSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
  ];

  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: launchArgs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SmokeUnavailableError(`Failed to launch Chromium: ${sanitizeSmokeErrorText(msg)}`);
  }

  const onAbort = (): void => {
    void closeBrowserBounded(browser);
  };
  opts.signal.addEventListener('abort', onAbort, { once: true });

  try {
    if (opts.signal.aborted) {
      throw new AbortError('Smoke test aborted after browser launch');
    }

    const expectedHost = new URL(opts.previewUrl).hostname.toLowerCase();
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    // Block cross-host / loopback SSRF requests initiated by preview page scripts
    await page.route('**/*', async (route) => {
      const reqUrl = route.request().url();
      if (reqUrl.startsWith('data:') || reqUrl.startsWith('blob:') || reqUrl.startsWith('about:')) {
        await route.continue();
        return;
      }
      try {
        const parsed = new URL(reqUrl);
        if (parsed.hostname.toLowerCase() === expectedHost) {
          await route.continue();
          return;
        }
      } catch {
        // fall through to abort
      }
      await route.abort('blockedbyclient');
    });

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(sanitizeSmokeErrorText(msg.text()));
      }
    });

    page.on('pageerror', (err) => {
      pageErrors.push(sanitizeSmokeErrorText(err.message || String(err)));
    });

    const response = await page.goto(opts.previewUrl, {
      waitUntil: 'load',
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
    const domSnapshot = await page.evaluate(() => {
      const doc = (
        globalThis as unknown as {
          document?: {
            body?: {
              innerText?: string;
              querySelector?: (sel: string) => unknown;
            };
          };
        }
      ).document;
      const body = doc?.body;
      const renderedText = (body?.innerText ?? '').trim();
      const hasVisualElement = Boolean(
        body?.querySelector?.('img,canvas,svg,video,iframe'),
      );
      return { renderedText, hasVisualElement };
    });

    return {
      httpStatus,
      renderedText: domSnapshot.renderedText,
      hasVisualElement: domSnapshot.hasVisualElement,
      consoleErrors,
      pageErrors,
    };
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
    await closeBrowserBounded(browser);
  }
}

/**
 * Evaluates a `SmokeCheckProbeResult` against PRD §6.4 criteria:
 *   1. `httpStatus < 400`
 *   2. Rendered content present (`renderedText.trim().length > 0 || hasVisualElement === true`)
 *   3. `pageErrors.length === 0 && consoleErrors.length === 0`
 *
 * All error messages are redacted BEFORE per-item and total truncation.
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
  const hasRenderedContent =
    probe.renderedText.trim().length > 0 || probe.hasVisualElement;
  if (!hasRenderedContent) {
    reasons.push('Empty rendered root DOM (document.body had no visible text or media)');
  }
  for (const err of probe.pageErrors) {
    reasons.push(`Uncaught pageerror: ${sanitizeSmokeErrorText(err)}`);
  }
  for (const err of probe.consoleErrors) {
    reasons.push(`console.error: ${sanitizeSmokeErrorText(err)}`);
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
    failureMessage: reasons.join('; ').slice(0, FAILURE_MESSAGE_MAX_CHARS),
  };
}

/**
 * Executes the Phase 6 smoke test against `previewUrl`.
 * Returns a `SmokeTestRunSummary` (`PASSED`, `FAILED`, `TIMED_OUT`, or `SKIPPED`).
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

    if (err instanceof SmokeUnavailableError) {
      const skipMsg = sanitizeSmokeErrorText(err.message, FAILURE_MESSAGE_MAX_CHARS);
      opts.onLog?.('stdout', `[reapd] Smoke check SKIPPED: ${skipMsg}`);
      return {
        status: 'SKIPPED',
        durationMs,
        consoleErrorCount: 0,
        failureMessage: skipMsg,
      };
    }

    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitizedMsg = sanitizeSmokeErrorText(rawMsg, 400);
    const isTimeout =
      timeoutSignal.aborted || /timeout|timed out/i.test(rawMsg);

    const status: TestRunStatus = isTimeout ? 'TIMED_OUT' : 'FAILED';
    const failureMessage = `Smoke check ${status === 'TIMED_OUT' ? 'timed out' : 'error'}: ${sanitizedMsg}`.slice(
      0,
      FAILURE_MESSAGE_MAX_CHARS,
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
