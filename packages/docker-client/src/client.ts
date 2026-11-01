// packages/docker-client/src/client.ts
// Hardened dockerode wrapper.
// All container operations in reapd go through this client — never raw dockerode.

import Dockerode from 'dockerode';

// ── Constants ─────────────────────────────────────────────────────────────────

/** 512 MB in bytes */
const MEMORY_LIMIT = 536_870_912;

/** 0.5 vCPU in nanocpus */
const NANO_CPU_LIMIT = 500_000_000;

/** Max processes/threads per container (prevents fork bombs) */
const PIDS_LIMIT = 100;

/** Max Docker JSON log file size per container */
const LOG_MAX_SIZE = '10m';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CreatePreviewContainerOptions {
  deploymentId: string;
  imageTag: string;
  subdomain: string;
  /** Internal port the application listens on (default: 3000) */
  appPort?: number;
  /** Environment variables to inject */
  env?: Record<string, string>;
}

export interface ContainerInfo {
  id: string;
  name: string;
  subdomain: string;
}

// ── Client factory ────────────────────────────────────────────────────────────

/**
 * Creates a dockerode client connected to the Docker Socket Proxy.
 * In development: connects to the proxy running in docker-compose.
 * In production: same, but the proxy is network-restricted to the control plane.
 */
export function createDockerClient(options?: {
  host?: string;
  port?: number;
}): Dockerode {
  return new Dockerode({
    host: options?.host ?? process.env['DOCKER_PROXY_HOST'] ?? '127.0.0.1',
    port: options?.port ?? Number(process.env['DOCKER_PROXY_PORT'] ?? 2375),
    protocol: 'http',
  });
}

// ── Container lifecycle ───────────────────────────────────────────────────────

/**
 * Creates and starts a hardened preview container with Traefik routing labels
 * and mandatory resource constraints (PRD v2.2 §7 security table).
 *
 * The container is attached to `preview-edge` network only — never the default
 * bridge or the control-internal network.
 */
export async function createPreviewContainer(
  docker: Dockerode,
  opts: CreatePreviewContainerOptions
): Promise<ContainerInfo> {
  const appPort = opts.appPort ?? 3000;
  const containerName = `reapd-${opts.subdomain}`; // subdomain is the bare label, e.g. "pr-104"
  const traefikRouter = opts.subdomain; // e.g. "pr-104"

  const envArray = Object.entries(opts.env ?? {}).map(
    ([k, v]) => `${k}=${v}`
  );

  const container = await docker.createContainer({
    name: containerName,
    Image: opts.imageTag,
    Env: envArray,
    // Traefik discovers this container via these labels
    Labels: {
      'reapd.managed': 'true',
      'reapd.deployment_id': opts.deploymentId,
      'reapd.subdomain': opts.subdomain,
      'traefik.enable': 'true',
      [`traefik.http.routers.${traefikRouter}.rule`]:
        `Host(\`${opts.subdomain}.preview.localhost\`)`,
      [`traefik.http.routers.${traefikRouter}.entrypoints`]: 'websecure',
      [`traefik.http.routers.${traefikRouter}.tls`]: 'true',
      [`traefik.http.services.${traefikRouter}.loadbalancer.server.port`]:
        String(appPort),
    },
    HostConfig: {
      // ── Resource constraints (PRD v2.2 §7) ────────────────────────────
      Memory: MEMORY_LIMIT,
      MemorySwap: MEMORY_LIMIT,    // swap = memory → zero disk thrashing
      NanoCpus: NANO_CPU_LIMIT,
      PidsLimit: PIDS_LIMIT,
      // ── Capability hardening ───────────────────────────────────────────
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      // ── Log driver ────────────────────────────────────────────────────
      LogConfig: {
        Type: 'json-file',
        // compress must be off: Docker rejects compression with max-file=1
        Config: { 'max-size': LOG_MAX_SIZE, 'max-file': '1', compress: 'false' },
      },
      // ── Network isolation ──────────────────────────────────────────────
      // Only attached to preview-edge — never default bridge or control-internal
      NetworkMode: 'reapd-preview-edge',
    },
    NetworkingConfig: {
      EndpointsConfig: {
        'reapd-preview-edge': {},
      },
    },
  });

  await container.start();

  return {
    id: container.id,
    name: containerName,
    subdomain: opts.subdomain,
  };
}

/**
 * Polls a container's HTTP health endpoint with exponential backoff.
 * Used in the STARTING phase before transitioning to TESTING.
 *
 * @param containerId  Docker container ID
 * @param internalUrl  URL to poll (e.g. http://container-ip:3000/health)
 * @param signal       AbortSignal — throws AbortError if superseded
 */
export async function pollUntilHealthy(
  internalUrl: string,
  signal: AbortSignal,
  opts?: { maxWaitMs?: number; initialDelayMs?: number }
): Promise<void> {
  const maxWait = opts?.maxWaitMs ?? 30_000;
  let delay = opts?.initialDelayMs ?? 250;
  const deadline = Date.now() + maxWait;

  while (Date.now() < deadline) {
    if (signal.aborted) throw new AbortError('Health-check aborted: deployment superseded');

    try {
      // Bound each attempt to 2s so a half-open connection can't outlive the deadline
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(2_000)]);
      const res = await fetch(internalUrl, { signal: attemptSignal });
      if (res.ok || res.status < 500) return; // container is responding
    } catch {
      if (signal.aborted) throw new AbortError('Health-check aborted: deployment superseded');
      // Connection refused / attempt timeout — container not ready yet
    }

    await sleep(delay, signal);
    delay = Math.min(delay * 2, 4_000); // cap at 4s between retries
  }

  throw new Error(`Health-check timed out after ${maxWait}ms: ${internalUrl}`);
}

/**
 * Force-removes a container and its anonymous volumes.
 * Safe to call on a stopped or non-existent container.
 */
export async function forceRemoveContainer(
  docker: Dockerode,
  containerId: string
): Promise<void> {
  try {
    const container = docker.getContainer(containerId);
    await container.remove({ force: true, v: true });
  } catch (err: unknown) {
    // 404 means already removed — not an error
    if (isDockerNotFoundError(err)) return;
    throw err;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError('Sleep interrupted'));

    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError('Sleep interrupted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort); // don't leak a listener per poll
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isDockerNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    (err as { statusCode: number }).statusCode === 404
  );
}

export class AbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbortError';
  }
}

