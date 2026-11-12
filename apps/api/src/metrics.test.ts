// apps/api/src/metrics.test.ts
// Unit tests for Prometheus metrics endpoint (`GET /metrics`), proxy-header rejection,
// bounded webhook label recording, and rejection counters.

import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildApp } from './index.js';

void test('GET /metrics exposes Prometheus text format, rejects X-Forwarded-* proxy requests, and tracks verified + rejected webhooks', async () => {
  const secret = 'test-webhook-secret';
  const app = await buildApp({
    logger: false,
    webhookSecret: secret,
    deploymentRoutesDeps: {
      listRecentDeployments: async () => [],
      getDeploymentByIdWithEvents: async () => null,
    },
  });

  try {
    // 1. Proxied/tunneled requests to /metrics must be blocked with 403
    const proxiedRes = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: {
        'x-forwarded-for': '203.0.113.10',
      },
    });
    assert.equal(proxiedRes.statusCode, 403);

    // 2. Bad HMAC signature increments reapd_webhook_rejections_total{reason="invalid_signature"}
    const badSigRes = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
      payload: JSON.stringify({ zen: 'bad sig' }),
    });
    assert.equal(badSigRes.statusCode, 401);

    // 3. Valid HMAC ping with unknown action clamps action to "other"
    const pingBody = JSON.stringify({ zen: 'Keep it logically awesome.', action: 'unexpected_custom_action' });
    const sig = `sha256=${createHmac('sha256', secret).update(pingBody).digest('hex')}`;

    const webhookRes = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': sig,
      },
      payload: pingBody,
    });
    assert.equal(webhookRes.statusCode, 200);

    const metricsRes = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    assert.equal(metricsRes.statusCode, 200);
    assert.match(metricsRes.headers['content-type'] ?? '', /text\/plain/);
    assert.match(
      metricsRes.body,
      /reapd_webhook_requests_total\{[^}]*event="ping"[^}]*action="other"[^}]*\}\s+[1-9]\d*/,
    );
    assert.match(
      metricsRes.body,
      /reapd_webhook_rejections_total\{[^}]*reason="invalid_signature"[^}]*\}\s+[1-9]\d*/,
    );
    assert.ok(!metricsRes.body.includes('unexpected_custom_action'), 'Unbounded action strings must be clamped to "other"');
  } finally {
    await app.close();
  }
});
