// apps/worker/src/builder/image-builder.ts
// Builds a Docker image from a checked-out directory using BuildKit (`DOCKER_BUILDKIT=1`),
// streaming stdout/stderr lines in real time and aborting immediately if superseded.

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { AbortError } from '@reapd/docker-client';

export interface BuildImageOptions {
  /** Absolute path to the cloned repository directory */
  contextDir: string;
  /** Optional relative subdirectory inside contextDir (default: '.') */
  subpath?: string;
  /** Target image tag, e.g. 'reapd-pr-104:a1b2c3d' */
  imageTag: string;
  /** Deployment ID applied as an image label for orphan reconciliation */
  deploymentId: string;
  /** Cancellation signal */
  signal: AbortSignal;
  /** Callback invoked for every build log line */
  onLog?: (stream: 'stdout' | 'stderr', line: string) => void;
}

export interface BuildImageResult {
  imageTag: string;
  buildDurationMs: number;
}

/**
 * Invokes `docker build` with BuildKit enabled (`--progress=plain`) against `contextDir`.
 * Rejects with `AbortError` if `signal` aborts mid-build and kills the subprocess.
 */
export async function buildDockerImage(
  opts: BuildImageOptions
): Promise<BuildImageResult> {
  if (opts.signal.aborted) {
    throw new AbortError('Image build aborted before start');
  }

  const targetDir = opts.subpath ? join(opts.contextDir, opts.subpath) : opts.contextDir;
  const dockerfilePath = join(targetDir, 'Dockerfile');

  try {
    await access(dockerfilePath);
  } catch {
    throw new Error(`No Dockerfile found at ${dockerfilePath}`);
  }

  const startedAt = Date.now();
  const dockerHost =
    process.env['DOCKER_HOST'] ??
    `tcp://${process.env['DOCKER_PROXY_HOST'] ?? '127.0.0.1'}:${process.env['DOCKER_PROXY_PORT'] ?? '2375'}`;

  const args = [
    'build',
    '--progress=plain',
    '--tag',
    opts.imageTag,
    '--label',
    'reapd.managed=true',
    '--label',
    `reapd.deployment_id=${opts.deploymentId}`,
    targetDir,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', args, {
      cwd: targetDir,
      env: {
        ...process.env,
        DOCKER_BUILDKIT: '1',
        DOCKER_HOST: dockerHost,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onAbort = () => {
      child.kill('SIGTERM');
      reject(new AbortError('BuildKit process aborted by signal'));
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    let stderrTail = '';

    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        const trimmed = line.trimEnd();
        if (trimmed) opts.onLog?.('stdout', trimmed);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-2000);
      // BuildKit writes normal build progress to stderr with --progress=plain
      for (const line of text.split('\n')) {
        const trimmed = line.trimEnd();
        if (trimmed) opts.onLog?.('stdout', trimmed);
      }
    });

    child.on('error', (err) => {
      opts.signal.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code) => {
      opts.signal.removeEventListener('abort', onAbort);
      if (opts.signal.aborted) {
        return reject(new AbortError('BuildKit process aborted'));
      }
      if (code !== 0) {
        return reject(
          new Error(`Docker build failed (exit ${code}): ${stderrTail.trim()}`)
        );
      }
      resolve();
    });
  });

  return {
    imageTag: opts.imageTag,
    buildDurationMs: Date.now() - startedAt,
  };
}

