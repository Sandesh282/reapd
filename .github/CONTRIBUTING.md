# Contributing to `reapd`

`reapd` follows a strict **4-Layer Architecture** and an **8-Phase Vertical Implementation Roadmap**.

## 4-Layer Dependency Rules

Every backend module enforces strict unidirectional dependencies:

```text
Route (apps/api) → Service (apps/worker) → Domain (packages/types) → Storage (packages/db, packages/docker-client)
```

1. **Route Layer (`apps/api`):** Validates HTTP/webhook requests (HMAC-SHA256 + Zod schemas) and enqueues BullMQ jobs. Never writes raw SQL directly.
2. **Service Layer (`apps/worker`):** Orchestrates Git clones, BuildKit builds, health probes, desired-state reconciliation, and smoke runners.
3. **Domain Layer (`packages/types`):** Pure TypeScript state machines (`VALID_TRANSITIONS`, `assertValidTransition`) and Zod schemas with zero I/O dependencies.
4. **Storage Layer (`packages/db`, `packages/docker-client`):** Encapsulates PostgreSQL 17 transactions (`FOR UPDATE` lock hierarchy: `pull_requests -> deployments`) and hardened Dockerode calls.

## Local Verification Before Opening a PR

1. **Start infrastructure** (generates random local Postgres/Redis passwords into your git-ignored `.env` on first run):
   ```bash
   npm run infra:up
   ```
2. **Run typechecks and unit/DB tests:**
   ```bash
   npm run typecheck --workspaces --if-present
   npm run test --workspaces --if-present
   ```
3. **Run phase verification smoke scripts:**
   ```bash
   ./infra/scripts/phase2-smoke.sh
   ./infra/scripts/phase3-smoke.sh
   ./infra/scripts/phase4-smoke.sh
   ```

