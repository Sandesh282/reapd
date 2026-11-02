// apps/worker/src/builder/git-clone.ts
// Ephemeral Git shallow clone at an exact commit SHA or ref.
// Supports AbortSignal cancellation (for commit superseding) and deterministic cleanup.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbortError } from '@reapd/docker-client';
import { runProcess } from './run-process.js';

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
    const gitEnv = {
      GIT_TERMINAL_PROMPT: '0',
      // Suppress GPG signing so a global commit.gpgsign=true doesn't hang tests
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'commit.gpgsign',
      GIT_CONFIG_VALUE_0: 'false',
    };

    const git = (args: string[]) =>
      runProcess({ cmd: 'git', args, cwd: workDir, env: gitEnv, signal: opts.signal, onLog: opts.onLog });

    await git(['init', '--quiet']);
    await git(['remote', 'add', 'origin', authenticatedUrl]);
    // '--' prevents a sha that starts with '-' from being parsed as a flag
    await git(['fetch', '--depth', '1', '--no-tags', 'origin', '--', opts.commitSha]);
    await git(['checkout', '--quiet', 'FETCH_HEAD']);

    let resolvedSha = '';
    await runProcess({
      cmd: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: workDir,
      env: gitEnv,
      signal: opts.signal,
      onLog: (_stream, line) => {
        if (line.trim().length === 40) resolvedSha = line.trim();
      },
    });

    if (!resolvedSha) {
      throw new Error(
        `Could not resolve HEAD SHA after checkout (commitSha=${opts.commitSha})`
      );
    }

    return { workDir, resolvedSha, cleanup };
  } catch (err) {
    await cleanup().catch(() => {/* best-effort: original error takes priority */});
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
