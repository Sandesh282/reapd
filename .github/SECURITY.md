# Security Policy & Threat Model

`reapd` is a self-hosted ephemeral PR preview environment orchestrator that builds and runs Docker containers from Git commits.

## Architectural Security Boundaries (v1)

1. **Docker Socket Proxy Isolation:** The orchestrator worker never mounts `/var/run/docker.sock` directly. All Docker Engine operations traverse `tecnativa/docker-socket-proxy` with `PRIVILEGED=0`, `HOST=0`, `EXEC=0`, `VOLUMES=0`, and `SWARM=0`.
2. **Container Capability & Resource Hardening:** Every preview container is spawned with:
   - `Memory = 512 MB` and `MemorySwap = 512 MB` (zero swap thrashing)
   - `NanoCpus = 0.5 vCPU`
   - `PidsLimit = 100` (fork-bomb containment)
   - `CapDrop = ['ALL']` and `SecurityOpt = ['no-new-privileges:true']`
   - `Runtime = runsc` (gVisor in production, Phase 7)
3. **Network Segmentation:** Control-plane services (`postgres`, `redis`, `socket-proxy`, `api`, `worker`) run on `reapd-control-internal`, while preview containers are attached exclusively to `reapd-preview-edge`.
4. **Fork PR Gating & Token Scoping:**
   - Pull requests originating from external or deleted forks (`head.repo.id !== base.repo.id` or `head.repo === null`) are rejected before queueing builds.
   - GitHub App installation tokens are minted with single-repository `{ contents: 'read' }` scope and passed via `GIT_CONFIG_*` environment variables scoped strictly to `https://github.com/` so tokens never appear in `ps` or `.git/config`.

## Reporting a Vulnerability

Please report security vulnerabilities privately via [GitHub Security Advisories](https://github.com/Sandesh282/reapd/security/advisories/new) rather than opening a public issue. Include reproduction steps and the affected subsystem (`api`, `worker`, `docker-client`, `infra`).

