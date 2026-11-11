// apps/web/src/lib/api.test.ts
// Unit tests for the dashboard API client & terminal formatting helpers.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDurationMs,
  formatPreviewHost,
  formatTerminalLine,
  getApiBaseUrl,
  getDeploymentLogsSseUrl,
  shortSha,
} from './api.js';

void test('formatTerminalLine never colors build stderr lines red (BuildKit progress invariant) and highlights system failures', () => {
  const buildStderrLine = formatTerminalLine({
    source: 'build',
    stream: 'stderr',
    ts: 1700000000123,
    text: '#5 [2/3] RUN npm ci --omit=dev',
  });

  // BuildKit writes normal step progress to stderr; the line body must not be wrapped in ANSI red (\x1b[31m)
  assert.ok(buildStderrLine.includes('[build]'));
  assert.ok(buildStderrLine.includes('#5 [2/3] RUN npm ci --omit=dev'));
  assert.ok(!buildStderrLine.includes('\x1b[31'));

  const systemFailureLine = formatTerminalLine({
    source: 'system',
    stream: 'stderr',
    ts: 1700000005000,
    text: '[reapd] Build failed: docker build exited with code 1',
  });
  assert.ok(systemFailureLine.includes('[system]'));
  assert.ok(systemFailureLine.includes('\x1b[31;1m'));
});

void test('formatDurationMs, shortSha, and getDeploymentLogsSseUrl format values accurately', () => {
  assert.equal(formatDurationMs(null), '—');
  assert.equal(formatDurationMs(450), '450ms');
  assert.equal(formatDurationMs(14230), '14.2s');
  assert.equal(formatDurationMs(75000), '1m 15s');

  assert.equal(shortSha('0123456789abcdef0123456789abcdef01234567'), '0123456');
  assert.equal(
    formatPreviewHost('https://pr-501.preview.localhost', 'pr-501'),
    'pr-501.preview.localhost',
  );
  assert.equal(
    getDeploymentLogsSseUrl('11111111-1111-4111-8111-111111111111', 'http://127.0.0.1:3001/'),
    'http://127.0.0.1:3001/api/deployments/11111111-1111-4111-8111-111111111111/logs',
  );

  const prevEnv = process.env.NEXT_PUBLIC_API_URL;
  try {
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:4000///';
    assert.equal(getApiBaseUrl(), 'http://localhost:4000');
  } finally {
    if (prevEnv === undefined) {
      delete process.env.NEXT_PUBLIC_API_URL;
    } else {
      process.env.NEXT_PUBLIC_API_URL = prevEnv;
    }
  }
});

