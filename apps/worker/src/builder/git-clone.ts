// apps/worker/src/builder/git-clone.ts
// Ephemeral Git shallow clone at an exact commit SHA or ref.
// Supports AbortSignal cancellation (for commit superseding) and deterministic cleanup.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbortError } from '@reapd/docker-client';

export interface CloneRepoOptions {
  /** Repository URL or local git path */
  repoUrl: string;
  /** Exact 40-char commit SHA (or ref/branch for local testing) */
  commitSha: string;
  /** Unique deployment identifier used to namespace the temp folder */
  deploymentId: string;
  /** Optional GitHub installation token for private repos */
  authToken?: string;
  /** Cancellation signal */
  signal: AbortSignal;
  /** Optional callback for streaming stdout/stderr lines */
  onLog?: (stream: 'stdout' | 'stderr', line: string) => void;
}

export interface CloneResult {
  workDir: string;
  resolvedSha: string;
  cleanup: () => Promise<void>;
}

/**
 * Shallow-clones `repoUrl` at `commitSha` into `/tmp/reapd-build-<deploymentId>-XXXX`.
 * Uses `git init` + `git remote add origin` + `git fetch --depth 1 origin <sha>` + `git checkout FETCH_HEAD`
 * so only the exact commit tree is transferred over the wire.
 */
export async function cloneRepoAtSha(opts: CloneRepoOptions): Promise<CloneResult> {
  if (opts.signal.aborted) {
    throw new AbortError('Git clone aborted before start');
  }

  const workDir = await mkdtemp(join(tmpdir(), `reapd-build-${opts.deploymentId}-`));

  const cleanup = async (): Promise<void> => {
    await rm(workDir, { recursive: true, force: true });
  };

  try {
    const authenticatedUrl = injectTokenIfPresent(opts.repoUrl, opts.authToken);

    await runGit(['init', '--quiet'], workDir, opts.signal, opts.onLog);
    await runGit(['remote', 'add', 'origin', authenticatedUrl], workDir, opts.signal, opts.onLog);
    await runGit(
      ['fetch', '--depth', '1', '--no-tags', 'origin', opts.commitSha],
      workDir,
      opts.signal,
      opts.onLog
    );
    await runGit(['checkout', '--quiet', 'FETCH_HEAD'], workDir, opts.signal, opts.onLog);

    let resolvedSha = '';
    await runGit(['rev-parse', 'HEAD'], workDir, opts.signal, (stream, line) => {
      if (stream === 'stdout' && line.trim().length === 40) {
        resolvedSha = line.trim();
      }
    });

    return {
      workDir,
      resolvedSha: resolvedSha || opts.commitSha,
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

function injectTokenIfPresent(repoUrl: string, token?: string): string {
  if (!token) return repoUrl;
  try {
    const parsed = new URL(repoUrl);
    if (parsed.protocol === 'https:') {
      parsed.username = 'x-access-token';
      parsed.password = token;
      return parsed.toString();
    }
  } catch {
    // Local file path or SCP-style git URL — leave untouched
  }
  return repoUrl;
}

function runGit(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onLog?: (stream: 'stdout' | 'stderr', line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      return reject(new AbortError('Git command aborted'));
    }

    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onAbort = () => {
      child.kill('SIGTERM');
      reject(new AbortError('Git command aborted by signal'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    let stderrBuf = '';

    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        const trimmed = line.trimEnd();
        if (trimmed) onLog?.('stdout', trimmed);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrBuf += text;
      for (const line of text.split('\n')) {
        const trimmed = line.trimEnd();
        if (trimmed) onLog?.('stderr', trimmed);
      }
    });

    child.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        return reject(new AbortError('Git command aborted'));
      }
      if (code !== 0) {
        return reject(
          new Error(`git ${args[0]} exited with code ${code}: ${stderrBuf.trim()}`)
        );
      }
      resolve();
    });
  });
}

