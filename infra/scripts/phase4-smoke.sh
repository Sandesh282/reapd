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
API_PORT=3041
TEST_SECRET="phase4-smoke-webhook-secret"
TEST_QUEUE="build-phase4-$$"
TEST_REPO_ID=999401
TEST_PR_NUMBER=401
RUN_TOKEN="$(node -e 'console.log(crypto.randomUUID())')"
ZOMBIE_CONTAINER_NAME="reapd-pr-zombie-401"
DELIVERY_INSTALL="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_GEN1="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_GEN2="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_GEN3="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_CLOSE="$(node -e 'console.log(crypto.randomUUID())')"
API_PID=""
WORKER_PID=""

cleanup() {
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
  if [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_REPO" "$API_LOG" "$WORKER_LOG"
  docker rm -f -v "$ZOMBIE_CONTAINER_NAME" >/dev/null 2>&1 || true
  (cd "$ROOT" && npm run reapd -- down --pr "$TEST_PR_NUMBER" >/dev/null 2>&1) || true
  docker exec -i reapd-redis sh -c "redis-cli --scan --pattern 'bull:$TEST_QUEUE*' | xargs -r redis-cli del; redis-cli --scan --pattern 'logs:build:*' | xargs -r redis-cli del" >/dev/null 2>&1 || true
  docker exec -i reapd-postgres psql -U reapd -d reapd -q <<SQL >/dev/null 2>&1 || true
DELETE FROM webhook_deliveries WHERE delivery_id IN (
  '$DELIVERY_INSTALL', '$DELIVERY_GEN1', '$DELIVERY_GEN2', '$DELIVERY_GEN3', '$DELIVERY_CLOSE'
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

echo "📝 Fixture commits created (run token $RUN_TOKEN):"
echo "   Gen 1: $SHA_GEN1 (uncached 6s build)"
echo "   Gen 2: $SHA_GEN2 (uncached 4s build)"
echo "   Gen 3: $SHA_GEN3"

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
REAPD_REPO_URL_OVERRIDE="$TMP_REPO" REAPD_BUILD_QUEUE="$TEST_QUEUE" REAPD_RECONCILE_INTERVAL_MS=2000 \
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
sleep 1.5
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

echo "✅ PASS: Phase 4 verification gate complete (3-commit superseding -> orphan container GC -> PR close container+image teardown)"
