// apps/worker/src/builder/run-process.ts
// Shared subprocess helper used by git-clone.ts and image-builder.ts.
//
// Fixes two subtle bugs that arise when using spawn() directly:
//
//  1. Log fragmentation — Node 'data' events do not align with newlines.
//     A single log line can arrive split across two chunks, or one chunk can
//     contain many lines. We use readline's createInterface to buffer and emit
//     whole lines only, which is also UTF-8 safe.
//
//  2. Abort race — if we reject() the promise the instant signal fires, the
//     caller can invoke cleanup() (rm -rf workdir) while the child process is
//     still writing to its stdout/stderr pipe. On Linux/macOS this is mostly
//     harmless, but it surfaces as ENOENT errors and is technically UB.
//     We SIGTERM the child, wait for its 'close' event, and only then reject.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AbortError } from '@reapd/docker-client';

export type LogHandler = (stream: 'stdout' | 'stderr', line: string) => void;

export interface RunProcessOptions {
  /** Command to execute */
  cmd: string;
  /** Argument list */
  args: string[];
  /** Working directory */
  cwd: string;
  /** Environment variables (merged over process.env) */
  env?: Record<string, string>;
  /** Cancellation signal */
  signal: AbortSignal;
  /**
   * Called for each complete line of stdout or stderr output.
   * Pass `undefined` explicitly if you don't need log streaming.
   * Declared as `LogHandler | undefined` (not `onLog?`) so that
   * `exactOptionalPropertyTypes` doesn't reject spreading `opts.onLog`
   * when the caller's own `onLog` is optional.
   */
  onLog: LogHandler | undefined;
}

/**
 * Spawns a subprocess, streams its output line-by-line via `onLog`,
 * and resolves when the process exits with code 0.
 *
 * On abort: sends SIGTERM, waits for the process to close, then throws AbortError.
 * On non-zero exit: throws an Error with the last 2 KB of stderr.
 */
export function runProcess(opts: RunProcessOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) {
      return reject(new AbortError(`${opts.cmd} aborted before start`));
    }

    const child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // readline emits complete, UTF-8-correct lines — no fragmentation
    const rl = {
      stdout: createInterface({ input: child.stdout, crlfDelay: Infinity }),
      stderr: createInterface({ input: child.stderr, crlfDelay: Infinity }),
    };
    rl.stdout.on('line', (line) => opts.onLog?.('stdout', line));

    let stderrTail = '';
    rl.stderr.on('line', (line) => {
      stderrTail = (stderrTail + line + '\n').slice(-2048);
      opts.onLog?.('stderr', line);
    });

    let aborted = false;

    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      // We do NOT reject here — we wait for 'close' so the caller never
      // runs cleanup() while the child is still writing.
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      opts.signal.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code) => {
      opts.signal.removeEventListener('abort', onAbort);
      if (aborted) {
        return reject(new AbortError(`${opts.cmd} aborted by signal`));
      }
      if (code !== 0) {
        return reject(
          new Error(
            `${opts.cmd} ${opts.args[0]} exited with code ${code}: ${stderrTail.trim()}`
          )
        );
      }
      resolve();
    });
  });
}
