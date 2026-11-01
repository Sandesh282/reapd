// apps/worker/src/builder/git-clone.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneRepoAtSha } from './git-clone.js';

// Shared git env for test repos: suppress GPG signing and prompts
const testGitEnv = ['config', '--local'];
function initTestRepo(dir: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@reapd.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'reapd-test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  // Allow fetching arbitrary reachable SHA1 in local test repo
  execFileSync('git', ['config', 'uploadpack.allowReachableSHA1InWant', 'true'], { cwd: dir });
}

test('shallow-clones an exact commit SHA and cleans up temporary directory', async () => {
  const originDir = await mkdtemp(join(tmpdir(), 'reapd-test-origin-'));
  let workDir: string | undefined;

  try {
    initTestRepo(originDir);

    await writeFile(join(originDir, 'version.txt'), 'v1');
    execFileSync('git', ['add', 'version.txt'], { cwd: originDir });
    execFileSync('git', ['commit', '-m', 'first'], { cwd: originDir });
    const sha1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: originDir })
      .toString('utf8')
      .trim();

    await writeFile(join(originDir, 'version.txt'), 'v2');
    execFileSync('git', ['add', 'version.txt'], { cwd: originDir });
    execFileSync('git', ['commit', '-m', 'second'], { cwd: originDir });

    const ac = new AbortController();
    const res = await cloneRepoAtSha({
      repoUrl: originDir,
      commitSha: sha1,
      deploymentId: 'unit-test-1',
      signal: ac.signal,
    });
    workDir = res.workDir;

    // Assert correct SHA was checked out
    assert.equal(res.resolvedSha, sha1);

    // Assert we got v1 content, not HEAD (v2)
    const content = await readFile(join(res.workDir, 'version.txt'), 'utf8');
    assert.equal(content, 'v1');

    // Assert clone is shallow (exactly 1 commit in the history)
    const depth = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: res.workDir })
      .toString('utf8')
      .trim();
    assert.equal(depth, '1', 'expected a shallow clone with depth 1');

    // Cleanup and assert workdir is gone
    await res.cleanup();
    workDir = undefined;
    await assert.rejects(
      () => stat(res.workDir),
      { code: 'ENOENT' },
      'workDir should not exist after cleanup()'
    );
  } finally {
    // Prevent leaking originDir even if assertions fail mid-test
    await rm(originDir, { recursive: true, force: true });
    // Prevent leaking workDir if cleanup() was never called (test failure before cleanup)
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
});

test('throws AbortError if signal is already aborted before clone starts', async () => {
  const ac = new AbortController();
  ac.abort();

  await assert.rejects(
    () =>
      cloneRepoAtSha({
        repoUrl: '/nonexistent',
        commitSha: 'HEAD',
        deploymentId: 'unit-test-abort',
        signal: ac.signal,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'AbortError');
      return true;
    }
  );
});
