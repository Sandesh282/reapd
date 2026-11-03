#!/usr/bin/env bash
# Phase 3 verification gate:
# 1. Creates a temporary Git fixture repo with a Dockerfile + server.js
# 2. Boots the Fastify API server on an isolated test port
# 3. Verifies HMAC rejection (401) on a tampered signature
# 4. Sends a signed `installation` webhook to register the repository
# 5. Sends a signed `pull_request` webhook (PR #301) and asserts { received: true, duplicate: false }
# 6. Replays the exact same X-GitHub-Delivery UUID and asserts { duplicate: true } (idempotency gate)
# 7. Boots the BullMQ worker and waits for the deployment to reach LIVE in PostgreSQL
# 8. Verifies https://pr-301.preview.localhost/ serves the expected payload and audit events are recorded
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_REPO="$(mktemp -d /tmp/reapd-phase3-repo-XXXXXX)"
API_LOG="$(mktemp /tmp/reapd-phase3-api-XXXXXX.log)"
WORKER_LOG="$(mktemp /tmp/reapd-phase3-worker-XXXXXX.log)"
API_PORT=3031
TEST_SECRET="phase3-smoke-webhook-secret"
TEST_QUEUE="build-smoke-$$"
TEST_REPO_ID=999301
TEST_PR_NUMBER=301
DELIVERY_INSTALL="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_PR="$(node -e 'console.log(crypto.randomUUID())')"
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
  (cd "$ROOT" && npm run reapd -- down --pr "$TEST_PR_NUMBER" >/dev/null 2>&1) || true
  docker exec -i reapd-redis sh -c "redis-cli --scan --pattern 'bull:$TEST_QUEUE*' | xargs -r redis-cli del" >/dev/null 2>&1 || true
  docker exec -i reapd-postgres psql -U reapd -d reapd -q <<SQL >/dev/null 2>&1 || true
DELETE FROM webhook_deliveries WHERE delivery_id IN ('$DELIVERY_INSTALL', '$DELIVERY_PR');
DELETE FROM repositories WHERE github_repo_id = $TEST_REPO_ID;
SQL
}
trap cleanup EXIT

# ── 1. Create fixture Git repo ───────────────────────────────────────────────
cat > "$TMP_REPO/server.js" <<'EOF'
const http = require('node:http');
const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('reapd-phase3-live');
}).listen(port, '0.0.0.0');
EOF

cp "$ROOT/sample-app/Dockerfile" "$TMP_REPO/"

git -C "$TMP_REPO" init --quiet
git -C "$TMP_REPO" config user.email "smoke@reapd.local"
git -C "$TMP_REPO" config user.name "reapd-smoke"
git -C "$TMP_REPO" config commit.gpgsign false
git -C "$TMP_REPO" config uploadpack.allowReachableSHA1InWant true
git -C "$TMP_REPO" add Dockerfile server.js
git -C "$TMP_REPO" commit -q -m "phase3 smoke fixture"
TARGET_SHA="$(git -C "$TMP_REPO" rev-parse HEAD)"

cd "$ROOT"
MKCERT_CAROOT="$(mkcert -CAROOT)"
export NODE_EXTRA_CA_CERTS="$MKCERT_CAROOT/rootCA.pem"

# ── 2. Start API server ──────────────────────────────────────────────────────
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

sign_payload() {
  local payload="$1"
  printf '%s' "$payload" | openssl dgst -sha256 -hmac "$TEST_SECRET" | awk '{print "sha256="$NF}'
}

# ── 3. Verify invalid HMAC is rejected with 401 ──────────────────────────────
echo "🔒 Verifying tampered HMAC is rejected with 401..."
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "http://127.0.0.1:$API_PORT/webhooks/github" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: ping" \
  -H "X-GitHub-Delivery: $DELIVERY_INSTALL" \
  -H "X-Hub-Signature-256: sha256=0000000000000000000000000000000000000000000000000000000000000000" \
  -d '{"zen":"keep it logically awesome"}')"

if [[ "$HTTP_CODE" != "401" ]]; then
  echo "❌ FAIL: expected HTTP 401 on invalid HMAC, got $HTTP_CODE"
  exit 1
fi

# ── 4. Send signed installation webhook ──────────────────────────────────────
echo "📦 Registering test repository via signed installation webhook..."
INSTALL_PAYLOAD="$(cat <<JSON
{
  "action": "created",
  "installation": { "id": 55501 },
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

# ── 5. Send signed pull_request webhook ──────────────────────────────────────
echo "📨 Sending signed pull_request webhook (delivery $DELIVERY_PR)..."
PR_PAYLOAD="$(cat <<JSON
{
  "action": "opened",
  "number": $TEST_PR_NUMBER,
  "pull_request": {
    "number": $TEST_PR_NUMBER,
    "title": "Phase 3 smoke PR",
    "state": "open",
    "user": { "login": "Sandesh282", "id": 1 },
    "head": { "sha": "$TARGET_SHA", "ref": "phase/3-smoke", "repo": { "id": $TEST_REPO_ID, "full_name": "Sandesh282/reapd" } },
    "base": { "sha": "$TARGET_SHA", "ref": "main", "repo": { "id": $TEST_REPO_ID, "full_name": "Sandesh282/reapd" } },
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
  "installation": { "id": 55501 },
  "sender": { "login": "Sandesh282", "id": 1 }
}
JSON
)"
PR_SIG="$(sign_payload "$PR_PAYLOAD")"

RESP1="$(curl -fsS -X POST "http://127.0.0.1:$API_PORT/webhooks/github" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: $DELIVERY_PR" \
  -H "X-Hub-Signature-256: $PR_SIG" \
  -d "$PR_PAYLOAD")"
echo "   First delivery response: $RESP1"
if [[ "$RESP1" != *'"duplicate":false'* ]]; then
  echo "❌ FAIL: expected duplicate:false on first delivery, got $RESP1"
  exit 1
fi

# ── 6. Replay identical delivery ID (idempotency gate) ───────────────────────
echo "🔁 Replaying identical X-GitHub-Delivery UUID..."
RESP2="$(curl -fsS -X POST "http://127.0.0.1:$API_PORT/webhooks/github" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: $DELIVERY_PR" \
  -H "X-Hub-Signature-256: $PR_SIG" \
  -d "$PR_PAYLOAD")"
echo "   Replay response: $RESP2"
if [[ "$RESP2" != *'"duplicate":true'* ]]; then
  echo "❌ FAIL: expected duplicate:true on replay, got $RESP2"
  exit 1
fi

DEPLOY_COUNT="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
  "SELECT COUNT(*) FROM deployments WHERE subdomain = 'pr-$TEST_PR_NUMBER';")"
if [[ "$DEPLOY_COUNT" != "1" ]]; then
  echo "❌ FAIL: expected exactly 1 deployment row after duplicate replay, got $DEPLOY_COUNT"
  exit 1
fi

# ── 7. Start BullMQ worker and wait for LIVE ─────────────────────────────────
echo "👷 Starting BullMQ worker to process the queued build..."
REAPD_REPO_URL_OVERRIDE="$TMP_REPO" REAPD_BUILD_QUEUE="$TEST_QUEUE" \
  node --import tsx "$ROOT/apps/worker/src/index.ts" >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!

STATUS=""
for _ in {1..120}; do
  STATUS="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
    "SELECT status FROM deployments WHERE subdomain = 'pr-$TEST_PR_NUMBER' LIMIT 1;")"
  if [[ "$STATUS" == "LIVE" || "$STATUS" == "FAILED" || "$STATUS" == "SUPERSEDED" ]]; then
    break
  fi
  sleep 1
done

if [[ "$STATUS" != "LIVE" ]]; then
  echo "❌ FAIL: expected deployment to reach LIVE, got '$STATUS'"
  echo "--- API LOG ---"
  cat "$API_LOG"
  echo "--- WORKER LOG ---"
  cat "$WORKER_LOG"
  exit 1
fi

# ── 8. Verify live route + audit trail ───────────────────────────────────────
echo "🔎 Verifying https://pr-$TEST_PR_NUMBER.preview.localhost/ returns 'reapd-phase3-live'"
BODY="$(curl -fsSL "https://pr-$TEST_PR_NUMBER.preview.localhost/")"
if [[ "$BODY" != "reapd-phase3-live" ]]; then
  echo "❌ FAIL: expected 'reapd-phase3-live', got '$BODY'"
  exit 1
fi

EVENTS="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
  "SELECT string_agg(de.to_status::text, '->' ORDER BY de.created_at) FROM deployment_events de JOIN deployments d ON d.id = de.deployment_id WHERE d.subdomain = 'pr-$TEST_PR_NUMBER';")"
echo "📜 Recorded audit trail: $EVENTS"
if [[ "$EVENTS" != "QUEUED->BUILDING->STARTING->TESTING->LIVE" ]]; then
  echo "❌ FAIL: unexpected audit trail: $EVENTS"
  exit 1
fi

echo "✅ PASS: Phase 3 verification gate complete (HMAC -> idempotency -> BullMQ -> BuildKit -> Traefik LIVE -> audit trail)"
