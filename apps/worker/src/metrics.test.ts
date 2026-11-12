// apps/worker/src/metrics.test.ts
// Unit tests for worker and reconciler Prometheus metrics registry and instruments.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activePreviews,
  buildDurationSeconds,
  deploymentsByStatus,
  deploymentsTotal,
  queueActive,
  queueWaiting,
  reconcilerExpiredTotal,
  reconcilerFencedTotal,
  reconcilerOrphansRemovedTotal,
  reconcilerSweepDurationSeconds,
  registry,
  smokeResultsTotal,
} from './metrics.js';

void test('worker Prometheus registry formats build, status, smoke, and reconciler metrics', async () => {
  deploymentsTotal.inc({ status: 'LIVE' });
  deploymentsByStatus.set({ status: 'LIVE' }, 2);
  smokeResultsTotal.inc({ result: 'PASSED' });
  buildDurationSeconds.observe({ result: 'succeeded' }, 12.4);
  queueWaiting.set(3);
  queueActive.set(1);
  activePreviews.set(2);
  reconcilerSweepDurationSeconds.observe(0.18);
  reconcilerExpiredTotal.inc(1);
  reconcilerFencedTotal.inc(1);
  reconcilerOrphansRemovedTotal.inc({ kind: 'container' }, 2);

  const output = await registry.metrics();
  assert.match(output, /reapd_deployments_total\{[^}]*status="LIVE"[^}]*\}\s+[1-9]\d*/);
  assert.match(output, /reapd_deployments_by_status\{[^}]*status="LIVE"[^}]*\}\s+2\b/);
  assert.match(output, /reapd_smoke_results_total\{[^}]*result="PASSED"[^}]*\}\s+[1-9]\d*/);
  assert.match(output, /reapd_build_duration_seconds_count\{[^}]*result="succeeded"[^}]*\}\s+[1-9]\d*/);
  assert.match(output, /reapd_queue_waiting\{[^}]*\}\s+3\b/);
  assert.match(output, /reapd_queue_active\{[^}]*\}\s+1\b/);
  assert.match(output, /reapd_active_previews\{[^}]*\}\s+2\b/);
  assert.match(output, /reapd_reconciler_sweep_duration_seconds_count\{[^}]*\}\s+[1-9]\d*/);
  assert.match(output, /reapd_reconciler_expired_total\{[^}]*\}\s+[1-9]\d*/);
  assert.match(output, /reapd_reconciler_fenced_total\{[^}]*\}\s+[1-9]\d*/);
  assert.match(output, /reapd_reconciler_orphans_removed_total\{[^}]*kind="container"[^}]*\}\s+[1-9]\d*/);
});
