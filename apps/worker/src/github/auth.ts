// apps/worker/src/github/auth.ts
// Mints a short-lived GitHub App installation access token using Node's native crypto.
// Zero external dependencies (RS256 JWT + GitHub REST API).

import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../');

export interface MintInstallationTokenOptions {
  installationId: number;
  /** Repository name (e.g. "reapd") to scope the installation token to */
  repoName: string;
  signal?: AbortSignal;
}

/**
 * Mints a read-only, single-repo installation access token for `installationId`
 * if `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY_PATH` (or `GITHUB_PRIVATE_KEY`) are configured.
 * Returns `undefined` when credentials are not configured (e.g. local smoke test).
 */
export async function getInstallationToken(
  opts: MintInstallationTokenOptions
): Promise<string | undefined> {
  const appId = process.env['GITHUB_APP_ID'];
  const keyPath = process.env['GITHUB_PRIVATE_KEY_PATH'];
  const inlineKey = process.env['GITHUB_PRIVATE_KEY'];

  if (!appId || (!keyPath && !inlineKey) || opts.installationId <= 0) {
    return undefined;
  }

  const resolvedKeyPath =
    keyPath && !isAbsolute(keyPath) ? resolve(REPO_ROOT, keyPath) : keyPath;

  const privateKeyPem = inlineKey
    ? inlineKey.replace(/\\n/g, '\n')
    : await readFile(resolvedKeyPath!, 'utf8');

  const jwt = signGitHubAppJwt(appId, privateKeyPem);

  const timeoutSignal = AbortSignal.timeout(10_000);
  const combinedSignal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(
    `https://api.github.com/app/installations/${opts.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'reapd-worker',
      },
      body: JSON.stringify({
        repositories: [opts.repoName],
        permissions: { contents: 'read' },
      }),
      signal: combinedSignal,
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Failed to mint GitHub installation token (HTTP ${response.status}): ${body.slice(0, 200)}`
    );
  }

  const data = (await response.json()) as { token?: string };
  if (!data.token) {
    throw new Error('GitHub installation token response did not contain a token');
  }

  return data.token;
}

function signGitHubAppJwt(appId: string, privateKeyPem: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iat: nowSec - 60, // 60s clock drift allowance
      exp: nowSec + 9 * 60, // 9 minutes (max allowed by GitHub is 10m)
      iss: appId,
    })
  );

  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();

  const signature = signer.sign(privateKeyPem, 'base64url');
  return `${signingInput}.${signature}`;
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str, 'utf8').toString('base64url');
}
