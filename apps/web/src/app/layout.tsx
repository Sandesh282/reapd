// apps/web/src/app/layout.tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import React from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'reapd — Ephemeral PR Previews',
  description: 'Control plane dashboard for reapd PR preview deployments and live build logs',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <header className="app-header">
            <Link href="/" className="brand-link">
              <span>reapd</span>
              <span className="brand-tag">preview control plane</span>
            </Link>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}

