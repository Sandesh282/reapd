// apps/web/src/app/deployments/[id]/page.tsx
// Deployment detail page (`/deployments/[id]`): displays deployment metadata, the ordered
// `deployment_events` state-machine timeline, and the live SSE `@xterm/xterm` terminal
// (loaded client-only via `next/dynamic({ ssr: false })`).

'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import React, { useEffect, useState } from 'react';
import { TERMINAL_STATUSES } from '@reapd/types';
import { StatusBadge } from '../../../components/StatusBadge';
import {
  fetchDeploymentDetail,
  formatDurationMs,
  formatPreviewHost,
  shortSha,
  type DeploymentDetailWithEvents,
} from '../../../lib/api';

// Load `@xterm/xterm` strictly on the client so Next.js SSR never evaluates `window` / DOM APIs.
const LogTerminal = dynamic(() => import('../../../components/LogTerminal'), {
  ssr: false,
  loading: () => (
    <div className="terminal-card">
      <div className="terminal-header">
        <span className="terminal-title">Initializing terminal…</span>
      </div>
      <div className="terminal-viewport" />
    </div>
  ),
});

const DETAIL_POLL_INTERVAL_MS = 2500;
const DETAIL_POLL_TIMEOUT_MS = 10_000;

export default function DeploymentDetailPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const deploymentId = typeof params?.id === 'string' ? params.id : '';

  const [deployment, setDeployment] = useState<DeploymentDetailWithEvents | null>(null);
  const [notFound, setNotFound] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!deploymentId) return;

    let active = true;
    const controller = new AbortController();
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      const reqSignal =
        typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.any([controller.signal, AbortSignal.timeout(DETAIL_POLL_TIMEOUT_MS)])
          : controller.signal;

      try {
        const detail = await fetchDeploymentDetail(deploymentId, {
          signal: reqSignal,
        });
        if (!active) return;

        if (!detail) {
          setNotFound(true);
          setDeployment(null);
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
          return;
        }

        setDeployment(detail);
        setNotFound(false);
        setError(null);

        if (TERMINAL_STATUSES.has(detail.status) && timer) {
          clearInterval(timer);
          timer = null;
        }
      } catch (err) {
        if (!active || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load deployment');
      } finally {
        inFlight = false;
        if (active && !controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    void load();
    timer = setInterval(() => {
      void load();
    }, DETAIL_POLL_INTERVAL_MS);

    return () => {
      active = false;
      controller.abort();
      if (timer) {
        clearInterval(timer);
      }
    };
  }, [deploymentId]);

  return (
    <div>
      <Link href="/" className="back-link">
        ← Back to all deployments
      </Link>

      {error && <div className="error-banner">{error}</div>}

      {loading && !deployment ? (
        <div className="card empty-state">Loading deployment {deploymentId.slice(0, 8)}…</div>
      ) : notFound || !deployment ? (
        <div className="card empty-state">
          Deployment <span className="mono">{deploymentId}</span> was not found.
        </div>
      ) : (
        <>
          <div className="detail-header">
            <div>
              <h1 className="page-title">
                {deployment.repoFullName} <span className="mono">#{deployment.prNumber}</span>
              </h1>
              <div className="mono" style={{ color: 'var(--text-secondary)', marginTop: '4px' }}>
                {deployment.branchName} · commit {shortSha(deployment.commitSha)} · generation{' '}
                {deployment.generation}
              </div>
            </div>
            <StatusBadge status={deployment.status} />
          </div>

          {deployment.failureReason && (
            <div className="error-banner">
              <strong>Failure reason:</strong> {deployment.failureReason}
            </div>
          )}

          <div className="card detail-metadata-grid">
            <div className="meta-item">
              <span className="meta-label">Deployment ID</span>
              <span className="meta-value mono">{deployment.id.slice(0, 8)}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Preview URL</span>
              <span className="meta-value mono">
                {deployment.status === 'LIVE' ? (
                  <a href={deployment.previewUrl} target="_blank" rel="noopener noreferrer">
                    {formatPreviewHost(deployment.previewUrl, deployment.subdomain)} ↗
                  </a>
                ) : (
                  formatPreviewHost(deployment.previewUrl, deployment.subdomain)
                )}
              </span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Build Duration</span>
              <span className="meta-value mono">
                {formatDurationMs(deployment.buildDurationMs)}
              </span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Playwright Smoke</span>
              <span className="meta-value mono">
                {deployment.testRun ? (
                  <span
                    className={`status-badge status-${
                      deployment.testRun.status === 'PASSED'
                        ? 'live'
                        : deployment.testRun.status === 'SKIPPED'
                          ? 'expired'
                          : 'failed'
                    }`}
                  >
                    {deployment.testRun.status} ({formatDurationMs(deployment.testRun.durationMs)}
                    {deployment.testRun.consoleErrorCount > 0
                      ? ` · ${deployment.testRun.consoleErrorCount} error${
                          deployment.testRun.consoleErrorCount === 1 ? '' : 's'
                        }`
                      : ''}
                    )
                  </span>
                ) : (
                  '—'
                )}
              </span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Expires At</span>
              <span className="meta-value mono">
                {new Date(deployment.expiresAt).toLocaleString()}
              </span>
            </div>
          </div>

          <div className="detail-columns">
            <section className="card">
              <h2 className="section-heading">State Timeline ({deployment.events.length})</h2>
              {deployment.events.length === 0 ? (
                <div className="empty-state" style={{ padding: '20px' }}>
                  No state transitions recorded yet.
                </div>
              ) : (
                <ol className="timeline-list">
                  {deployment.events.map((ev) => (
                    <li key={ev.id} className="timeline-item">
                      <div className="timeline-transition">
                        {ev.fromStatus ? (
                          <>
                            <span>{ev.fromStatus}</span>
                            <span>→</span>
                          </>
                        ) : (
                          <span>INIT →</span>
                        )}
                        <StatusBadge status={ev.toStatus} />
                      </div>
                      {ev.reason && <div className="timeline-reason">{ev.reason}</div>}
                      <div className="timeline-time">
                        {new Date(ev.createdAt).toLocaleTimeString()}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section>
              <LogTerminal deploymentId={deployment.id} />
            </section>
          </div>
        </>
      )}
    </div>
  );
}

