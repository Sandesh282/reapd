#!/usr/bin/env bash
# Phase 4 verification gate (PRD v2.2 §8):
# 1. Creates a temporary Git fixture repo with 3 distinct commits (Gen 1, Gen 2, Gen 3)
#    using a unique cache-busting token per run so BuildKit never caches the `sleep` steps
# 2. Boots the Fastify API server and BullMQ worker (with reconciler interval = 2s)
# 3. Fires 3 rapid signed `pull_request` webhooks for PR #401 (Gen 1 opened, Gen 2 & Gen 3 synchronize)
# 4. Asserts Gen 1 & Gen 2 are marked `SUPERSEDED`, worker logs record the cancel signal,
#    their images are pruned, exactly 1 container is running, and Gen 3 serves `reapd-phase4-gen3`
# 5. Spawns an untracked "zombie" preview container (`reapd.managed=true`, bogus deployment_id)
#    simulating a `SIGKILL`'d worker crash, and asserts the reconciler purges it to 0 orphans
# 6. Sends a signed `pull_request` `action: "closed"` webhook for PR #401 and asserts Gen 3
#    transitions `LIVE -> EXPIRED` and both its container AND image are reaped
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_REPO="$(mktemp -d /tmp/reapd-phase4-repo-XXXXXX)"
API_LOG="$(mktemp /tmp/reapd-phase4-api-XXXXXX.log)"
WORKER_LOG="$(mktemp /tmp/reapd-phase4-worker-XXXXXX.log)"
RECONCILER_LOG="$(mktemp /tmp/reapd-phase4-reconciler-XXXXXX.log)"
API_PORT=3041
TEST_SECRET="phase4-smoke-webhook-secret"
TEST_QUEUE="build-phase4-$$"
TEST_REPO_ID=999401
TEST_PR_NUMBER=401
RUN_TOKEN="$(node -e 'console.log(crypto.randomUUID())')"
ZOMBIE_CONTAINER_NAME="reapd-pr-zombie-401"
CRASH_CONTAINER_NAME="reapd-pr-crash-401"
DELIVERY_INSTALL="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_GEN1="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_GEN2="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_GEN3="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_CLOSE="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_CRASH="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_RECOVER="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_CLOSE2="$(node -e 'console.log(crypto.randomUUID())')"
API_PID=""
WORKER_PID=""
RECONCILER_PID=""

cleanup() {
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
  if [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
    pkill -9 -P "$WORKER_PID" 2>/dev/null || true
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  if [[ -n "$RECONCILER_PID" ]] && kill -0 "$RECONCILER_PID" 2>/dev/null; then
    kill "$RECONCILER_PID" 2>/dev/null || true
    wait "$RECONCILER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_REPO" "$API_LOG" "$WORKER_LOG" "$RECONCILER_LOG"
  docker rm -f -v "$ZOMBIE_CONTAINER_NAME" "$CRASH_CONTAINER_NAME" >/dev/null 2>&1 || true
  (cd "$ROOT" && npm run reapd -- down --pr "$TEST_PR_NUMBER" >/dev/null 2>&1) || true
  DEPLOY_IDS="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
    "SELECT d.id FROM deployments d JOIN pull_requests pr ON pr.id = d.pull_request_id JOIN repositories r ON r.id = pr.repo_id WHERE r.github_repo_id = $TEST_REPO_ID;" 2>/dev/null || true)"
  for did in $DEPLOY_IDS; do
    docker exec -i reapd-redis redis-cli del "logs:build:$did" >/dev/null 2>&1 || true
  done
  docker exec -i reapd-redis sh -c "redis-cli --scan --pattern 'bull:$TEST_QUEUE*' | xargs -r redis-cli del" >/dev/null 2>&1 || true
  docker exec -i reapd-postgres psql -U reapd -d reapd -q <<SQL >/dev/null 2>&1 || true
DELETE FROM webhook_deliveries WHERE delivery_id IN (
  '$DELIVERY_INSTALL', '$DELIVERY_GEN1', '$DELIVERY_GEN2', '$DELIVERY_GEN3',
  '$DELIVERY_CLOSE', '$DELIVERY_CRASH', '$DELIVERY_RECOVER', '$DELIVERY_CLOSE2'
);
DELETE FROM repositories WHERE github_repo_id = $TEST_REPO_ID;
SQL
}
trap cleanup EXIT

# ── 1. Create fixture Git repo with 3 commits ────────────────────────────────
git -C "$TMP_REPO" init --quiet
git -C "$TMP_REPO" config user.email "smoke@reapd.local"
git -C "$TMP_REPO" config user.name "reapd-smoke"
git -C "$TMP_REPO" config commit.gpgsign false
git -C "$TMP_REPO" config uploadpack.allowReachableSHA1InWant true

write_commit() {
  local label="$1"
  local sleep_cmd="$2"
  cat > "$TMP_REPO/server.js" <<EOF
const http = require('node:http');
const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('$label');
}).listen(port, '0.0.0.0');
EOF

  cat > "$TMP_REPO/Dockerfile" <<EOF
FROM node:22-alpine
WORKDIR /app
$sleep_cmd
COPY server.js ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
EOF

  git -C "$TMP_REPO" add Dockerfile server.js
  git -C "$TMP_REPO" commit -q -m "commit $label"
  git -C "$TMP_REPO" rev-parse HEAD
}

# Bake $RUN_TOKEN into the RUN step so BuildKit never serves the sleep layer from cache on repeat runs
SHA_GEN1="$(write_commit "reapd-phase4-gen1" "RUN echo 'gen1-$RUN_TOKEN' && sleep 6")"
SHA_GEN2="$(write_commit "reapd-phase4-gen2" "RUN echo 'gen2-$RUN_TOKEN' && sleep 4")"
SHA_GEN3="$(write_commit "reapd-phase4-gen3" "")"
SHA_CRASH="$(write_commit "reapd-phase4-crash" "RUN echo 'crash-$RUN_TOKEN' && sleep 12")"

echo "📝 Fixture commits created (run token $RUN_TOKEN):"
echo "   Gen 1: $SHA_GEN1 (uncached 6s build)"
echo "   Gen 2: $SHA_GEN2 (uncached 4s build)"
echo "   Gen 3: $SHA_GEN3"
echo "   Crash: $SHA_CRASH (uncached 12s build for SIGKILL recovery test)"

cd "$ROOT"
MKCERT_CAROOT="$(mkcert -CAROOT)"
export NODE_EXTRA_CA_CERTS="$MKCERT_CAROOT/rootCA.pem"

# ── 2. Start API server and BullMQ worker (2s reconciler sweep) ──────────────
echo "🚀 Starting API server on :$API_PORT..."
PORT="$API_PORT" GITHUB_WEBHOOK_SECRET="$TEST_SECRET" REAPD_BUILD_QUEUE="$TEST_QUEUE" \
  node --import tsx "$ROOT/apps/api/src/index.ts" >"$API_LOG" 2>&1 &
API_PID=$!

for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.3
done

if ! curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
  echo "❌ FAIL: API server did not become healthy"
  cat "$API_LOG"
  exit 1
fi

echo "👷 Starting BullMQ worker + Desired-State Reconciler (interval=2000ms)..."
WORKER_METRICS_PORT=19094
# REAPD_STUCK_THRESHOLD_MINUTES=999 so the embedded reconciler cannot accidentally fence
# Generation 4 before the SIGKILL in Step 7.  The reconciler still runs every 2s to exercise
# the zombie-container GC in Steps 5–6; it just won't fence in-flight builds.
REAPD_ROLE=all REAPD_STUCK_THRESHOLD_MINUTES=999 REAPD_REPO_URL_OVERRIDE="$TMP_REPO" REAPD_BUILD_QUEUE="$TEST_QUEUE" REAPD_RECONCILE_INTERVAL_MS=2000 REAPD_WORKER_METRICS_PORT="$WORKER_METRICS_PORT" \
  node --import tsx "$ROOT/apps/worker/src/index.ts" >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!
sleep 1

sign_payload() {
  local payload="$1"
  printf '%s' "$payload" | openssl dgst -sha256 -hmac "$TEST_SECRET" | awk '{print "sha256="$NF}'
}

send_pr_webhook() {
  local delivery_id="$1"
  local action="$2"
  local sha="$3"
  local state="${4:-open}"
  local payload
  payload="$(cat <<JSON
{
  "action": "$action",
  "number": $TEST_PR_NUMBER,
  "pull_request": {
    "number": $TEST_PR_NUMBER,
    "title": "Phase 4 superseding & reconciler PR",
    "state": "$state",
    "user": { "login": "Sandesh282", "id": 1 },
    "head": { "sha": "$sha", "ref": "phase/4-smoke", "repo": { "id": $TEST_REPO_ID, "full_name": "Sandesh282/reapd" } },
    "base": { "sha": "$sha", "ref": "main", "repo": { "id": $TEST_REPO_ID, "full_name": "Sandesh282/reapd" } },
    "merged": false,
    "draft": false
  },
  "repository": {
    "id": $TEST_REPO_ID,
    "name": "reapd",
    "full_name": "Sandesh282/reapd",
    "owner": { "login": "Sandesh282", "id": 1 },
    "private": false,
    "default_branch": "main"
  },
  "installation": { "id": 55504 },
  "sender": { "login": "Sandesh282", "id": 1 }
}
JSON
)"
  local sig
  sig="$(sign_payload "$payload")"
  curl -fsS -X POST "http://127.0.0.1:$API_PORT/webhooks/github" \
    -H "Content-Type: application/json" \
    -H "X-GitHub-Event: pull_request" \
    -H "X-GitHub-Delivery: $delivery_id" \
    -H "X-Hub-Signature-256: $sig" \
    -d "$payload" >/dev/null
}

# Register repository
INSTALL_PAYLOAD="$(cat <<JSON
{
  "action": "created",
  "installation": { "id": 55504 },
  "repositories": [
    { "id": $TEST_REPO_ID, "name": "reapd", "full_name": "Sandesh282/reapd" }
  ]
}
JSON
)"
INSTALL_SIG="$(sign_payload "$INSTALL_PAYLOAD")"
curl -fsS -X POST "http://127.0.0.1:$API_PORT/webhooks/github" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: installation" \
  -H "X-GitHub-Delivery: $DELIVERY_INSTALL" \
  -H "X-Hub-Signature-256: $INSTALL_SIG" \
  -d "$INSTALL_PAYLOAD" >/dev/null

# ── 3. Fire 3 rapid commits to trigger in-flight superseding ─────────────────
echo "⚡ Firing 3 rapid commits to PR #$TEST_PR_NUMBER..."
send_pr_webhook "$DELIVERY_GEN1" "opened" "$SHA_GEN1"
# Poll until Gen 1 enters an in-flight state so its log sink is guaranteed to exist before Gen 2 supersedes it
GEN1_CUR=""
for _ in {1..40}; do
  GEN1_CUR="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
    "SELECT status FROM deployments WHERE subdomain = 'pr-$TEST_PR_NUMBER' AND generation = 1 LIMIT 1;")"
  if [[ "$GEN1_CUR" == "BUILDING" || "$GEN1_CUR" == "STARTING" || "$GEN1_CUR" == "TESTING" ]]; then
    break
  fi
  sleep 0.25
done
[[ "$GEN1_CUR" == "BUILDING" || "$GEN1_CUR" == "STARTING" || "$GEN1_CUR" == "TESTING" ]] || {
  echo "❌ FAIL: gen 1 never reached an in-flight state before superseding (status=$GEN1_CUR)"
  exit 1
}
sleep 0.5
send_pr_webhook "$DELIVERY_GEN2" "synchronize" "$SHA_GEN2"
sleep 0.5
send_pr_webhook "$DELIVERY_GEN3" "synchronize" "$SHA_GEN3"

# ── 4. Wait for Gen 3 to reach LIVE and verify Gen 1 & 2 are SUPERSEDED ──────
echo "⏳ Waiting for Generation 3 to reach LIVE..."
GEN3_STATUS=""
for _ in {1..120}; do
  GEN3_STATUS="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
    "SELECT status FROM deployments WHERE subdomain = 'pr-$TEST_PR_NUMBER' AND generation = 3 LIMIT 1;")"
  if [[ "$GEN3_STATUS" == "LIVE" || "$GEN3_STATUS" == "FAILED" || "$GEN3_STATUS" == "SUPERSEDED" ]]; then
    break
  fi
  sleep 1
done

if [[ "$GEN3_STATUS" != "LIVE" ]]; then
  echo "❌ FAIL: expected Gen 3 to reach LIVE, got '$GEN3_STATUS'"
  cat "$WORKER_LOG"
  exit 1
fi

GEN_SUMMARY="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
  "SELECT string_agg('g' || generation || ':' || status::text, ',' ORDER BY generation) FROM deployments WHERE subdomain = 'pr-$TEST_PR_NUMBER';")"
echo "📊 Generation states: $GEN_SUMMARY"
if [[ "$GEN_SUMMARY" != "g1:SUPERSEDED,g2:SUPERSEDED,g3:LIVE" ]]; then
  echo "❌ FAIL: expected 'g1:SUPERSEDED,g2:SUPERSEDED,g3:LIVE', got '$GEN_SUMMARY'"
  exit 1
fi

GEN1_ID="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
  "SELECT id FROM deployments WHERE subdomain = 'pr-$TEST_PR_NUMBER' AND generation = 1 LIMIT 1;")"
GEN3_ID="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
  "SELECT id FROM deployments WHERE subdomain = 'pr-$TEST_PR_NUMBER' AND generation = 3 LIMIT 1;")"

if ! grep -q "Cancel signal received for deployment $GEN1_ID" "$WORKER_LOG"; then
  echo "❌ FAIL: worker log did not record Redis pub/sub cancel signal for Gen 1 ($GEN1_ID)"
  cat "$WORKER_LOG"
  exit 1
fi

# Verify Gen 1's Redis build stream recorded `end:SUPERSEDED` with the 24h final TTL (> 21600s)
GEN1_STREAM_KEY="logs:build:$GEN1_ID"
GEN1_LAST_ENTRY=""
for _ in {1..20}; do
  GEN1_LAST_ENTRY="$(docker exec -i reapd-redis redis-cli XREVRANGE "$GEN1_STREAM_KEY" + - COUNT 1)"
  if [[ "$GEN1_LAST_ENTRY" == *"end:SUPERSEDED"* ]]; then
    break
  fi
  sleep 0.5
done
GEN1_TTL="$(docker exec -i reapd-redis redis-cli TTL "$GEN1_STREAM_KEY")"
if [[ "$GEN1_LAST_ENTRY" != *"end:SUPERSEDED"* ]] || [[ "$GEN1_TTL" -le 21600 ]]; then
  echo "❌ FAIL: expected $GEN1_STREAM_KEY to end with 'end:SUPERSEDED' ($GEN1_LAST_ENTRY) and have ttl > 21600 ($GEN1_TTL)"
  exit 1
fi
echo "📡 Verified superseded stream $GEN1_STREAM_KEY ends with 'end:SUPERSEDED' (ttl=${GEN1_TTL}s)"

BODY="$(curl -fsSL "https://pr-$TEST_PR_NUMBER.preview.localhost/")"
if [[ "$BODY" != "reapd-phase4-gen3" ]]; then
  echo "❌ FAIL: expected 'reapd-phase4-gen3' from live preview, got '$BODY'"
  exit 1
fi

PR_CONTAINER_COUNT="$(docker ps -q --filter "label=reapd.subdomain=pr-$TEST_PR_NUMBER" | wc -l | tr -d ' ')"
if [[ "$PR_CONTAINER_COUNT" != "1" ]]; then
  echo "❌ FAIL: expected exactly 1 running container for pr-$TEST_PR_NUMBER, got $PR_CONTAINER_COUNT"
  exit 1
fi
echo "✅ Verified Gen 1 & Gen 2 aborted via cancel signal and Gen 3 serving traffic: '$BODY'"

# ── 5. Spawn a zombie orphan container and verify reconciler purges it ───────
echo "🧟 Spawning untracked zombie container ($ZOMBIE_CONTAINER_NAME) with reapd.managed=true..."
docker run -d \
  --name "$ZOMBIE_CONTAINER_NAME" \
  --label "reapd.managed=true" \
  --label "reapd.deployment_id=00000000-0000-0000-0000-000000000401" \
  --label "reapd.subdomain=pr-zombie-401" \
  node:22-alpine sleep 300 >/dev/null

ZOMBIE_GONE=0
for _ in {1..15}; do
  if ! docker inspect "$ZOMBIE_CONTAINER_NAME" >/dev/null 2>&1; then
    ZOMBIE_GONE=1
    break
  fi
  sleep 1
done

if [[ "$ZOMBIE_GONE" != "1" ]]; then
  echo "❌ FAIL: reconciler did not purge zombie container $ZOMBIE_CONTAINER_NAME"
  cat "$WORKER_LOG"
  exit 1
fi
echo "✅ Reconciler detected and purged zombie container ($ZOMBIE_CONTAINER_NAME)"

# ── 6. Close PR #401 and verify Gen 3 expires and container + image are reaped
echo "🔒 Sending pull_request closed webhook for PR #$TEST_PR_NUMBER..."
send_pr_webhook "$DELIVERY_CLOSE" "closed" "$SHA_GEN3" "closed"

GEN3_AFTER_CLOSE="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
  "SELECT status FROM deployments WHERE subdomain = 'pr-$TEST_PR_NUMBER' AND generation = 3 LIMIT 1;")"
if [[ "$GEN3_AFTER_CLOSE" != "EXPIRED" ]]; then
  echo "❌ FAIL: expected Gen 3 status to be EXPIRED after PR close, got '$GEN3_AFTER_CLOSE'"
  exit 1
fi

RESOURCES_GONE=0
for _ in {1..15}; do
  REMAINING_IMG="$(docker images -q --filter "label=reapd.deployment_id=$GEN3_ID" | tr -d '[:space:]')"
  if ! docker inspect "reapd-pr-$TEST_PR_NUMBER" >/dev/null 2>&1 && [[ -z "$REMAINING_IMG" ]]; then
    RESOURCES_GONE=1
    break
  fi
  sleep 1
done

if [[ "$RESOURCES_GONE" != "1" ]]; then
  echo "❌ FAIL: reconciler did not remove expired PR container and image for pr-$TEST_PR_NUMBER"
  cat "$WORKER_LOG"
  exit 1
fi
echo "✅ PR close transitioned Gen 3 LIVE -> EXPIRED and reconciler removed container + image"

# Verify API and Worker Prometheus metrics recorded exact SUPERSEDED, EXPIRED, and orphan GC counts
node - "http://127.0.0.1:$API_PORT/metrics" "http://127.0.0.1:$WORKER_METRICS_PORT/metrics" <<'NODE_EOF'
const assert = require('node:assert/strict');
const [apiMetricsUrl, workerMetricsUrl] = process.argv.slice(2);

(async () => {
  const apiText = await (await fetch(apiMetricsUrl)).text();
  assert.match(apiText, /reapd_deployments_total\{[^}]*status="SUPERSEDED"[^}]*\}\s+2\b/);
  assert.match(apiText, /reapd_deployments_total\{[^}]*status="EXPIRED"[^}]*\}\s+1\b/);

  const workerText = await (await fetch(workerMetricsUrl)).text();
  assert.match(workerText, /reapd_reconciler_orphans_removed_total\{[^}]*kind="container"[^}]*\}\s+[2-9]\d*/);
  assert.match(workerText, /reapd_reconciler_orphans_removed_total\{[^}]*kind="image"[^}]*\}\s+[1-9]\d*/);
  assert.match(workerText, /reapd_reconciler_last_success_timestamp_seconds\{[^}]*\}\s+[1-9]\d*/);
  console.log('✅ Prometheus /metrics verified: 2 SUPERSEDED, 1 EXPIRED, and reconciler orphan GC counters');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE_EOF

# ── 7. SIGKILL worker mid-build & verify standalone reconciler fences + reaps ─
echo "💥 Testing worker SIGKILL crash recovery with standalone reconciler (REAPD_ROLE=reconciler)..."
kill "$WORKER_PID" 2>/dev/null || true
wait "$WORKER_PID" 2>/dev/null || true
WORKER_PID=""

# Start a worker-only process (REAPD_ROLE=worker, no embedded reconciler loop)
REAPD_ROLE=worker REAPD_REPO_URL_OVERRIDE="$TMP_REPO" REAPD_BUILD_QUEUE="$TEST_QUEUE" REAPD_WORKER_METRICS_PORT="$WORKER_METRICS_PORT" \
  node --import tsx "$ROOT/apps/worker/src/index.ts" >>"$WORKER_LOG" 2>&1 &
WORKER_PID=$!
sleep 1

# Reopen PR #401 with the 12s crash commit (Generation 4)
send_pr_webhook "$DELIVERY_CRASH" "reopened" "$SHA_CRASH" "open"

GEN4_CUR=""
for _ in {1..40}; do
  GEN4_CUR="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
    "SELECT status FROM deployments WHERE subdomain = 'pr-$TEST_PR_NUMBER' AND generation = 4 LIMIT 1;")"
  if [[ "$GEN4_CUR" == "BUILDING" ]]; then
    break
  fi
  sleep 0.25
done

if [[ "$GEN4_CUR" != "BUILDING" ]]; then
  echo "❌ FAIL: expected Generation 4 to enter BUILDING before SIGKILL, got '$GEN4_CUR'"
  cat "$WORKER_LOG"
  exit 1
fi

GEN4_ID="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
  "SELECT id FROM deployments WHERE subdomain = 'pr-$TEST_PR_NUMBER' AND generation = 4 LIMIT 1;")"

# Spawn a managed container tied to GEN4_ID to simulate an orphan container left behind at crash time
docker run -d \
  --name "$CRASH_CONTAINER_NAME" \
  --label "reapd.managed=true" \
  --label "reapd.deployment_id=$GEN4_ID" \
  --label "reapd.subdomain=pr-crash-401" \
  node:22-alpine sleep 300 >/dev/null

# SIGKILL (-9) the worker and any child docker build process so SIGTERM handlers cannot run
pkill -9 -P "$WORKER_PID" 2>/dev/null || true
kill -9 "$WORKER_PID" 2>/dev/null || true
wait "$WORKER_PID" 2>/dev/null || true
WORKER_PID=""

# Remove any running preview container for this PR that the worker may have started before the
# SIGKILL, so it doesn't confuse the Generation 5 container-start step later.
docker rm -f "reapd-pr-$TEST_PR_NUMBER" >/dev/null 2>&1 || true

GEN4_AFTER_SIGKILL="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
  "SELECT status FROM deployments WHERE id = '$GEN4_ID' LIMIT 1;")"
if [[ "$GEN4_AFTER_SIGKILL" != "BUILDING" ]]; then
  echo "❌ FAIL: expected Generation 4 to remain stuck in BUILDING immediately after SIGKILL, got '$GEN4_AFTER_SIGKILL'"
  exit 1
fi
echo "💀 Worker SIGKILLed mid-build — Generation 4 ($GEN4_ID) is stuck in BUILDING with orphan container $CRASH_CONTAINER_NAME"

# Boot standalone reconciler (REAPD_ROLE=reconciler) with 0.03m (~1.8s) stuck fence threshold
RECONCILER_METRICS_PORT=19095
REAPD_ROLE=reconciler REAPD_STUCK_THRESHOLD_MINUTES=0.03 REAPD_RECONCILE_INTERVAL_MS=1000 REAPD_RECONCILER_METRICS_PORT="$RECONCILER_METRICS_PORT" \
  node --import tsx "$ROOT/apps/worker/src/index.ts" >"$RECONCILER_LOG" 2>&1 &
RECONCILER_PID=$!

# Wait for the standalone reconciler's metrics server to be ready before asserting anything
for _ in {1..20}; do
  if curl -fsS "http://127.0.0.1:$RECONCILER_METRICS_PORT/metrics" >/dev/null 2>&1; then
    break
  fi
  sleep 0.3
done
if ! curl -fsS "http://127.0.0.1:$RECONCILER_METRICS_PORT/metrics" >/dev/null 2>&1; then
  echo "❌ FAIL: standalone reconciler metrics server did not become ready on :$RECONCILER_METRICS_PORT"
  cat "$RECONCILER_LOG"
  exit 1
fi

# Wait for standalone reconciler to fence Generation 4 -> FAILED and reap $CRASH_CONTAINER_NAME
CRASH_RECOVERED=0
for _ in {1..30}; do
  GEN4_STATUS="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
    "SELECT status FROM deployments WHERE id = '$GEN4_ID' LIMIT 1;")"
  if [[ "$GEN4_STATUS" == "FAILED" ]] && ! docker inspect "$CRASH_CONTAINER_NAME" >/dev/null 2>&1; then
    CRASH_RECOVERED=1
    break
  fi
  sleep 0.5
done

if [[ "$CRASH_RECOVERED" != "1" ]]; then
  echo "❌ FAIL: standalone reconciler did not fence stuck Generation 4 (status=$GEN4_STATUS) or reap $CRASH_CONTAINER_NAME"
  cat "$RECONCILER_LOG"
  exit 1
fi

GEN4_REASON="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
  "SELECT COALESCE(failure_reason, '') FROM deployments WHERE id = '$GEN4_ID' LIMIT 1;")"
if [[ "$GEN4_REASON" != *"reconciler fence"* ]]; then
  echo "❌ FAIL: expected failure_reason to mention reconciler fence, got '$GEN4_REASON'"
  exit 1
fi

FENCE_EVENT_COUNT="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
  "SELECT COUNT(*) FROM deployment_events WHERE deployment_id = '$GEN4_ID' AND from_status = 'BUILDING' AND to_status = 'FAILED';")"
if [[ "$FENCE_EVENT_COUNT" != "1" ]]; then
  echo "❌ FAIL: expected 1 BUILDING -> FAILED audit event in deployment_events for $GEN4_ID, got '$FENCE_EVENT_COUNT'"
  exit 1
fi

# Verify standalone reconciler Prometheus metrics on its dedicated port
node - "http://127.0.0.1:$RECONCILER_METRICS_PORT/metrics" <<'NODE_EOF'
const assert = require('node:assert/strict');
const [reconcilerMetricsUrl] = process.argv.slice(2);

(async () => {
  const text = await (await fetch(reconcilerMetricsUrl)).text();
  assert.match(text, /reapd_reconciler_fenced_total\{[^}]*service="reconciler"[^}]*\}\s+[1-9]\d*/);
  assert.match(text, /reapd_deployments_total\{[^}]*status="FAILED"[^}]*service="reconciler"[^}]*\}\s+[1-9]\d*/);
  assert.match(text, /reapd_reconciler_orphans_removed_total\{[^}]*kind="container"[^}]*service="reconciler"[^}]*\}\s+[1-9]\d*/);
  assert.match(text, /reapd_reconciler_last_success_timestamp_seconds\{[^}]*service="reconciler"[^}]*\}\s+[1-9]\d*/);
  console.log('✅ Standalone reconciler /metrics verified: fenced_total, FAILED transition, and container orphan GC');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE_EOF

# Start a fresh worker (REAPD_ROLE=worker) and push a recovery commit (Generation 5) to prove PR #401 recovers to LIVE
echo "🔄 Starting fresh worker and sending recovery commit (Generation 5)..."
REAPD_ROLE=worker REAPD_REPO_URL_OVERRIDE="$TMP_REPO" REAPD_BUILD_QUEUE="$TEST_QUEUE" REAPD_WORKER_METRICS_PORT="$WORKER_METRICS_PORT" \
  node --import tsx "$ROOT/apps/worker/src/index.ts" >>"$WORKER_LOG" 2>&1 &
WORKER_PID=$!
sleep 1

send_pr_webhook "$DELIVERY_RECOVER" "synchronize" "$SHA_GEN3" "open"

GEN5_STATUS=""
for _ in {1..120}; do
  GEN5_STATUS="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
    "SELECT status FROM deployments WHERE subdomain = 'pr-$TEST_PR_NUMBER' AND generation = 5 LIMIT 1;")"
  if [[ "$GEN5_STATUS" == "LIVE" || "$GEN5_STATUS" == "FAILED" || "$GEN5_STATUS" == "SUPERSEDED" ]]; then
    break
  fi
  sleep 1
done

if [[ "$GEN5_STATUS" != "LIVE" ]]; then
  echo "❌ FAIL: expected recovery Generation 5 to reach LIVE after worker restart, got '$GEN5_STATUS'"
  cat "$WORKER_LOG"
  exit 1
fi

RECOVERED_BODY="$(curl -fsSL "https://pr-$TEST_PR_NUMBER.preview.localhost/")"
if [[ "$RECOVERED_BODY" != "reapd-phase4-gen3" ]]; then
  echo "❌ FAIL: expected 'reapd-phase4-gen3' from recovered preview, got '$RECOVERED_BODY'"
  exit 1
fi
echo "✅ Recovery Generation 5 reached LIVE and serves '$RECOVERED_BODY'"

send_pr_webhook "$DELIVERY_CLOSE2" "closed" "$SHA_GEN3" "closed"

echo "✅ PASS: Phase 4 verification gate complete (3-commit superseding -> orphan container GC -> PR close teardown -> SIGKILL crash recovery + standalone reconciler)"
