// apps/api/src/metrics.ts
// Prometheus metrics for the reapd API server.
// Exposed on GET /metrics so Prometheus can scrape the API process.

import { Registry, Counter, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

registry.setDefaultLabels({ service: 'api' });
collectDefaultMetrics({ register: registry });

/**
 * Total verified GitHub App webhook requests received.
 * Labels: event = pull_request | ..., action = opened | synchronize | reopened | closed
 */
export const webhookRequestsTotal = new Counter({
  name: 'reapd_webhook_requests_total',
  help: 'Verified GitHub webhook requests received.',
  labelNames: ['event', 'action'] as const,
  registers: [registry],
});

// Pre-initialize common webhook label combinations at 0 so Grafana panels render
// immediately instead of showing "No data" prior to the first webhook delivery.
for (const action of ['opened', 'synchronize', 'reopened', 'closed'] as const) {
  webhookRequestsTotal.labels({ event: 'pull_request', action }).inc(0);
}
webhookRequestsTotal.labels({ event: 'ping', action: 'other' }).inc(0);


