// apps/worker/src/metrics.ts
// Prometheus metrics for the reapd build worker.
// Exposed on :9091/metrics so Prometheus can scrape the worker separately from the API.

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

registry.setDefaultLabels({ service: 'worker' });
collectDefaultMetrics({ register: registry });

/**
 * Total deployments that reached a terminal state.
 * Labels: status = LIVE | FAILED | SUPERSEDED | TIMED_OUT
 */
export const deploymentsTotal = new Counter({
  name: 'reapd_deployments_total',
  help: 'Total deployments that reached a terminal state.',
  labelNames: ['status'] as const,
  registers: [registry],
});

/**
 * Docker image build duration in seconds (from job dequeue to image push complete).
 * Only recorded when a build actually runs (not for jobs superseded before BUILDING).
 */
export const buildDurationSeconds = new Histogram({
  name: 'reapd_build_duration_seconds',
  help: 'Docker image build duration in seconds.',
  buckets: [5, 15, 30, 60, 90, 120, 180, 300],
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
 * Number of deployments currently LIVE (updated by the reconciler sweep).
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

// Pre-initialize known label combinations at 0 so Prometheus/Grafana immediately
// render time-series lines instead of "No data" before the first build finishes.
for (const status of ['LIVE', 'FAILED', 'SUPERSEDED'] as const) {
  deploymentsTotal.labels({ status }).inc(0);
}
for (const result of ['PASSED', 'FAILED', 'TIMED_OUT', 'SKIPPED'] as const) {
  smokeResultsTotal.labels({ result }).inc(0);
}


