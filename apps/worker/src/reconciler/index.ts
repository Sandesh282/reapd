// apps/worker/src/reconciler/index.ts
// 60-second background reconciler loop scaffold.
// Phase 4 fills out expired deployment cleanup, orphan container/image sweeps,
// and Redis log buffer pruning.

const RECONCILE_INTERVAL_MS = 60_000;

export function startReconciler(): () => void {
  console.log('♻️  Reconciler timer registered (60s scaffold — sweep logic lands in Phase 4)');
  const timer = setInterval(() => {
    // Phase 4 will query idx_deployments_reconcile and prune expired/orphaned resources
  }, RECONCILE_INTERVAL_MS);

  timer.unref();
  return () => clearInterval(timer);
}
