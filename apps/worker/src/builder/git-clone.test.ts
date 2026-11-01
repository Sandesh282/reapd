// apps/worker/src/builder/git-clone.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneRepoAtSha } from './git-clone.js';

test('shallow-clones an exact commit SHA and cleans up temporary directory', async () => {
  const originDir = await mkdtemp(join(tmpdir(), 'reapd-test-origin-'));

  try {
    execFileSync('git', ['init', '--quiet'], { cwd: originDir });
    execFileSync('git', ['config', 'user.email', 'test@reapd.local'], { cwd: originDir });
    execFileSync('git', ['config', 'user.name', 'reapd-test'], { cwd: originDir });
    // Allow fetching arbitrary reachable SHA1 in local test repo
    execFileSync('git', ['config', 'uploadpack.allowReachableSHA1InWant', 'true'], {
      cwd: originDir,
    });

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

    assert.equal(res.resolvedSha, sha1);
    const content = await readFile(join(res.workDir, 'version.txt'), 'utf8');
    assert.equal(content, 'v1');

    await res.cleanup();
  } finally {
    await rm(originDir, { recursive: true, force: true });
  }
});

