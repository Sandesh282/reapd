// apps/web/src/components/StatusBadge.tsx
import React from 'react';
import type { DeploymentStatus } from '@reapd/types';

export interface StatusBadgeProps {
  status: DeploymentStatus;
}

export function StatusBadge({ status }: StatusBadgeProps): React.ReactElement {
  return (
    <span className={`status-badge status-${status.toLowerCase()}`}>
      {status}
    </span>
  );
}

