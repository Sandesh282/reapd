// apps/web/src/app/page.tsx
// Deployment list page (`/`): polls `GET /api/deployments` every 3 seconds with optional
// repository and PR number filtering.

'use client';

import Link from 'next/link';
import React, { useEffect, useState } from 'react';
import { StatusBadge } from '../components/StatusBadge';
import {
  fetchDeployments,
  formatDurationMs,
  formatPreviewHost,
  shortSha,
  type DeploymentSummaryItem,
} from '../lib/api';

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10_000;
const FILTER_DEBOUNCE_MS = 250;

export default function DeploymentsListPage(): React.ReactElement {
  const [deployments, setDeployments] = useState<DeploymentSummaryItem[]>([]);
  const [repoFilter, setRepoFilter] = useState<string>('');
  const [prFilter, setPrFilter] = useState<string>('');
  const [debouncedRepo, setDebouncedRepo] = useState<string>('');
  const [debouncedPr, setDebouncedPr] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedRepo(repoFilter);
      setDebouncedPr(prFilter);
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [repoFilter, prFilter]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let inFlight = false;

    const load = async (): Promise<void> => {
      if (inFlight) return;

      const parsedPr = debouncedPr.trim() ? Number(debouncedPr.trim()) : undefined;
      if (parsedPr !== undefined && (!Number.isInteger(parsedPr) || parsedPr <= 0)) {
        setDeployments([]);
        setError('PR filter must be a positive integer');
        setLoading(false);
        return;
      }

      inFlight = true;
      const reqSignal =
        typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.any([controller.signal, AbortSignal.timeout(POLL_TIMEOUT_MS)])
          : controller.signal;
      try {
        const list = await fetchDeployments({
          ...(debouncedRepo.trim() ? { repo: debouncedRepo.trim() } : {}),
          ...(parsedPr !== undefined ? { pr: parsedPr } : {}),
          limit: 50,
          signal: reqSignal,
        });
        if (!active) return;
        setDeployments(list);
        setError(null);
        setLastUpdated(new Date().toLocaleTimeString());
      } catch (err) {
        if (!active || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to fetch deployments');
      } finally {
        inFlight = false;
        if (active && !controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    void load();
    const timer = setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);

    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [debouncedRepo, debouncedPr]);

  return (
    <div>
      <div className="page-toolbar">
        <h1 className="page-title">Recent Deployments</h1>
        <div className="filter-controls">
          <input
            type="text"
            className="filter-input"
            placeholder="Filter repo (e.g. owner/name)"
            value={repoFilter}
            onChange={(e) => setRepoFilter(e.target.value)}
            aria-label="Filter by repository"
          />
          <input
            type="text"
            inputMode="numeric"
            className="filter-input"
            placeholder="PR #"
            value={prFilter}
            onChange={(e) => setPrFilter(e.target.value)}
            style={{ width: '96px' }}
            aria-label="Filter by PR number"
          />
          <span className="poll-indicator">
            {lastUpdated ? `Auto-refreshing · ${lastUpdated}` : 'Connecting to API…'}
          </span>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        {loading && deployments.length === 0 ? (
          <div className="empty-state">Loading deployments…</div>
        ) : deployments.length === 0 ? (
          <div className="empty-state">No deployments found matching the current filters.</div>
        ) : (
          <table className="deployments-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Repository / PR</th>
                <th>Commit</th>
                <th>Generation</th>
                <th>Preview URL</th>
                <th>Build Duration</th>
                <th>Updated</th>
                <th>Logs</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => (
                <tr key={d.id}>
                  <td>
                    <StatusBadge status={d.status} />
                  </td>
                  <td>
                    <div>
                      <strong>{d.repoFullName}</strong>{' '}
                      <span className="mono">#{d.prNumber}</span>
                    </div>
                    <div className="mono" style={{ color: 'var(--text-secondary)' }}>
                      {d.branchName}
                    </div>
                  </td>
                  <td className="mono">{shortSha(d.commitSha)}</td>
                  <td className="mono">gen {d.generation}</td>
                  <td className="mono">
                    {d.status === 'LIVE' ? (
                      <a href={d.previewUrl} target="_blank" rel="noopener noreferrer">
                        {formatPreviewHost(d.previewUrl, d.subdomain)} ↗
                      </a>
                    ) : (
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {formatPreviewHost(d.previewUrl, d.subdomain)}
                      </span>
                    )}
                  </td>
                  <td className="mono">{formatDurationMs(d.buildDurationMs)}</td>
                  <td className="mono" style={{ color: 'var(--text-secondary)' }}>
                    {new Date(d.updatedAt).toLocaleTimeString()}
                  </td>
                  <td>
                    <Link href={`/deployments/${d.id}`}>View logs →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

