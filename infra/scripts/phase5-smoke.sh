#!/usr/bin/env bash
# Phase 5 verification gate (PRD v2.2 §8 + Issue #20):
# 1. Creates a temporary Git fixture repo with 3 commits:
#    - SHA_SLOW: multistep Dockerfile (`sleep 1` between `echo` steps) for SSE early/mid/post replay
#    - SHA_FAIL: broken Dockerfile (`RUN exit 1`) to verify `end:FAILED` wiring + SSE replay (Issue #20)
#    - SHA_CRASH: slow Dockerfile (`sleep 15`) where the worker is `SIGKILL`'d mid-build and fenced
#      to `FAILED` in Postgres to verify SSE DB-status fallback when no `end:<STATUS>` marker exists
# 2. Verifies REST endpoints (`GET /api/deployments`, `GET /api/deployments/:id`)
# 3. Connects SSE Client A (at start), Client B (mid-build), and Client C (post-completion) and asserts
#    identical ordered stream IDs, zero duplicates, zero gaps, and `event: end` with `status: "LIVE"`
# 4. Reconnects with `Last-Event-ID` midway and asserts exact suffix resume with zero duplicates
# 5. Verifies failed-build SSE stream (`event: end` with `status: "FAILED"` and failure reason line)
# 6. Verifies `SIGKILL`'d worker mid-build closes the SSE stream cleanly via DB terminal fallback
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_REPO="$(mktemp -d /tmp/reapd-phase5-repo-XXXXXX)"
API_LOG="$(mktemp /tmp/reapd-phase5-api-XXXXXX.log)"
WORKER_LOG="$(mktemp /tmp/reapd-phase5-worker-XXXXXX.log)"
API_PORT=3051
TEST_SECRET="phase5-smoke-webhook-secret"
TEST_QUEUE="build-phase5-$$"
TEST_REPO_ID=999501
PR_LIVE=501
PR_FAIL=502
PR_CRASH=503
RUN_TOKEN="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_INSTALL="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_LIVE="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_FAIL="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_CRASH="$(node -e 'console.log(crypto.randomUUID())')"
API_PID=""
WORKER_PID=""

cleanup() {
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
  if [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill -9 "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_REPO" "$API_LOG" "$WORKER_LOG"
  for pr_num in "$PR_LIVE" "$PR_FAIL" "$PR_CRASH"; do
    (cd "$ROOT" && npm run reapd -- down --pr "$pr_num" >/dev/null 2>&1) || true
  done
  DEPLOY_IDS="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
    "SELECT d.id FROM deployments d JOIN pull_requests pr ON pr.id = d.pull_request_id JOIN repositories r ON r.id = pr.repo_id WHERE r.github_repo_id = $TEST_REPO_ID;" 2>/dev/null || true)"
  for did in $DEPLOY_IDS; do
    docker exec -i reapd-redis redis-cli del "logs:build:$did" >/dev/null 2>&1 || true
  done
  docker exec -i reapd-redis sh -c "redis-cli --scan --pattern 'bull:$TEST_QUEUE*' | xargs -r redis-cli del" >/dev/null 2>&1 || true
  docker exec -i reapd-postgres psql -U reapd -d reapd -q <<SQL >/dev/null 2>&1 || true
DELETE FROM webhook_deliveries WHERE delivery_id IN (
  '$DELIVERY_INSTALL', '$DELIVERY_LIVE', '$DELIVERY_FAIL', '$DELIVERY_CRASH'
);
DELETE FROM repositories WHERE github_repo_id = $TEST_REPO_ID;
SQL
}
trap cleanup EXIT

# ── 1. Create fixture Git repo with 3 commits (LIVE, FAILED, CRASH) ──────────
git -C "$TMP_REPO" init --quiet
git -C "$TMP_REPO" config user.email "smoke@reapd.local"
git -C "$TMP_REPO" config user.name "reapd-smoke"
git -C "$TMP_REPO" config commit.gpgsign false
git -C "$TMP_REPO" config uploadpack.allowReachableSHA1InWant true

cat > "$TMP_REPO/server.js" <<'EOF'
const http = require('node:http');
const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('reapd-phase5-live');
}).listen(port, '0.0.0.0');
EOF

cat > "$TMP_REPO/Dockerfile" <<EOF
FROM node:22-alpine
WORKDIR /app
RUN echo "phase5-step-1-$RUN_TOKEN" && sleep 1 && echo "phase5-step-2-$RUN_TOKEN" && sleep 1 && echo "phase5-step-3-$RUN_TOKEN"
COPY server.js ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
EOF
git -C "$TMP_REPO" add Dockerfile server.js
git -C "$TMP_REPO" commit -q -m "commit slow live build"
SHA_LIVE="$(git -C "$TMP_REPO" rev-parse HEAD)"

cat > "$TMP_REPO/Dockerfile" <<EOF
FROM node:22-alpine
WORKDIR /app
RUN echo "phase5-fail-step-$RUN_TOKEN" && echo "deliberate build failure for issue 20" >&2 && exit 1
EOF
git -C "$TMP_REPO" add Dockerfile
git -C "$TMP_REPO" commit -q -m "commit failing build"
SHA_FAIL="$(git -C "$TMP_REPO" rev-parse HEAD)"

cat > "$TMP_REPO/Dockerfile" <<EOF
FROM node:22-alpine
WORKDIR /app
RUN echo "phase5-crash-step-$RUN_TOKEN" && sleep 15
EOF
git -C "$TMP_REPO" add Dockerfile
git -C "$TMP_REPO" commit -q -m "commit slow crash build"
SHA_CRASH="$(git -C "$TMP_REPO" rev-parse HEAD)"

cd "$ROOT"
MKCERT_CAROOT="$(mkcert -CAROOT)"
export NODE_EXTRA_CA_CERTS="$MKCERT_CAROOT/rootCA.pem"

# ── 2. Start API server and BullMQ worker ────────────────────────────────────
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

echo "👷 Starting BullMQ worker..."
REAPD_REPO_URL_OVERRIDE="$TMP_REPO" REAPD_BUILD_QUEUE="$TEST_QUEUE" \
  node --import tsx "$ROOT/apps/worker/src/index.ts" >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!
sleep 1

sign_payload() {
  local payload="$1"
  printf '%s' "$payload" | openssl dgst -sha256 -hmac "$TEST_SECRET" | awk '{print "sha256="$NF}'
}

send_pr_webhook() {
  local delivery_id="$1"
  local pr_num="$2"
  local sha="$3"
  local payload
  payload="$(cat <<JSON
{
  "action": "opened",
  "number": $pr_num,
  "pull_request": {
    "number": $pr_num,
    "title": "Phase 5 SSE smoke PR #$pr_num",
    "state": "open",
    "user": { "login": "Sandesh282", "id": 1 },
    "head": { "sha": "$sha", "ref": "phase/5-smoke-$pr_num", "repo": { "id": $TEST_REPO_ID, "full_name": "Sandesh282/reapd" } },
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
  "installation": { "id": 55505 },
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

INSTALL_PAYLOAD="$(cat <<JSON
{
  "action": "created",
  "installation": { "id": 55505 },
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

# ── 3. Trigger PR #501 (LIVE) and run 3-client SSE + Last-Event-ID verification
echo "📡 Triggering PR #$PR_LIVE (slow LIVE build) and attaching SSE clients A (early), B (mid-build), C (post-completion)..."
send_pr_webhook "$DELIVERY_LIVE" "$PR_LIVE" "$SHA_LIVE"

DEPLOY_LIVE_ID="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
  "SELECT id FROM deployments WHERE subdomain = 'pr-$PR_LIVE' LIMIT 1;")"

node - "http://127.0.0.1:$API_PORT" "$DEPLOY_LIVE_ID" "$PR_LIVE" <<'NODE_EOF'
const assert = require('node:assert/strict');
const [apiBase, deployId, prNum] = process.argv.slice(2);

async function consumeSse(label, lastEventId) {
  const headers = { Accept: 'text/event-stream' };
  if (lastEventId) headers['Last-Event-ID'] = lastEventId;
  const res = await fetch(`${apiBase}/api/deployments/${deployId}/logs`, { headers });
  assert.equal(res.status, 200, `${label}: expected HTTP 200, got ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const ids = [];
  const entries = [];
  let endEvent = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sepIdx;
    while ((sepIdx = buf.indexOf('\n\n')) !== -1) {
      const rawBlock = buf.slice(0, sepIdx).trim();
      buf = buf.slice(sepIdx + 2);
      if (!rawBlock || rawBlock.startsWith(':')) continue;

      let eventType = 'message';
      let id = null;
      let data = '';
      for (const line of rawBlock.split('\n')) {
        if (line.startsWith('event:')) eventType = line.slice(6).trim();
        else if (line.startsWith('id:')) id = line.slice(3).trim();
        else if (line.startsWith('data:')) data = line.slice(5).trim();
      }
      if (eventType === 'end') {
        endEvent = JSON.parse(data);
      } else if (id) {
        ids.push(id);
        entries.push(JSON.parse(data));
      }
    }
  }
  return { ids, entries, endEvent };
}

(async () => {
  // Start Client A immediately (at build start)
  const clientAPromise = consumeSse('ClientA');

  // Wait ~1.2s so the build is mid-flight, verify the deployment is still in-flight (not LIVE yet),
  // then attach Client B so B genuinely exercises the replay-to-live-tail handoff.
  await new Promise((r) => setTimeout(r, 1200));
  const midCheckRes = await fetch(`${apiBase}/api/deployments/${deployId}`);
  const midCheckJson = await midCheckRes.json();
  assert.notEqual(
    midCheckJson.deployment.status,
    'LIVE',
    `Expected deployment to still be in-flight when Client B attached, got ${midCheckJson.deployment.status}`,
  );
  const clientBPromise = consumeSse('ClientB');

  const [resA, resB] = await Promise.all([clientAPromise, clientBPromise]);

  // Now that build is finished, attach Client C (post-completion full replay)
  const resC = await consumeSse('ClientC');

  assert.deepEqual(resA.endEvent, { status: 'LIVE' }, 'Client A must end with status LIVE');
  assert.deepEqual(resB.endEvent, { status: 'LIVE' }, 'Client B must end with status LIVE');
  assert.deepEqual(resC.endEvent, { status: 'LIVE' }, 'Client C must end with status LIVE');

  assert.ok(resA.ids.length >= 6, `Expected >= 6 log lines, got ${resA.ids.length}`);
  assert.equal(new Set(resA.ids).size, resA.ids.length, 'Client A must have zero duplicate IDs');
  assert.deepEqual(resA.ids, resB.ids, 'Client A (early) and Client B (mid-build) must receive identical ID sequence');
  assert.deepEqual(resA.ids, resC.ids, 'Client A (early) and Client C (post-completion) must receive identical ID sequence');
  assert.match(resA.entries[0].text, /-> BUILDING/, 'First entry must be -> BUILDING');

  // Reconnect with Last-Event-ID at midpoint and verify exact suffix without duplicates
  const midIdx = Math.floor(resA.ids.length / 2);
  const resumeCursor = resA.ids[midIdx];
  const resResume = await consumeSse('ClientResume', resumeCursor);
  assert.deepEqual(resResume.ids, resA.ids.slice(midIdx + 1), 'Last-Event-ID resume must return exact remaining suffix');
  assert.deepEqual(resResume.endEvent, { status: 'LIVE' });

  // Verify REST endpoints (`GET /api/deployments` and `GET /api/deployments/:id`)
  const listRes = await fetch(`${apiBase}/api/deployments?repo=Sandesh282/reapd&pr=${prNum}&limit=10`);
  assert.equal(listRes.status, 200);
  const listJson = await listRes.json();
  assert.equal(listJson.deployments.length, 1);
  assert.equal(listJson.deployments[0].id, deployId);
  assert.equal(listJson.deployments[0].status, 'LIVE');

  const detailRes = await fetch(`${apiBase}/api/deployments/${deployId}`);
  assert.equal(detailRes.status, 200);
  const detailJson = await detailRes.json();
  assert.equal(detailJson.deployment.id, deployId);
  const eventStates = detailJson.deployment.events.map((e) => e.toStatus).join('->');
  assert.equal(eventStates, 'QUEUED->BUILDING->STARTING->TESTING->LIVE');

  console.log(`✅ 3 SSE clients (A/B/C) + Last-Event-ID resume + REST endpoints verified (${resA.ids.length} entries)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE_EOF

# ── 4. Trigger PR #502 (broken Dockerfile) and verify `end:FAILED` (Issue #20)
echo "💥 Triggering PR #$PR_FAIL (broken Dockerfile) to verify end:FAILED wiring and SSE replay..."
send_pr_webhook "$DELIVERY_FAIL" "$PR_FAIL" "$SHA_FAIL"

DEPLOY_FAIL_ID="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
  "SELECT id FROM deployments WHERE subdomain = 'pr-$PR_FAIL' LIMIT 1;")"

node - "http://127.0.0.1:$API_PORT" "$DEPLOY_FAIL_ID" <<'NODE_EOF'
const assert = require('node:assert/strict');
const [apiBase, deployId] = process.argv.slice(2);

(async () => {
  const res = await fetch(`${apiBase}/api/deployments/${deployId}/logs`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(
    text,
    /\[reapd\] Build failed:[\s\S]*event: end\ndata: \{"status":"FAILED"\}/,
    'Failed build stream must emit system failure reason line BEFORE event: end FAILED',
  );

  const detailRes = await fetch(`${apiBase}/api/deployments/${deployId}`);
  const detailJson = await detailRes.json();
  assert.equal(detailJson.deployment.status, 'FAILED');
  console.log(`✅ Broken Dockerfile deployment ${deployId} SSE replay verified (DB='FAILED')`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE_EOF

FAIL_KEY="logs:build:$DEPLOY_FAIL_ID"
FAIL_LAST=""
for _ in {1..20}; do
  FAIL_LAST="$(docker exec -i reapd-redis redis-cli XREVRANGE "$FAIL_KEY" + - COUNT 1)"
  if [[ "$FAIL_LAST" == *"end:FAILED"* ]]; then
    break
  fi
  sleep 0.25
done
FAIL_TTL="$(docker exec -i reapd-redis redis-cli TTL "$FAIL_KEY")"
if [[ "$FAIL_LAST" != *"end:FAILED"* ]] || [[ "$FAIL_TTL" -le 21600 ]]; then
  echo "❌ FAIL: $FAIL_KEY must end with end:FAILED ($FAIL_LAST) and ttl > 21600 ($FAIL_TTL)"
  exit 1
fi
echo "📡 Verified failed build stream $FAIL_KEY ends with 'end:FAILED' (ttl=${FAIL_TTL}s)"

# ── 5. Trigger PR #503, SIGKILL worker mid-build, and verify DB fallback ─────
echo "💀 Triggering PR #$PR_CRASH, waiting for BUILDING, then SIGKILLing worker to test dead-worker SSE fallback..."
send_pr_webhook "$DELIVERY_CRASH" "$PR_CRASH" "$SHA_CRASH"

DEPLOY_CRASH_ID="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
  "SELECT id FROM deployments WHERE subdomain = 'pr-$PR_CRASH' LIMIT 1;")"

# Wait until PR #503 reaches BUILDING and has written at least 1 entry to its Redis stream
CRASH_CUR=""
for _ in {1..40}; do
  CRASH_CUR="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
    "SELECT status FROM deployments WHERE id = '$DEPLOY_CRASH_ID';")"
  CRASH_XLEN="$(docker exec -i reapd-redis redis-cli XLEN "logs:build:$DEPLOY_CRASH_ID")"
  if [[ "$CRASH_CUR" == "BUILDING" ]] && [[ "$CRASH_XLEN" -ge 1 ]]; then
    break
  fi
  sleep 0.25
done

if [[ "$CRASH_CUR" != "BUILDING" ]]; then
  echo "❌ FAIL: expected PR #$PR_CRASH to enter BUILDING before SIGKILL, got '$CRASH_CUR'"
  exit 1
fi

# SIGKILL the worker mid-build (so sink.end() never runs) and fence the DB row to FAILED
kill -9 "$WORKER_PID" 2>/dev/null || true
wait "$WORKER_PID" 2>/dev/null || true
WORKER_PID=""

CRASH_KEY="logs:build:$DEPLOY_CRASH_ID"
CRASH_LAST="$(docker exec -i reapd-redis redis-cli XREVRANGE "$CRASH_KEY" + - COUNT 1)"
if [[ "$CRASH_LAST" == *"end:FAILED"* ]]; then
  echo "❌ FAIL: expected SIGKILLed worker stream $CRASH_KEY to have NO end:FAILED marker ($CRASH_LAST)"
  exit 1
fi

# Simulate the reconciler fencing the stuck BUILDING row to FAILED in Postgres (with NO end:FAILED marker in Redis)
docker exec -i reapd-postgres psql -U reapd -d reapd -q -c \
  "UPDATE deployments SET status = 'FAILED', failure_reason = 'Worker SIGKILLed during smoke test', updated_at = NOW() WHERE id = '$DEPLOY_CRASH_ID';"

node - "http://127.0.0.1:$API_PORT" "$DEPLOY_CRASH_ID" <<'NODE_EOF'
const assert = require('node:assert/strict');
const [apiBase, deployId] = process.argv.slice(2);

(async () => {
  const res = await fetch(`${apiBase}/api/deployments/${deployId}/logs`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /-> BUILDING/, 'SIGKILLed stream must still replay buffered initial log lines');
  assert.match(
    text,
    /event: end\ndata: \{"status":"FAILED"\}/,
    'SIGKILLed stream with no Redis end marker must close with event: end via DB status fallback',
  );
  console.log(`✅ Dead-worker SIGKILL fallback verified on deployment ${deployId}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE_EOF

echo "✅ PASS: Phase 5 verification gate complete (REST + 3-client SSE + Last-Event-ID + end:FAILED + SIGKILL fallback)"

