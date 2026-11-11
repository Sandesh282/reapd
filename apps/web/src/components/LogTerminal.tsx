// apps/web/src/components/LogTerminal.tsx
// Client-only `@xterm/xterm` SSE log terminal loaded via `next/dynamic({ ssr: false })`.
//
// Invariants (Phase 5 v2.1):
//   - Explicitly calls `es.close()` inside the `event: end` listener so the browser's
//     native `EventSource` does NOT auto-reconnect in an infinite loop on stream completion.
//   - Closes `EventSource` and disposes the `Terminal` instance on unmount (safe under
//     React 19 Strict Mode double-mount).
//   - Configures `scrollback: LOG_STREAM_MAXLEN` (2,000) to match the Redis stream cap.
//   - Handles `event: gap` (when `Last-Event-ID` fell behind `MAXLEN` trim) and
//     `expired: true` on `event: end` (renders a clear "Build logs expired (24h TTL)" notice).
//   - Never colors `stderr` lines red (BuildKit writes all normal build progress to `stderr`).

'use client';

import React, { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  LOG_STREAM_MAXLEN,
  LogEntrySchema,
  type BuildLogEndStatus,
} from '@reapd/types';
import {
  formatTerminalLine,
  getDeploymentLogsSseUrl,
  type SseEndPayload,
  type SseGapPayload,
} from '../lib/api';

export interface LogTerminalProps {
  deploymentId: string;
  apiBaseUrl?: string;
}

export type StreamConnectionState =
  | 'connecting'
  | 'streaming'
  | 'completed'
  | 'expired'
  | 'disconnected';

export default function LogTerminal({
  deploymentId,
  apiBaseUrl,
}: LogTerminalProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [connState, setConnState] = useState<StreamConnectionState>('connecting');
  const [endStatus, setEndStatus] = useState<BuildLogEndStatus | null>(null);
  const [lineCount, setLineCount] = useState<number>(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    setConnState('connecting');
    setEndStatus(null);
    setLineCount(0);

    const term = new Terminal({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      scrollback: LOG_STREAM_MAXLEN,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      theme: {
        background: '#0b0f17',
        foreground: '#e5e7eb',
        cursor: '#6b7280',
        selectionBackground: '#1f2937',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    const safeFit = (): void => {
      if (disposed) return;
      try {
        fitAddon.fit();
      } catch {
        // Ignore layout errors if container has 0 dimensions while hidden
      }
    };
    safeFit();

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => safeFit()) : null;
    resizeObserver?.observe(container);

    const sseUrl = getDeploymentLogsSseUrl(deploymentId, apiBaseUrl);
    const es = new EventSource(sseUrl);

    es.onopen = () => {
      if (disposed) return;
      setConnState((prev) => (prev === 'completed' || prev === 'expired' ? prev : 'streaming'));
    };

    es.onmessage = (ev: MessageEvent<string>) => {
      if (disposed) return;
      try {
        const raw = JSON.parse(ev.data) as unknown;
        const parsed = LogEntrySchema.safeParse(raw);
        if (!parsed.success) return;
        term.writeln(formatTerminalLine(parsed.data));
        setLineCount((c) => c + 1);
        setConnState('streaming');
      } catch {
        // Ignore malformed frame
      }
    };

    es.addEventListener('gap', (ev: Event) => {
      if (disposed) return;
      try {
        const msg = ev as MessageEvent<string>;
        const payload = JSON.parse(msg.data) as SseGapPayload;
        term.writeln(
          `\x1b[33m[reapd] ⚠ ${payload.message ?? 'Earlier log entries were trimmed by MAXLEN cap'}\x1b[0m`,
        );
      } catch {
        term.writeln('\x1b[33m[reapd] ⚠ Earlier log entries were trimmed by MAXLEN cap\x1b[0m');
      }
    });

    es.addEventListener('end', (ev: Event) => {
      if (disposed) return;
      // CRITICAL: Close the EventSource immediately on `event: end` so the browser
      // does not automatically reconnect when the server closes the HTTP response.
      es.close();

      try {
        const msg = ev as MessageEvent<string>;
        const payload = JSON.parse(msg.data) as SseEndPayload;
        setEndStatus(payload.status);
        if (payload.expired) {
          setConnState('expired');
          term.writeln(
            '\x1b[33m[reapd] Build logs for this deployment have expired (24h Redis stream TTL).\x1b[0m',
          );
        } else {
          setConnState('completed');
          const statusColor =
            payload.status === 'LIVE'
              ? '\x1b[32;1m'
              : payload.status === 'SUPERSEDED'
                ? '\x1b[33;1m'
                : '\x1b[31;1m';
          term.writeln(
            `\x1b[90m────────────────────────────────────────────────────────────────────────\x1b[0m`,
          );
          term.writeln(
            `\x1b[36m[reapd]\x1b[0m Stream finished with status ${statusColor}${payload.status}\x1b[0m`,
          );
        }
      } catch {
        setConnState('completed');
      }
    });

    es.onerror = () => {
      if (disposed) return;
      // If `es.readyState === EventSource.CLOSED`, stream was already closed; otherwise
      // native EventSource will automatically retry with `Last-Event-ID`.
      if (es.readyState === EventSource.CLOSED) {
        setConnState((prev) =>
          prev === 'completed' || prev === 'expired' ? prev : 'disconnected',
        );
      } else {
        setConnState((prev) =>
          prev === 'completed' || prev === 'expired' ? prev : 'connecting',
        );
      }
    };

    return () => {
      disposed = true;
      es.close();
      resizeObserver?.disconnect();
      term.dispose();
    };
  }, [deploymentId, apiBaseUrl]);

  return (
    <div className="terminal-card">
      <div className="terminal-header">
        <div className="terminal-title">
          <span>Build Log Stream (logs:build:{deploymentId.slice(0, 8)}…)</span>
          <span className="terminal-meta">{lineCount} lines</span>
        </div>
        <div className="terminal-status">
          {connState === 'connecting' && (
            <span className="stream-pill stream-connecting">Connecting SSE…</span>
          )}
          {connState === 'streaming' && (
            <span className="stream-pill stream-live">● Live tailing</span>
          )}
          {connState === 'completed' && (
            <span className="stream-pill stream-done">
              Stream complete ({endStatus ?? 'DONE'})
            </span>
          )}
          {connState === 'expired' && (
            <span className="stream-pill stream-expired">Logs expired (24h TTL)</span>
          )}
          {connState === 'disconnected' && (
            <span className="stream-pill stream-disconnected">Disconnected</span>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        className="terminal-viewport"
        aria-label="Deployment build logs terminal"
      />
    </div>
  );
}

