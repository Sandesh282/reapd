// packages/types/src/domain/state-machine.ts
// Pure domain logic — zero external I/O dependencies.
// This is the single source of truth for valid deployment state transitions.

export const DEPLOYMENT_STATUSES = [
  'QUEUED',
  'BUILDING',
  'STARTING',
  'TESTING',
  'LIVE',
  'FAILED',
  'SUPERSEDED',
  'EXPIRED',
] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/** Terminal states have no outbound edges and can never be overwritten. */
export const TERMINAL_STATUSES: ReadonlySet<DeploymentStatus> = new Set([
  'FAILED',
  'SUPERSEDED',
  'EXPIRED',
]);

/** Active states: deployment is consuming compute or waiting for work. */
export const ACTIVE_STATUSES: ReadonlySet<DeploymentStatus> = new Set([
  'QUEUED',
  'BUILDING',
  'STARTING',
  'TESTING',
  'LIVE',
]);

/**
 * Valid directed edges in the deployment state machine.
 * Any transition not listed here is illegal and will throw.
 *
 * QUEUED     → BUILDING   (worker claims job)
 * QUEUED     → SUPERSEDED (newer commit arrived before build started)
 * QUEUED     → FAILED     (job poisoned / unrecoverable queue error)
 * BUILDING   → STARTING   (image built successfully)
 * BUILDING   → SUPERSEDED (newer commit arrived mid-build)
 * BUILDING   → FAILED     (BuildKit non-zero exit)
 * STARTING   → TESTING    (container passed health-check)
 * STARTING   → SUPERSEDED (newer commit arrived during startup)
 * STARTING   → FAILED     (health-check timeout, container crash-loop)
 * TESTING    → LIVE       (smoke tests passed)
 * TESTING    → SUPERSEDED (newer commit arrived during smoke run)
 * TESTING    → FAILED     (smoke tests failed or timed out)
 * LIVE       → EXPIRED    (PR closed or TTL elapsed)
 */
export const VALID_TRANSITIONS: Readonly<
  Record<DeploymentStatus, readonly DeploymentStatus[]>
> = {
  QUEUED:     ['BUILDING', 'SUPERSEDED', 'FAILED'],
  BUILDING:   ['STARTING', 'SUPERSEDED', 'FAILED'],
  STARTING:   ['TESTING',  'SUPERSEDED', 'FAILED'],
  TESTING:    ['LIVE',     'SUPERSEDED', 'FAILED'],
  LIVE:       ['EXPIRED'],
  // Terminal — no outbound edges
  FAILED:     [],
  SUPERSEDED: [],
  EXPIRED:    [],
};

export class InvalidStateTransitionError extends Error {
  constructor(from: DeploymentStatus, to: DeploymentStatus) {
    super(`Invalid deployment state transition: ${from} → ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

/**
 * Asserts that transitioning from `from` to `to` is a valid edge.
 * Throws `InvalidStateTransitionError` if the transition is illegal.
 * This is a pure function — call it before any I/O in the storage layer.
 */
export function assertValidTransition(
  from: DeploymentStatus,
  to: DeploymentStatus
): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}

