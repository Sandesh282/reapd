-- packages/db/src/migrations/0001_initial_schema.sql
-- reapd PRD v2.2 — complete initial schema
-- Run via: psql $DATABASE_URL -f this_file

-- ── Enum types ────────────────────────────────────────────────────────────────

CREATE TYPE deployment_status AS ENUM (
  'QUEUED',
  'BUILDING',
  'STARTING',
  'TESTING',
  'LIVE',
  'FAILED',
  'SUPERSEDED',
  'EXPIRED'
);

CREATE TYPE test_run_status AS ENUM (
  'PASSED',
  'FAILED',
  'TIMED_OUT',
  'SKIPPED'
);

-- ── repositories ─────────────────────────────────────────────────────────────

CREATE TABLE repositories (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  github_repo_id  BIGINT      NOT NULL UNIQUE,
  owner           VARCHAR(128) NOT NULL,
  name            VARCHAR(128) NOT NULL,
  installation_id BIGINT      NOT NULL,
  -- TTL in seconds each preview environment lives after becoming LIVE (default 2h)
  default_ttl_sec INTEGER     NOT NULL DEFAULT 7200,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── pull_requests ─────────────────────────────────────────────────────────────

CREATE TABLE pull_requests (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id           UUID        NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  pr_number         INTEGER     NOT NULL,
  branch_name       VARCHAR(255) NOT NULL,
  -- Monotonic generation counter. Incremented by 1 on every push to this PR.
  -- DEFAULT 1: the first webhook always inserts with generation=1.
  -- A row with latest_generation=0 cannot exist in practice.
  latest_generation INTEGER     NOT NULL DEFAULT 1,
  -- GitHub comment ID for the single sticky PR comment reapd manages
  sticky_comment_id BIGINT,
  is_open           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (repo_id, pr_number)
);

-- ── deployments ───────────────────────────────────────────────────────────────

CREATE TABLE deployments (
  id                UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  pull_request_id   UUID              NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  commit_sha        CHAR(40)          NOT NULL,
  -- Snapshot of pull_requests.latest_generation at the time this deployment was created.
  -- Used in transitionDeploymentStatus to detect stale workers.
  generation        INTEGER           NOT NULL,
  -- Bare DNS label only, e.g. 'pr-104'. The host is built as '<subdomain>.preview.<domain>'.
  subdomain         VARCHAR(120)      NOT NULL,
  status            deployment_status NOT NULL DEFAULT 'QUEUED',
  -- Set once the container is created; null until STARTING state
  container_id      VARCHAR(64),
  -- Set once the image is built; null until BUILDING state completes
  image_tag         VARCHAR(128),
  -- Milliseconds from BUILDING start to image push complete
  build_duration_ms INTEGER,
  -- Human-readable reason for FAILED or SUPERSEDED transitions
  failure_reason    VARCHAR(512),
  -- Cloudflare R2 key for the archived .log.gz (set by reconciler on teardown)
  log_archive_key   VARCHAR(255),
  expires_at        TIMESTAMPTZ       NOT NULL,
  updated_at        TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

-- Reaper + reconciler: find all LIVE deployments past their TTL
CREATE INDEX idx_deployments_reconcile ON deployments (status, expires_at);

-- Superseding: find latest deployment for a PR; detect stale generations
CREATE INDEX idx_deployments_pr_gen ON deployments (pull_request_id, generation DESC);

-- Traefik routing verification: is this subdomain already LIVE?
CREATE INDEX idx_deployments_subdomain ON deployments (subdomain, status);

-- ── deployment_events ─────────────────────────────────────────────────────────

CREATE TABLE deployment_events (
  id            UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID              NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  -- NULL for the initial QUEUED creation event (no prior state)
  from_status   deployment_status,
  to_status     deployment_status NOT NULL,
  -- Free-text reason: failure message, supersede notice, etc.
  reason        VARCHAR(512),
  created_at    TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

-- Dashboard timeline queries: ordered chronological events per deployment
CREATE INDEX idx_events_deployment ON deployment_events (deployment_id, created_at ASC);

-- ── test_runs ─────────────────────────────────────────────────────────────────

CREATE TABLE test_runs (
  id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id       UUID            NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  status              test_run_status NOT NULL,
  duration_ms         INTEGER         NOT NULL,
  console_error_count INTEGER         NOT NULL DEFAULT 0,
  -- Cloudflare R2 key for the Playwright .zip trace archive (failure only)
  trace_r2_key        VARCHAR(255),
  -- Cloudflare R2 key for the failure screenshot (failure only)
  screenshot_r2_key   VARCHAR(255),
  -- Full failure message / stack from Playwright runner stdout
  failure_message     TEXT,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  -- One smoke run per deployment; prevents duplicate rows from retry bugs
  UNIQUE (deployment_id)
);

-- ── webhook_deliveries ────────────────────────────────────────────────────────

CREATE TABLE webhook_deliveries (
  -- Primary key IS the X-GitHub-Delivery UUID — INSERT ON CONFLICT DO NOTHING
  -- is the complete idempotency gate. No separate `processed` flag needed.
  delivery_id UUID        PRIMARY KEY,
  event_type  VARCHAR(64) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

