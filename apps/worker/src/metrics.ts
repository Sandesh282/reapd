// apps/worker/src/metrics.ts
// Prometheus metrics for the reapd build worker and desired-state reconciler.
// Exposed on :9091/metrics so Prometheus can scrape the worker separately from the API.

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

registry.setDefaultLabels({ service: 'worker' });
collectDefaultMetrics({ register: registry });

/**
 * Total worker-observed terminal transitions (`LIVE | FAILED | SUPERSEDED | EXPIRED`).
 */
export const deploymentsTotal = new Counter({
  name: 'reapd_deployments_total',
  help: 'Total deployments that reached a terminal state.',
  labelNames: ['status'] as const,
  registers: [registry],
});

/**
 * Authoritative PostgreSQL count of deployments grouped by status (`GROUP BY status`).
 * Captures API-side superseding, worker completions, and reconciler expirations/fencing accurately.
 */
export const deploymentsByStatus = new Gauge({
  name: 'reapd_deployments_by_status',
  help: 'Current number of deployments in PostgreSQL grouped by status.',
  labelNames: ['status'] as const,
  registers: [registry],
});

/**
 * Docker BuildKit image build duration in seconds, labeled by `result`
 * (`succeeded | failed | aborted`) so failed/timed-out/superseded builds are included.
 */
export const buildDurationSeconds = new Histogram({
  name: 'reapd_build_duration_seconds',
  help: 'Docker BuildKit image build duration in seconds.',
  labelNames: ['result'] as const,
  buckets: [1, 2.5, 5, 10, 15, 30, 60, 90, 120, 180, 300],
  registers: [registry],
});

/**
 * Number of jobs currently waiting in the BullMQ build queue.
 * Updated by the queue poller in index.ts every 15 s.
 */
export const queueWaiting = new Gauge({
  name: 'reapd_queue_waiting',
  help: 'Build jobs currently waiting in the BullMQ queue.',
  registers: [registry],
});

/**
 * Number of build jobs actively being processed right now.
 */
export const queueActive = new Gauge({
  name: 'reapd_queue_active',
  help: 'Build jobs currently being processed.',
  registers: [registry],
});

/**
 * Number of deployments currently LIVE (updated every 15 s from PostgreSQL).
 */
export const activePreviews = new Gauge({
  name: 'reapd_active_previews',
  help: 'Deployments currently in the LIVE state.',
  registers: [registry],
});

/**
 * Playwright smoke check outcomes.
 * Labels: result = PASSED | FAILED | TIMED_OUT | SKIPPED
 */
export const smokeResultsTotal = new Counter({
  name: 'reapd_smoke_results_total',
  help: 'Playwright smoke check results by outcome.',
  labelNames: ['result'] as const,
  registers: [registry],
});

// ── Reconciler metrics ───────────────────────────────────────────────────────

/** Duration of each desired-state reconciler sweep in seconds. */
export const reconcilerSweepDurationSeconds = new Histogram({
  name: 'reapd_reconciler_sweep_duration_seconds',
  help: 'Duration of desired-state reconciler sweeps in seconds.',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

/** Total TTL-elapsed LIVE deployments marked EXPIRED by the reconciler. */
export const reconcilerExpiredTotal = new Counter({
  name: 'reapd_reconciler_expired_total',
  help: 'Total TTL-elapsed LIVE deployments expired by the reconciler.',
  registers: [registry],
});

/** Total stuck deployments fenced to FAILED by the reconciler. */
export const reconcilerFencedTotal = new Counter({
  name: 'reapd_reconciler_fenced_total',
  help: 'Total stuck deployments fenced to FAILED by the reconciler.',
  registers: [registry],
});

/** Total orphan Docker containers and images removed by the reconciler. */
export const reconcilerOrphansRemovedTotal = new Counter({
  name: 'reapd_reconciler_orphans_removed_total',
  help: 'Total orphan Docker containers and images removed by the reconciler.',
  labelNames: ['kind'] as const,
  registers: [registry],
});

// Pre-initialize known label combinations at 0 so Prometheus/Grafana immediately
// render time-series lines instead of "No data" before the first build finishes.
for (const status of ['LIVE', 'FAILED', 'SUPERSEDED', 'EXPIRED'] as const) {
  deploymentsTotal.labels({ status }).inc(0);
}
for (const status of [
  'QUEUED',
  'BUILDING',
  'STARTING',
  'TESTING',
  'LIVE',
  'FAILED',
  'SUPERSEDED',
  'EXPIRED',
] as const) {
  deploymentsByStatus.labels({ status }).set(0);
}
for (const result of ['PASSED', 'FAILED', 'TIMED_OUT', 'SKIPPED'] as const) {
  smokeResultsTotal.labels({ result }).inc(0);
}
for (const kind of ['container', 'image'] as const) {
  reconcilerOrphansRemovedTotal.labels({ kind }).inc(0);
}
