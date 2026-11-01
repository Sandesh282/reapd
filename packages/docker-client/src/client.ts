// packages/docker-client/src/client.ts
// Hardened dockerode wrapper.
// All container operations in reapd go through this client — never raw dockerode.

import Dockerode from 'dockerode';
import * as https from 'node:https';
import * as http from 'node:http';
import { lookup as dnsLookup } from 'node:dns';

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

  let lastError = 'no response';

  while (Date.now() < deadline) {
    if (signal.aborted) throw new AbortError('Health-check aborted: deployment superseded');

    try {
      // Bound each attempt to 2s so a half-open connection can't outlive the deadline
      const status = await probeHttpStatus(internalUrl, signal, 2_000);
      // Note: Traefik returns 404 while its Docker provider is still discovering
      // the newly started container (or 502 while the container port is booting).
      if (status >= 200 && status < 500 && status !== 404) return;
      lastError = `HTTP ${status}`;
    } catch (err: unknown) {
      if (signal.aborted) throw new AbortError('Health-check aborted: deployment superseded');
      // Surface TLS certificate chain errors immediately instead of silently retrying for 30s
      const code = (err as { code?: string })?.code;
      if (
        code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        code === 'SELF_SIGNED_CERT_IN_CHAIN'
      ) {
        throw new Error(
          `TLS verification failed for ${internalUrl} (${code}). Set NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" for local mkcert TLS.`
        );
      }
      lastError = code ?? (err instanceof Error ? err.message : String(err));
      // Connection refused / attempt timeout — container not ready yet
    }

    await sleep(delay, signal);
    delay = Math.min(delay * 2, 4_000); // cap at 4s between retries
  }

  throw new Error(
    `Health-check timed out after ${maxWait}ms: ${internalUrl} (last error: ${lastError})`
  );
}

/**
 * Force-removes a container and its anonymous volumes.
 * Safe to call on a stopped or non-existent container.
 */
export async function forceRemoveContainer(
  docker: Dockerode,
  containerIdOrName: string
): Promise<void> {
  try {
    const container = docker.getContainer(containerIdOrName);
    await container.remove({ force: true, v: true });
  } catch (err: unknown) {
    // 404 means already removed — not an error
    if (isDockerNotFoundError(err)) return;
    throw err;
  }
}

/**
 * Removes an image tag from the Docker host.
 * Safe to call on a non-existent image (404 is ignored).
 */
export async function removeImage(
  docker: Dockerode,
  imageTag: string,
  opts?: { force?: boolean }
): Promise<void> {
  try {
    const img = docker.getImage(imageTag);
    await img.remove({ force: opts?.force ?? true, noprune: false });
  } catch (err: unknown) {
    if (isDockerNotFoundError(err)) return;
    throw err;
  }
}

export interface ManagedContainerSummary {
  id: string;
  name: string;
  subdomain: string;
  deploymentId: string;
  image: string;
  state: string;
  status: string;
}

/**
 * Lists all preview containers managed by reapd (`reapd.managed=true`).
 */
export async function listManagedContainers(
  docker: Dockerode
): Promise<ManagedContainerSummary[]> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: ['reapd.managed=true'] },
  });

  return containers.map((c) => {
    const rawName = c.Names[0] ?? '';
    return {
      id: c.Id,
      name: rawName.startsWith('/') ? rawName.slice(1) : rawName,
      subdomain: c.Labels['reapd.subdomain'] ?? '',
      deploymentId: c.Labels['reapd.deployment_id'] ?? '',
      image: c.Image,
      state: c.State,
      status: c.Status,
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Performs an HTTP(S) GET probe with RFC 6761 `*.localhost` → `127.0.0.1` resolution
 * (macOS `getaddrinfo` does not resolve `*.preview.localhost` in Node by default,
 * whereas `curl` and browsers have built-in RFC 6761 special-use domain handling).
 */
function probeHttpStatus(
  targetUrl: string,
  signal: AbortSignal,
  timeoutMs: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const requestFn = isHttps ? https.request : http.request;

    const req = requestFn(
      parsed,
      {
        method: 'GET',
        timeout: timeoutMs,
        signal,
        lookup: (hostname, options, cb) => {
          if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
            if (typeof options === 'object' && options !== null && options.all) {
              cb(null, [{ address: '127.0.0.1', family: 4 }]);
            } else {
              cb(null, '127.0.0.1', 4);
            }
            return;
          }
          dnsLookup(hostname, options, cb);
        },
      },
      (res) => {
        res.resume(); // drain response body
        resolve(res.statusCode ?? 0);
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('ETIMEDOUT'));
    });

    req.on('error', reject);
    req.end();
  });
}

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

