// apps/worker/src/builder/git-clone.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneRepoAtSha, buildGitEnv } from './git-clone.js';
import { runProcess } from './run-process.js';
import { parseGenerationFromTag } from '../jobs/build.js';

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
      authToken: 'ghs_secret_test_token_12345',
      signal: ac.signal,
    });
    workDir = res.workDir;

    // Assert correct SHA was checked out
    assert.equal(res.resolvedSha, sha1);

    // Assert authToken is never persisted to .git/config on disk (issue #3),
    // neither in raw form nor base64-encoded.
    const gitConfig = await readFile(join(res.workDir, '.git', 'config'), 'utf8');
    const encoded = Buffer.from('x-access-token:ghs_secret_test_token_12345').toString('base64');
    assert.ok(
      !gitConfig.includes('ghs_secret_test_token_12345') && !gitConfig.includes(encoded),
      'authToken must not be written to .git/config'
    );

    // Assert buildGitEnv scopes the Authorization header strictly to https://github.com/
    const envWithToken = buildGitEnv('ghs_secret_test_token_12345');
    assert.equal(envWithToken['GIT_CONFIG_COUNT'], '2');
    assert.equal(envWithToken['GIT_CONFIG_KEY_1'], 'http.https://github.com/.extraHeader');
    assert.equal(envWithToken['GIT_CONFIG_VALUE_1'], `Authorization: Basic ${encoded}`);

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

test('parseGenerationFromTag extracts generation number from image tags', () => {
  assert.equal(parseGenerationFromTag('reapd-pr-104:g1-a1b2c3d'), 1);
  assert.equal(parseGenerationFromTag('reapd-pr-104:g42-deadbeef'), 42);
  assert.equal(parseGenerationFromTag('reapd-pr-104:a1b2c3d'), null);
});

test('runProcess rejects with timeout Error (not AbortError) when AbortSignal.timeout fires', async () => {
  const userController = new AbortController();
  const timeoutSignal = AbortSignal.timeout(50);
  const combined = AbortSignal.any([userController.signal, timeoutSignal]);

  await assert.rejects(
    () =>
      runProcess({
        cmd: 'node',
        args: ['-e', 'setTimeout(() => {}, 5000)'],
        cwd: tmpdir(),
        signal: combined,
        onLog: undefined,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.notEqual(err.name, 'AbortError', 'timeout must not be misclassified as AbortError');
      assert.match(err.message, /timed out/);
      return true;
    }
  );
});
