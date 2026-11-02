// apps/worker/src/builder/image-builder.ts
// Builds a Docker image from a checked-out directory using BuildKit (`DOCKER_BUILDKIT=1`),
// streaming stdout/stderr lines in real time and aborting immediately if superseded.

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { AbortError } from '@reapd/docker-client';
import { runProcess } from './run-process.js';

export interface BuildImageOptions {
  /** Absolute path to the cloned repository directory */
  contextDir: string;
  /** Optional relative subdirectory inside contextDir (default: '.') */
  subpath?: string;
  /** Target image tag, e.g. 'reapd-pr-104:a1b2c3d' */
  imageTag: string;
  /** Deployment ID applied as an image label for orphan reconciliation */
  deploymentId: string;
  /**
   * PR subdomain (e.g. 'pr-104') applied as `reapd.subdomain` label so the
   * reconciler and `reapd down` can locate the image even after the container
   * has been removed.
   */
  subdomain?: string;
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
 * Rejects with `AbortError` if `signal` aborts mid-build (waits for the subprocess to
 * exit cleanly before throwing so tmp directories are safe to remove).
 *
 * A hard 5-minute build timeout is layered on top of the caller-supplied signal via
 * `AbortSignal.any`. Individual build steps that hang (e.g. `RUN sleep infinity`) will
 * be killed after the deadline rather than blocking the worker indefinitely.
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

  // We shell out to the `docker` CLI rather than going through dockerode because
  // dockerode has no native BuildKit support — it speaks the old Image Build API
  // which doesn't support cache mounts, multi-stage progress, or the /grpc control
  // plane that BuildKit requires. The `docker` CLI must therefore be present on the
  // worker host (documented in infra/README.md and the Phase 7 worker Dockerfile).
  const args = [
    'build',
    '--progress=plain',
    '--tag',
    opts.imageTag,
    '--label',
    'reapd.managed=true',
    '--label',
    `reapd.deployment_id=${opts.deploymentId}`,
    ...(opts.subdomain ? ['--label', `reapd.subdomain=${opts.subdomain}`] : []),
    targetDir,
  ];

  // 5-minute hard cap: a stuck RUN step should never block the worker permanently
  const buildTimeout = AbortSignal.timeout(5 * 60 * 1000);
  const combined = AbortSignal.any([opts.signal, buildTimeout]);

  await runProcess({
    cmd: 'docker',
    args,
    cwd: targetDir,
    env: {
      DOCKER_BUILDKIT: '1',
      DOCKER_HOST: dockerHost,
    },
    signal: combined,
    onLog: opts.onLog,
  });

  return {
    imageTag: opts.imageTag,
    buildDurationMs: Date.now() - startedAt,
  };
}
