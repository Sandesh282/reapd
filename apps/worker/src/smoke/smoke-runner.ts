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
//   - Best-effort SSRF / loopback request guard (`context.route` + `isAllowedSmokeRequestUrl`,
//     defense in depth): allows the preview's own origin (`scheme + host + port`) and external
//     public assets (fonts/CDNs), while aborting requests to any other `localhost` / `*.localhost`
//     origin, single-label or `.internal`/`.lan` hostnames, non-443/80 ports on the preview
//     hostname (e.g. `http://pr-1.preview.localhost:3001`), or private/loopback IPv4/IPv6 literals
//     (including hex-serialized IPv4-mapped IPv6 `[::ffff:7f00:1]`). Note: hostname-based filtering
//     cannot block WebSockets or static/rebound DNS records resolving to `127.0.0.1` (e.g. `nip.io`);
//     OS-level network isolation in Phase 7 is the authoritative boundary.
//   - Conditional `--no-sandbox`: enabled only when running as root (`process.getuid?.() === 0`)
//     or when `REAPD_CHROMIUM_NO_SANDBOX=1` is explicitly set.

import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
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
    onLog?: (stream: 'stdout' | 'stderr', line: string) => void;
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

function isPrivateV4Octets(a: number, b: number, _c: number, _d: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateOrLoopbackIp(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const ver = isIP(bare);
  if (ver === 4) {
    const [a = 0, b = 0, c = 0, d = 0] = bare.split('.').map(Number);
    return isPrivateV4Octets(a, b, c, d);
  }
  if (ver === 6) {
    const lower = bare.toLowerCase();
    if (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      /^fe[89ab][0-9a-f]:/.test(lower)
    ) {
      return true;
    }
    // WHATWG URL serializes IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`) as hex groups (`::ffff:7f00:1`)
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1]!, 16);
      const lo = parseInt(hexMapped[2]!, 16);
      return isPrivateV4Octets((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff);
    }
    const dottedMapped = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
    if (dottedMapped) {
      return isPrivateV4Octets(
        Number(dottedMapped[1]),
        Number(dottedMapped[2]),
        Number(dottedMapped[3]),
        Number(dottedMapped[4]),
      );
    }
    return false;
  }
  return false;
}

/**
 * Pure request-policy helper for the Playwright smoke context (defense in depth):
 *   - Allows `data:`, `blob:`, and `about:` URLs
 *   - Allows requests whose full `origin` (`protocol + host + port`) matches `previewOrigin`
 *   - Blocks any other `localhost` / `*.localhost` / `.local` / `.internal` / `.lan` or single-label hostname
 *     (including `http://pr-1.preview.localhost:3001`, `host.docker.internal`, `redis`, `postgres`)
 *   - Blocks loopback, RFC1918, CGNAT, and link-local IPv4/IPv6 literals (`127.0.0.1`, `[::1]`, `[::ffff:127.0.0.1]`, `fe80::/10`, etc.)
 *   - Allows public HTTPS/HTTP subresources (Google Fonts, CDNs, images) so real apps don't fail smoke checks
 */
export function isAllowedSmokeRequestUrl(reqUrl: string, previewOrigin: string): boolean {
  if (
    reqUrl.startsWith('data:') ||
    reqUrl.startsWith('blob:') ||
    reqUrl.startsWith('about:')
  ) {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(reqUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  if (parsed.origin.toLowerCase() === previewOrigin.toLowerCase()) {
    return true;
  }
  const host = parsed.hostname.toLowerCase();
  const isIpv6Literal = host.startsWith('[') && host.endsWith(']');
  if (
    (!isIpv6Literal && !host.includes('.')) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    isPrivateOrLoopbackIp(host)
  ) {
    return false;
  }
  return true;
}

/**
 * Determines whether a smoke test status should fail the deployment and trigger rollback.
 * When `smokeRequired` is true (`REAPD_SMOKE_REQUIRED=1`), `SKIPPED` also fails closed.
 */
export function shouldFailSmoke(
  status: TestRunStatus,
  smokeRequired: boolean = process.env['REAPD_SMOKE_REQUIRED'] === '1',
): boolean {
  return (
    status === 'FAILED' ||
    status === 'TIMED_OUT' ||
    (smokeRequired && status === 'SKIPPED')
  );
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
  onLog?: (stream: 'stdout' | 'stderr', line: string) => void;
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

    const expectedOrigin = new URL(opts.previewUrl).origin.toLowerCase();
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block',
    });
    const page = await context.newPage();

    // Block loopback / private-IP SSRF requests initiated by any page or popup in the context
    const loggedBlockedOrigins = new Set<string>();
    await context.route('**/*', async (route) => {
      const reqUrl = route.request().url();
      try {
        if (isAllowedSmokeRequestUrl(reqUrl, expectedOrigin)) {
          await route.continue();
        } else {
          try {
            const blockedOrigin = new URL(reqUrl).origin;
            if (!loggedBlockedOrigins.has(blockedOrigin)) {
              loggedBlockedOrigins.add(blockedOrigin);
              opts.onLog?.(
                'stdout',
                `[reapd] Smoke check blocked request to ${sanitizeSmokeErrorText(blockedOrigin, 120)}`,
              );
            }
          } catch {
            // ignore URL parse error on log
          }
          await route.abort('blockedbyclient');
        }
      } catch {
        // Ignore errors when the browser/context is closing on abort
      }
    });

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Ignore Chromium's synthetic network error emitted when context.route aborts a blocked request
        if (text.includes('ERR_BLOCKED_BY_CLIENT')) {
          return;
        }
        consoleErrors.push(sanitizeSmokeErrorText(text));
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
      ...(opts.onLog ? { onLog: opts.onLog } : {}),
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
