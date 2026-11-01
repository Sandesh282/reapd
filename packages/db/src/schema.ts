// packages/db/src/schema.ts
// Drizzle ORM schema — TypeScript mirror of 0001_initial_schema.sql.
// Keep these two files in sync whenever you add columns or tables.

import {
  pgTable,
  pgEnum,
  uuid,
  bigint,
  varchar,
  integer,
  boolean,
  char,
  text,
  timestamp,
  uniqueIndex,
  index,
  unique,
} from 'drizzle-orm/pg-core';

// ── Enum types ────────────────────────────────────────────────────────────────

export const deploymentStatusEnum = pgEnum('deployment_status', [
  'QUEUED',
  'BUILDING',
  'STARTING',
  'TESTING',
  'LIVE',
  'FAILED',
  'SUPERSEDED',
  'EXPIRED',
]);

export const testRunStatusEnum = pgEnum('test_run_status', [
  'PASSED',
  'FAILED',
  'TIMED_OUT',
  'SKIPPED',
]);

// ── repositories ──────────────────────────────────────────────────────────────

export const repositories = pgTable('repositories', {
  id:             uuid('id').primaryKey().defaultRandom(),
  githubRepoId:   bigint('github_repo_id', { mode: 'number' }).notNull().unique(),
  owner:          varchar('owner', { length: 128 }).notNull(),
  name:           varchar('name', { length: 128 }).notNull(),
  installationId: bigint('installation_id', { mode: 'number' }).notNull(),
  defaultTtlSec:  integer('default_ttl_sec').notNull().default(7200),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── pull_requests ─────────────────────────────────────────────────────────────

export const pullRequests = pgTable(
  'pull_requests',
  {
    id:               uuid('id').primaryKey().defaultRandom(),
    repoId:           uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    prNumber:         integer('pr_number').notNull(),
    branchName:       varchar('branch_name', { length: 255 }).notNull(),
    latestGeneration: integer('latest_generation').notNull().default(1),
    stickyCommentId:  bigint('sticky_comment_id', { mode: 'number' }),
    isOpen:           boolean('is_open').notNull().default(true),
    createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('uq_pr_repo_number').on(table.repoId, table.prNumber)]
);

// ── deployments ───────────────────────────────────────────────────────────────

export const deployments = pgTable(
  'deployments',
  {
    id:             uuid('id').primaryKey().defaultRandom(),
    pullRequestId:  uuid('pull_request_id').notNull().references(() => pullRequests.id, { onDelete: 'cascade' }),
    commitSha:      char('commit_sha', { length: 40 }).notNull(),
    generation:     integer('generation').notNull(),
    subdomain:      varchar('subdomain', { length: 120 }).notNull(),
    status:         deploymentStatusEnum('status').notNull().default('QUEUED'),
    containerId:    varchar('container_id', { length: 64 }),
    imageTag:       varchar('image_tag', { length: 128 }),
    buildDurationMs: integer('build_duration_ms'),
    failureReason:  varchar('failure_reason', { length: 512 }),
    logArchiveKey:  varchar('log_archive_key', { length: 255 }),
    expiresAt:      timestamp('expires_at', { withTimezone: true }).notNull(),
    updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_deployments_reconcile').on(table.status, table.expiresAt),
    index('idx_deployments_pr_gen').on(table.pullRequestId, table.generation),
    index('idx_deployments_subdomain').on(table.subdomain, table.status),
  ]
);

// ── deployment_events ─────────────────────────────────────────────────────────

export const deploymentEvents = pgTable(
  'deployment_events',
  {
    id:           uuid('id').primaryKey().defaultRandom(),
    deploymentId: uuid('deployment_id').notNull().references(() => deployments.id, { onDelete: 'cascade' }),
    fromStatus:   deploymentStatusEnum('from_status'),   // null on initial QUEUED
    toStatus:     deploymentStatusEnum('to_status').notNull(),
    reason:       varchar('reason', { length: 512 }),
    createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_events_deployment').on(table.deploymentId, table.createdAt),
  ]
);

// ── test_runs ─────────────────────────────────────────────────────────────────

export const testRuns = pgTable(
  'test_runs',
  {
    id:                uuid('id').primaryKey().defaultRandom(),
    deploymentId:      uuid('deployment_id').notNull().references(() => deployments.id, { onDelete: 'cascade' }),
    status:            testRunStatusEnum('status').notNull(),
    durationMs:        integer('duration_ms').notNull(),
    consoleErrorCount: integer('console_error_count').notNull().default(0),
    traceR2Key:        varchar('trace_r2_key', { length: 255 }),
    screenshotR2Key:   varchar('screenshot_r2_key', { length: 255 }),
    failureMessage:    text('failure_message'),
    createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One test run per deployment (PRD v2.2 fix #4)
    uniqueIndex('uq_test_runs_deployment').on(table.deploymentId),
  ]
);

// ── webhook_deliveries ────────────────────────────────────────────────────────

export const webhookDeliveries = pgTable('webhook_deliveries', {
  // The X-GitHub-Delivery UUID IS the primary key — no separate id column.
  deliveryId: uuid('delivery_id').primaryKey(),
  eventType:  varchar('event_type', { length: 64 }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

