// apps/worker/src/metrics.test.ts
// Unit tests for worker Prometheus metrics registry and instruments.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activePreviews,
  buildDurationSeconds,
  deploymentsTotal,
  queueActive,
  queueWaiting,
  registry,
  smokeResultsTotal,
} from './metrics.js';

void test('worker Prometheus registry formats counters, histograms, and gauges with service="worker"', async () => {
  deploymentsTotal.inc({ status: 'LIVE' });
  smokeResultsTotal.inc({ result: 'PASSED' });
  buildDurationSeconds.observe(12.4);
  queueWaiting.set(3);
  queueActive.set(1);
  activePreviews.set(2);

  const output = await registry.metrics();
  assert.match(output, /reapd_deployments_total\{[^}]*status="LIVE"[^}]*service="worker"[^}]*\}\s+[1-9]\d*/);
  assert.match(output, /reapd_smoke_results_total\{[^}]*result="PASSED"[^}]*service="worker"[^}]*\}\s+[1-9]\d*/);
  assert.match(output, /reapd_build_duration_seconds_count\{service="worker"\}\s+[1-9]\d*/);
  assert.match(output, /reapd_queue_waiting\{service="worker"\}\s+3\b/);
  assert.match(output, /reapd_queue_active\{service="worker"\}\s+1\b/);
  assert.match(output, /reapd_active_previews\{service="worker"\}\s+2\b/);
});

