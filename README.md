<div align="center">

# reapd

**Ephemeral preview environments, built from scratch.**

[![CI — Backend Unit Tests](https://github.com/Sandesh282/reapd/actions/workflows/backend_unit_tests.yml/badge.svg)](https://github.com/Sandesh282/reapd/actions/workflows/backend_unit_tests.yml)
[![CI — Full-Stack Smoke Tests](https://github.com/Sandesh282/reapd/actions/workflows/full_stack_smoke_tests.yml/badge.svg)](https://github.com/Sandesh282/reapd/actions/workflows/full_stack_smoke_tests.yml)
[![CI — All Lint Checks](https://github.com/Sandesh282/reapd/actions/workflows/all_lint_checks.yml/badge.svg)](https://github.com/Sandesh282/reapd/actions/workflows/all_lint_checks.yml)
[![CI — All Type Checks](https://github.com/Sandesh282/reapd/actions/workflows/all_type_checks.yml/badge.svg)](https://github.com/Sandesh282/reapd/actions/workflows/all_type_checks.yml)

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-26.x-339933?logo=node.js&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=next.js&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)
![Traefik](https://img.shields.io/badge/Traefik-v3.6-24A1C1?logo=traefikproxy&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Engine-2496ED?logo=docker&logoColor=white)

> A self-hosted preview environment engine. Containerised builds, 8-byte Docker stream demux,  
> Redis Streams → SSE log replay, SSRF-guarded Playwright smoke checks,  
> and zero-reload Traefik routing — wired together on a single Linux host.

</div>

---

## Why reapd?

Most preview-environment platforms are hosted SaaS with per-seat pricing, opaque build queues, and no insight into what happens inside the sandbox. reapd is a self-hosted alternative that exposes every layer: a GitHub App webhook hits a Fastify API, a BullMQ worker clones and builds the commit in an isolated Docker container, build logs stream over Redis Streams → Server-Sent Events to an `@xterm/xterm` terminal in the browser, and a Playwright smoke runner validates the preview before it goes `LIVE`. The whole lifecycle, from `git push` to sticky PR comment, runs on a single Linux host with no cloud dependencies.

---

## System Architecture

```mermaid
flowchart TD
    subgraph CP["Control Plane"]
        GH["GitHub App\nwebhook"]
        API["Fastify 5 API\n/api/webhooks\n/api/deployments"]
        PG["PostgreSQL 17\nstate machine +\nidempotency keys"]
        RD["Redis 7\nBullMQ queue +\nlog streams"]
        DASH["Next.js 15\nDashboard\n@xterm/xterm"]
    end

    subgraph EP["Execution Plane"]
        WK["BullMQ Worker\nconcurrency: 2"]
        DOCKER["Docker Engine\nvia TCP socket-proxy"]
        TR["Traefik v3.6\nlabel-based router"]
        CTR["Preview Container\n512 MB · 0.5 vCPU · 100 PIDs\nCapDrop: ALL\nreapd-preview-edge net"]
        SMOKE["Playwright\nSmoke Runner\nSSRF-guarded"]
        GHAPI["GitHub API\nsticky PR comment"]
    end

    GH -->|"HMAC-validated\nPOST /webhooks"| API
    API -->|"INSERT deployment\nFOR UPDATE lock"| PG
    API -->|"enqueue build job"| RD
    RD -->|"dequeue"| WK
    WK -->|"git clone + docker build"| DOCKER
    DOCKER -->|"stream stdout frames\n8-byte demux"| WK
    WK -->|"XADD log stream\nbatch flush"| RD
    WK -->|"inject Traefik labels"| TR
    TR -->|"reverse proxy"| CTR
    WK -->|"TESTING state"| SMOKE
    SMOKE -->|"PASSED / FAILED\nTIMED_OUT / SKIPPED"| WK
    WK -->|"LIVE / FAILED / SUPERSEDED"| PG
    WK -->|"upsertPrComment"| GHAPI
    RD -->|"SSE /deployments/:id/logs\nLast-Event-ID cursor"| API
    API -->|"log stream"| DASH
    DASH -->|"polls /deployments"| API
```

**Control Plane** handles ingestion, state, and streaming; hence no Docker socket exposure. **Execution Plane** does the dirty work inside locked containers on an isolated network bridge. The two planes share only Redis (queue + streams) and Postgres (state).

---

## Core Engineering Decisions

### 1 · The Docker log stream isn't just bytes

When you attach to a Docker container, you don't get raw stdout. The API multiplexes `stdout` and `stderr` into a single byte stream where every chunk is prefixed by an 8-byte header: 1 byte for stream type, 3 bytes of padding, 4 bytes for payload length. Split on `\n` directly and you'll corrupt lines that span frame boundaries or mash two lines that share one frame.

[`packages/docker-client/src/log-demux.ts`](packages/docker-client/src/log-demux.ts) handles this with a carry buffer and a two-state machine (`HEADER` to `PAYLOAD`). It reassembles frames first, then splits on newlines, tagging each line `stdout` or `stderr` before passing it upstream.

From there, the worker's log sink ([`apps/worker/src/logs/log-sink.ts`](apps/worker/src/logs/log-sink.ts)) batches lines into a Redis Stream (`XADD build-log:<id> MAXLEN ~ 2000`) with an async background flush, so a 1,500-line burst from a noisy build step doesn't stall the event loop. Every flush also refreshes a 6h `EXPIRE` on the key, so streams from crashed workers don't accumulate forever.

On the read side, the SSE route ([`apps/api/src/routes/deployments.ts`](apps/api/src/routes/deployments.ts)) uses `XREAD BLOCK 2000` with the browser's `Last-Event-ID` as the cursor, so a tab that reconnects mid-build picks up exactly where it left off. Two edge cases worth mentioning: the route rejects any entry where `source !== 'system'` to block forged `end:LIVE` markers injected via a malicious build step, and if the worker died before writing the end marker, `XINFO STREAM` lets the route detect a stalled stream and close the SSE connection cleanly instead of hanging.

### 2 · Routing without reloads

Every preview gets a subdomain (`pr-<n>.preview.localhost` locally, `pr-<n>.preview.reapd.sh` in production). The obvious approach is to write an nginx or Traefik config file and reload it. The problem is that config reloads drop in-flight connections, and at high throughput you're doing this for every push.

Instead, reapd stamps each container at `docker create` time with Traefik v3 labels:

```
traefik.enable=true
traefik.http.routers.pr-{n}.rule=Host(`pr-{n}.preview.localhost`)
traefik.http.routers.pr-{n}.entrypoints=websecure
traefik.http.services.pr-{n}.loadbalancer.server.port={containerPort}
```

Traefik watches the Docker socket through a read-only TCP socket-proxy (no `exec`, no `post`, no host escape) and picks up the new route within ~50 ms. When the container is reaped, the route disappears with it. No cleanup step, no stale config entry.

### 3 · Rapid pushes without zombie containers

Push three commits in five seconds and you get three webhooks, three BullMQ jobs, and three workers racing to build. Without coordination, all three finish and you end up with three `LIVE` containers for the same PR, two of which are orphaned.

The fix is a monotonic generation counter on the `pull_requests` row, combined with two layers of cancellation:

1. Each worker takes a `SELECT ... FOR UPDATE` on the PR row and reads `latest_generation`. If its own generation is already stale, it transitions to `SUPERSEDED` immediately and exits. If it wins, it increments the counter, making every other in-flight worker stale on their next check.
2. The winning worker also publishes to `cancel:deploy:<id>`. Losing workers subscribe to this channel and receive an `AbortSignal` within < 1 s, stopping the Docker build mid-flight. No polling, no waiting for the next DB round-trip.

A superseded build stops within a second of the newer push arriving.

### 4 · Smoke testing without letting the page call home

Once a container passes its `STARTING` health check, the deployment moves to `TESTING` and a headless Playwright probe runs against the preview URL ([`apps/worker/src/smoke/smoke-runner.ts`](apps/worker/src/smoke/smoke-runner.ts)). Three things have to be true for it to pass:

| Criterion | Check |
|-----------|-------|
| HTTP status | `< 400` |
| Rendered content | `document.body.innerText.trim().length > 0` or a visual element (`img`, `canvas`, `svg`, `video`, `iframe`) is present. A blank SPA shell with nothing but `<div id="root"></div>` fails. |
| Zero errors | `console.error` count + uncaught `pageerror` count = 0 |

The tricky part is SSRF. The preview page runs arbitrary user code and can make fetch calls to `redis`, `postgres`, `169.254.169.254`, or any internal host the Docker network can reach. `context.route()` (not `page.route()`, which doesn't cover service workers) intercepts every outbound request and runs it through `isAllowedSmokeRequestUrl`. The only things that get through are the preview's own origin and public CDN assets. Everything else is aborted before it touches the network: private IP ranges, loopback, single-label hostnames, `.internal`/`.lan`, IPv4-mapped IPv6 like `::ffff:7f00:1`, trailing-dot variants.

If Chromium isn't installed, the probe returns `SKIPPED` via `SmokeUnavailableError` and the deployment still goes `LIVE`. It just skips the visual check. All error strings are run through `redactSecrets()` before truncation, so tokens or passwords that leak into `console.error` never reach `test_runs.failure_message` or the public API.

After the smoke result is committed, `upsertPrComment` ([`apps/worker/src/github/pr-comment.ts`](apps/worker/src/github/pr-comment.ts)) updates the sticky PR comment in-place: `POST` on first deploy, `PATCH` on every subsequent generation, `POST` again if the original was deleted with the orphaned duplicate cleaned up immediately. The comment ID lives in `pull_requests.sticky_comment_id` with an optimistic-lock check, so a concurrent supersede can't leave two comments on the same PR.

### 5 · State machine enforced at the database, not in application code

The deployment lifecycle is a strict one-way graph:

```
QUEUED → BUILDING → STARTING → TESTING → LIVE
                                        ↘ FAILED
                              ↘ SUPERSEDED (any state)
LIVE → EXPIRED  (TTL-elapsed, via reconciler)
```

Transitions go through a single `UPDATE ... WHERE status = $expected RETURNING *`. If the row has already moved because a concurrent push superseded it or the reconciler expired it, the update matches zero rows and the function throws. There's no way to double-transition or rewind; the DB enforces it.

Webhook idempotency works the same way. `(repo_id, pr_number, head_sha)` has a unique constraint, so a re-delivered webhook upserts the existing row instead of queuing a duplicate job. The `generation` column handles the race where a stale BullMQ job finally dequeues after a newer generation has already won the lock. It checks, sees it's behind, and exits without touching the container or the DB.

---

## Sandbox Isolation & Security Model

| Control | Implementation | Value |
|---------|---------------|-------|
| Memory cap | `HostConfig.Memory` | 512 MB |
| Swap | `HostConfig.MemorySwap = Memory` | 0 B (no disk thrash) |
| CPU cap | `HostConfig.NanoCpus` | 0.5 vCPU |
| PID cap | `HostConfig.PidsLimit` | 100 (fork-bomb resistant) |
| Linux capabilities | `HostConfig.CapDrop` | `ALL` dropped |
| Network | `HostConfig.NetworkMode` | `reapd-preview-edge` isolated bridge (ICC disabled deferred to Phase 7) |
| Docker socket | TCP socket-proxy | Restricted: `EXEC`, `HOST`, `VOLUMES` blocked; `POST` enabled for container lifecycle ops |
| Webhook auth | HMAC-SHA256 | `X-Hub-Signature-256` verified before any DB write |
| Smoke browser | `serviceWorkers: 'block'` + `context.route` SSRF guard | Blocks private IPs, single-label hosts, loopback, non-preview origins |
| Secret leakage | `redactSecrets()` | Applied before every log truncation, failure message write, and SSE emit |
| PR comment injection | Dynamic fence + `@`-neutralisation | User-controlled branch name cannot break the markdown fence or ping users |

> **Phase 7 adds:** gVisor `runsc` runtime (syscall interception), Cloudflare DNS-01 wildcard ACME (`*.reapd.sh`), and containerised Playwright in its own network namespace.

---

## CI / Verification

**28 checks** across 5 workflows on every PR:

| Workflow | Jobs |
|----------|------|
| Backend unit tests | Verify test files exist · `@reapd/docker-client` · `@reapd/worker` · `@reapd/api` · PostgreSQL 17 integration |
| Full-stack smoke tests | Phase 1 (Hardened Container & Traefik TLS) · Phase 2 (CLI Clone & BuildKit) · Phase 3 (Webhook HMAC & Idempotency) · Phase 4 (Rapid Superseding & Reconciler) · Phase 5 (REST API & SSE Log Streaming) · Phase 6 (Playwright Smoke Runner & Sticky PR Comment) |
| All lint checks | ESLint across all workspaces |
| All type checks | `tsc --noEmit` across all workspaces |
| PR hygiene | Branch name validation · PR description template check |

Each smoke gate is a self-contained `bash` script in [`infra/scripts/`](infra/scripts/) that spins up the full Docker Compose stack, exercises the real code path end-to-end, and tears everything down. The Phase 6 gate runs the GitHub App mock server, fires a webhook, streams SSE, and asserts the sticky PR comment was posted.

---

## Repository Structure

```
reapd/
├── apps/
│   ├── api/          # Fastify 5 REST + SSE + webhook ingestion
│   ├── worker/       # BullMQ build worker, smoke runner, reconciler
│   └── web/           # Next.js 15 App Router + @xterm/xterm terminal
├── packages/
│   ├── db/           # Drizzle ORM, PostgreSQL schema, migrations, repositories
│   ├── docker-client/# Docker Engine API client, 8-byte log demux, AbortError
│   └── types/        # Shared TypeScript types (DeploymentStatus, TestRunStatus…)
├── infra/
│   ├── docker-compose.yml      # Infra services: Traefik, Redis, Postgres, socket-proxy (API/worker/web run separately)
│   └── scripts/
│       ├── cli-smoke.sh        # Phase 1: container isolation + Traefik TLS
│       ├── phase2-smoke.sh     # Phase 2: git clone + BuildKit image build
│       ├── phase3-smoke.sh     # Phase 3: webhook HMAC + idempotency
│       ├── phase4-smoke.sh     # Phase 4: rapid superseding + reconciler
│       ├── phase5-smoke.sh     # Phase 5: REST API + SSE log streaming
│       └── phase6-smoke.sh     # Phase 6: Playwright smoke + sticky PR comment
├── sample-app/       # Minimal Node.js HTTP server used as the build target in smoke tests
└── turbo.json        # Turborepo pipeline (build → test → lint → typecheck)
```

---

## Quick Start (Self-Hosting Through Phase 6)

### Prerequisites

- Docker Engine 24+ with BuildKit enabled
- Node.js 22+ and npm 10+
- A GitHub App (for webhook delivery and PR comments) — or use the Phase 6 mock server for local testing without one

### 1. Clone and install

```bash
git clone https://github.com/Sandesh282/reapd.git
cd reapd
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Key variables:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `GITHUB_APP_ID` | GitHub App ID (Phase 6+) |
| `GITHUB_APP_PRIVATE_KEY` | PEM private key for JWT signing |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for webhook verification |
| `REAPD_DASHBOARD_PUBLIC_URL` | Public URL of the dashboard (embedded in PR comments) |
| `REAPD_SMOKE_REQUIRED` | `true` to fail deployments when smoke check is `SKIPPED` |
| `REAPD_CHROMIUM_NO_SANDBOX` | `1` to pass `--no-sandbox` when running as root (CI) |

### 3. Start the infrastructure

```bash
docker compose -f infra/docker-compose.yml up -d
# starts: Traefik, Redis, PostgreSQL, socket-proxy
```

Then run the application processes in separate terminals:

```bash
npm run build                        # Turborepo builds all packages in dependency order
npm run dev --workspace apps/api     # Fastify API on :3001
npm run dev --workspace apps/worker  # BullMQ worker
npm run dev --workspace apps/web     # Next.js dashboard on :3000
```

### 4. Run the smoke gates (no GitHub App required for Phases 1–5)

```bash
# Each script is self-contained: starts stack, runs assertions, tears down
bash infra/scripts/cli-smoke.sh       # Phase 1 — container isolation
bash infra/scripts/phase2-smoke.sh    # Phase 2 — git clone + build
bash infra/scripts/phase3-smoke.sh    # Phase 3 — webhook HMAC
bash infra/scripts/phase4-smoke.sh    # Phase 4 — superseding + reconciler
bash infra/scripts/phase5-smoke.sh    # Phase 5 — SSE log streaming
bash infra/scripts/phase6-smoke.sh    # Phase 6 — Playwright smoke + PR comment
```

> Phase 6 requires `npx --no-install playwright-core install chromium` (uses the locked `playwright-core` revision, not the latest unpinned `playwright` package).

---

## Upcoming Phases

### Phase 7 — Production Hardening

- **gVisor `runsc` runtime** — syscall interception at the kernel boundary; containers cannot escape via syscall fuzzing even with `CapDrop: ALL` bypasses
- **Cloudflare DNS-01 wildcard TLS** — Traefik ACME with `*.reapd.sh` wildcard cert; no per-subdomain cert issuance delay
- **Containerised Playwright smoke browser** — smoke runner runs inside its own network namespace so the Chromium process itself cannot reach the Docker host network
- **R2 cold log archival** — `log_archive_key` column is already in the schema; Phase 7 populates it when a deployment expires, moving the Redis Stream to Cloudflare R2 for long-term storage

### Phase 8 — Observability & Benchmarks

- **k6 load tests** — 10-commit rapid-push superseding stress test, webhook ingestion p95, SSE reconnect under load
- **OpenTelemetry traces** — per-deployment span from webhook receipt to `LIVE`, exported to a self-hosted Tempo instance
- **Grafana dashboard** — build queue depth, reconciler sweep latency, active preview count