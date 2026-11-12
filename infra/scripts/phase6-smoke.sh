#!/usr/bin/env bash
# Phase 6 verification gate (PRD v2.2 §8 — Playwright Smoke Runner & Sticky GitHub PR Comment):
# 1. Spins up a local mock GitHub REST API server (`POST /app/installations/:id/access_tokens`,
#    `POST /repos/:owner/:repo/issues/:pr/comments`, `PATCH /repos/:owner/:repo/issues/comments/:id`)
#    and generates a temporary 2048-bit RSA private key to exercise real RS256 JWT signing (`auth.ts`).
# 2. Creates a temporary Git fixture repo with 2 commits:
#    - SHA_HEALTHY: serves non-empty rendered DOM (`<h1>reapd phase 6 healthy</h1>`) with zero console errors
#    - SHA_BROKEN_JS: serves `/health` -> 200 OK, but the root page logs `console.error("deliberate phase6 console error")`
#      and throws `new Error("deliberate phase6 uncaught error")` during load
# 3. Sends `opened` webhook for PR #601 (SHA_HEALTHY):
#    - Asserts deployment reaches `LIVE`
#    - Asserts `test_runs` row has `status = 'PASSED'` and `console_error_count = 0`
#    - Asserts `pull_requests.sticky_comment_id = 9001` in Postgres and mock GitHub API recorded `1 POST` + `0 PATCH`
#      with `<!-- reapd-sticky-comment -->`, `LIVE`, and `PASSED` in the comment body
# 4. Sends `synchronize` webhook for PR #601 (SHA_BROKEN_JS) on the same PR:
#    - Asserts Generation 2 transitions `QUEUED -> BUILDING -> STARTING -> TESTING -> FAILED`
#    - Asserts `test_runs` row for Generation 2 has `status = 'FAILED'` and `console_error_count >= 1`
#    - Asserts preview container for Generation 2 was force-removed on smoke failure
#    - Asserts mock GitHub API recorded `1 POST` + `1 PATCH` (same comment `9001` updated in-place to `FAILED`
#      with `deliberate phase6` failure reason, zero duplicate comments created)
# 5. Simulates a deleted sticky comment on GitHub (mock server returns 404 on PATCH for `9001`),
#    re-runs a healthy commit (Generation 3), and asserts automatic fallback to `POST` (`comment_id = 9002`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_REPO="$(mktemp -d /tmp/reapd-phase6-repo-XXXXXX)"
TMP_KEY="$(mktemp /tmp/reapd-phase6-key-XXXXXX.pem)"
API_LOG="$(mktemp /tmp/reapd-phase6-api-XXXXXX.log)"
WORKER_LOG="$(mktemp /tmp/reapd-phase6-worker-XXXXXX.log)"
MOCK_GH_LOG="$(mktemp /tmp/reapd-phase6-mock-gh-XXXXXX.log)"
API_PORT=3061
WORKER_METRICS_PORT=19091
MOCK_GH_PORT=19061
TEST_SECRET="phase6-smoke-webhook-secret"
TEST_QUEUE="build-phase6-$$"
TEST_REPO_ID=999601
PR_NUM=601
DELIVERY_INSTALL="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_GEN1="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_GEN2="$(node -e 'console.log(crypto.randomUUID())')"
DELIVERY_GEN3="$(node -e 'console.log(crypto.randomUUID())')"
API_PID=""
WORKER_PID=""
MOCK_GH_PID=""

cleanup() {
  for pid_var in "$API_PID" "$WORKER_PID" "$MOCK_GH_PID"; do
    if [[ -n "$pid_var" ]] && kill -0 "$pid_var" 2>/dev/null; then
      kill "$pid_var" 2>/dev/null || true
      wait "$pid_var" 2>/dev/null || true
    fi
  done
  rm -rf "$TMP_REPO" "$TMP_KEY" "$API_LOG" "$WORKER_LOG" "$MOCK_GH_LOG"
  (cd "$ROOT" && npm run reapd -- down --pr "$PR_NUM" >/dev/null 2>&1) || true
  DEPLOY_IDS="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
    "SELECT d.id FROM deployments d JOIN pull_requests pr ON pr.id = d.pull_request_id JOIN repositories r ON r.id = pr.repo_id WHERE r.github_repo_id = $TEST_REPO_ID;" 2>/dev/null || true)"
  for did in $DEPLOY_IDS; do
    docker exec -i reapd-redis redis-cli del "logs:build:$did" >/dev/null 2>&1 || true
  done
  docker exec -i reapd-redis sh -c "redis-cli --scan --pattern 'bull:$TEST_QUEUE*' | xargs -r redis-cli del" >/dev/null 2>&1 || true
  docker exec -i reapd-postgres psql -U reapd -d reapd -q <<SQL >/dev/null 2>&1 || true
DELETE FROM webhook_deliveries WHERE delivery_id IN (
  '$DELIVERY_INSTALL', '$DELIVERY_GEN1', '$DELIVERY_GEN2', '$DELIVERY_GEN3'
);
DELETE FROM repositories WHERE github_repo_id = $TEST_REPO_ID;
SQL
}
trap cleanup EXIT

# ── 1. Generate temporary 2048-bit RSA private key & start mock GitHub API ───
openssl genrsa -out "$TMP_KEY" 2048 2>/dev/null

node - "$MOCK_GH_PORT" "$TMP_KEY" >"$MOCK_GH_LOG" 2>&1 <<'NODE_EOF' &
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const port = Number(process.argv[2]);
const privKeyPem = fs.readFileSync(process.argv[3], 'utf8');
const pubKey = crypto.createPublicKey(privKeyPem);

function verifyGitHubAppJwt(authHeader) {
  const m = /^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authHeader || '');
  if (!m) return false;
  const [, headerB64, payloadB64, sigB64] = m;
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  if (!verifier.verify(pubKey, Buffer.from(sigB64, 'base64url'))) {
    return false;
  }
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  return String(payload.iss) === '6001' && typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000);
}

let nextCommentId = 9001;
const comments = new Map();
const requests = [];

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const url = req.url || '/';

    if (req.method === 'GET' && url === '/_test/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        requests,
        comments: Array.from(comments.entries()).map(([id, body]) => ({ id, body })),
      }));
    }

    if (req.method === 'DELETE' && url.startsWith('/_test/comments/')) {
      const id = Number(url.split('/').pop());
      comments.delete(id);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ deleted: id }));
    }

    const parsedBody = raw ? JSON.parse(raw) : null;
    requests.push({
      method: req.method,
      url,
      auth: req.headers['authorization'] || '',
      body: parsedBody,
    });

    if (req.method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(url)) {
      if (!verifyGitHubAppJwt(req.headers['authorization'])) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Invalid RS256 GitHub App JWT' }));
      }
      const perms = parsedBody && parsedBody.permissions ? parsedBody.permissions : null;
      const validPerms =
        perms &&
        (perms.pull_requests === 'write' || perms.contents === 'read');
      if (!validPerms) {
        res.writeHead(422, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Expected permissions.pull_requests=write or contents=read' }));
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ token: 'ghs_mock_phase6_installation_token_123456' }));
    }

    const postMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(url);
    if (req.method === 'POST' && postMatch) {
      const id = nextCommentId++;
      comments.set(id, parsedBody.body);
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id, body: parsedBody.body }));
    }

    const patchMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(url);
    if (req.method === 'PATCH' && patchMatch) {
      const id = Number(patchMatch[1]);
      if (!comments.has(id)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Not Found' }));
      }
      comments.set(id, parsedBody.body);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id, body: parsedBody.body }));
    }

    const deleteMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(url);
    if (req.method === 'DELETE' && deleteMatch) {
      const id = Number(deleteMatch[1]);
      comments.delete(id);
      res.writeHead(204);
      return res.end();
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: `Unhandled mock route: ${req.method} ${url}` }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Mock GitHub API listening on 127.0.0.1:${port}`);
});
NODE_EOF
MOCK_GH_PID=$!

for _ in {1..20}; do
  if curl -fsS "http://127.0.0.1:$MOCK_GH_PORT/_test/state" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

# ── 2. Create fixture Git repo with healthy commit & runtime-error commit ────
git -C "$TMP_REPO" init --quiet
git -C "$TMP_REPO" config user.email "smoke@reapd.local"
git -C "$TMP_REPO" config user.name "reapd-smoke"
git -C "$TMP_REPO" config commit.gpgsign false
git -C "$TMP_REPO" config uploadpack.allowReachableSHA1InWant true

cat > "$TMP_REPO/server.js" <<'EOF'
const http = require('node:http');
const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><title>Phase 6</title></head><body><main><h1>reapd phase 6 healthy preview</h1></main></body></html>');
}).listen(port, '0.0.0.0');
EOF

cat > "$TMP_REPO/Dockerfile" <<'EOF'
FROM node:22-alpine
WORKDIR /app
COPY server.js ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
EOF
git -C "$TMP_REPO" add Dockerfile server.js
git -C "$TMP_REPO" commit -q -m "commit 1: healthy preview"
SHA_HEALTHY="$(git -C "$TMP_REPO" rev-parse HEAD)"

cat > "$TMP_REPO/server.js" <<'EOF'
const http = require('node:http');
const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>Phase 6 Broken</title></head><body>
    <h1>reapd phase 6 broken runtime</h1>
    <script>
      console.error("deliberate phase6 console error");
      throw new Error("deliberate phase6 uncaught error");
    </script>
  </body></html>`);
}).listen(port, '0.0.0.0');
EOF
git -C "$TMP_REPO" add server.js
git -C "$TMP_REPO" commit -q -m "commit 2: runtime console.error and uncaught pageerror"
SHA_BROKEN_JS="$(git -C "$TMP_REPO" rev-parse HEAD)"

cd "$ROOT"
MKCERT_CAROOT="$(mkcert -CAROOT)"
export NODE_EXTRA_CA_CERTS="$MKCERT_CAROOT/rootCA.pem"

# ── 3. Start API server and BullMQ worker (pointed at mock GitHub API) ───────
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

echo "👷 Starting BullMQ worker with Playwright smoke runner + sticky PR commenter..."
REAPD_REPO_URL_OVERRIDE="$TMP_REPO" \
REAPD_BUILD_QUEUE="$TEST_QUEUE" \
REAPD_WORKER_METRICS_PORT="$WORKER_METRICS_PORT" \
REAPD_SMOKE_REQUIRED="1" \
GITHUB_APP_ID="6001" \
GITHUB_PRIVATE_KEY_PATH="$TMP_KEY" \
GITHUB_API_URL="http://127.0.0.1:$MOCK_GH_PORT" \
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
  local payload
  payload="$(cat <<JSON
{
  "action": "$action",
  "number": $PR_NUM,
  "pull_request": {
    "number": $PR_NUM,
    "title": "Phase 6 Playwright smoke & sticky comment PR #$PR_NUM",
    "state": "open",
    "user": { "login": "Sandesh282", "id": 1 },
    "head": { "sha": "$sha", "ref": "phase/6-smoke-$PR_NUM", "repo": { "id": $TEST_REPO_ID, "full_name": "Sandesh282/reapd" } },
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
  "installation": { "id": 66606 },
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
  "installation": { "id": 66606 },
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

wait_for_deployment_status() {
  local deploy_id="$1"
  local target_status="$2"
  local cur=""
  for _ in {1..120}; do
    cur="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
      "SELECT status FROM deployments WHERE id = '$deploy_id';")"
    if [[ "$cur" == "$target_status" ]]; then
      return 0
    fi
    if [[ "$cur" == "FAILED" || "$cur" == "SUPERSEDED" || "$cur" == "EXPIRED" ]] && [[ "$cur" != "$target_status" ]]; then
      echo "❌ FAIL: deployment $deploy_id entered unexpected terminal status '$cur' (expected '$target_status')"
      cat "$WORKER_LOG"
      return 1
    fi
    sleep 0.5
  done
  echo "❌ FAIL: timed out waiting for deployment $deploy_id to reach '$target_status' (last='$cur')"
  cat "$WORKER_LOG"
  return 1
}

wait_for_sticky_comment_id() {
  local deploy_id="$1"
  local expected_id="$2"
  local cur=""
  for _ in {1..80}; do
    cur="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
      "SELECT COALESCE(pr.sticky_comment_id::text, '') FROM pull_requests pr JOIN deployments d ON d.pull_request_id = pr.id WHERE d.id = '$deploy_id';")"
    if [[ "$cur" == "$expected_id" ]]; then
      return 0
    fi
    sleep 0.25
  done
  echo "❌ FAIL: timed out waiting for pull_requests.sticky_comment_id = $expected_id (last='$cur')"
  cat "$WORKER_LOG"
  return 1
}

# ── 4. Scenario 1: Healthy commit -> LIVE + test_runs PASSED + sticky POST ───
echo "🟢 Triggering Generation 1 (healthy app) on PR #$PR_NUM..."
send_pr_webhook "$DELIVERY_GEN1" "opened" "$SHA_HEALTHY"

DEPLOY_GEN1_ID="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
  "SELECT id FROM deployments WHERE subdomain = 'pr-$PR_NUM' AND generation = 1 LIMIT 1;")"

wait_for_deployment_status "$DEPLOY_GEN1_ID" "LIVE"
wait_for_sticky_comment_id "$DEPLOY_GEN1_ID" "9001"

node - "http://127.0.0.1:$API_PORT" "http://127.0.0.1:$MOCK_GH_PORT" "$DEPLOY_GEN1_ID" <<'NODE_EOF'
const assert = require('node:assert/strict');
const [apiBase, mockGhBase, deployId] = process.argv.slice(2);

(async () => {
  const detailRes = await fetch(`${apiBase}/api/deployments/${deployId}`);
  assert.equal(detailRes.status, 200);
  const { deployment } = await detailRes.json();
  assert.equal(deployment.status, 'LIVE');
  assert.ok(deployment.testRun, 'Generation 1 must have a persisted testRun row');
  assert.equal(deployment.testRun.status, 'PASSED', `Expected testRun PASSED, got ${deployment.testRun.status}`);
  assert.equal(deployment.testRun.consoleErrorCount, 0);

  const ghRes = await fetch(`${mockGhBase}/_test/state`);
  const ghState = await ghRes.json();
  const postComments = ghState.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/issues/601/comments'));
  const patchComments = ghState.requests.filter((r) => r.method === 'PATCH');
  const tokenMints = ghState.requests.filter((r) => r.method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(r.url));
  assert.ok(
    tokenMints.some((r) => r.body && r.body.permissions && r.body.permissions.pull_requests === 'write'),
    'Must mint installation token with permissions.pull_requests = write',
  );
  assert.equal(postComments.length, 1, 'Generation 1 must POST exactly 1 sticky comment');
  assert.equal(patchComments.length, 0, 'Generation 1 must not PATCH');
  assert.equal(ghState.comments.length, 1);
  assert.equal(ghState.comments[0].id, 9001);
  assert.match(ghState.comments[0].body, /<!-- reapd-sticky-comment -->/);
  assert.match(ghState.comments[0].body, /reapd Preview — LIVE/);
  assert.match(ghState.comments[0].body, /PASSED/);
  console.log(`✅ Generation 1 verified: LIVE + test_runs=PASSED + sticky comment #9001 created via POST`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE_EOF

# ── 5. Scenario 2: Broken JS commit -> FAILED + container rolled back + sticky PATCH
echo "💥 Triggering Generation 2 (runtime console.error + uncaught error) on PR #$PR_NUM..."
send_pr_webhook "$DELIVERY_GEN2" "synchronize" "$SHA_BROKEN_JS"

DEPLOY_GEN2_ID="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
  "SELECT id FROM deployments WHERE subdomain = 'pr-$PR_NUM' AND generation = 2 LIMIT 1;")"

wait_for_deployment_status "$DEPLOY_GEN2_ID" "FAILED"

if docker ps -a --format '{{.Names}}' | grep -qx "reapd-pr-$PR_NUM"; then
  echo "❌ FAIL: preview container reapd-pr-$PR_NUM should have been force-removed after Playwright smoke failure"
  exit 1
fi

node - "http://127.0.0.1:$API_PORT" "http://127.0.0.1:$MOCK_GH_PORT" "$DEPLOY_GEN2_ID" <<'NODE_EOF'
const assert = require('node:assert/strict');
const [apiBase, mockGhBase, deployId] = process.argv.slice(2);

(async () => {
  const detailRes = await fetch(`${apiBase}/api/deployments/${deployId}`);
  assert.equal(detailRes.status, 200);
  const { deployment } = await detailRes.json();
  assert.equal(deployment.status, 'FAILED');
  assert.match(deployment.failureReason || '', /deliberate phase6/);
  assert.ok(deployment.testRun, 'Generation 2 must have a persisted testRun row');
  assert.equal(deployment.testRun.status, 'FAILED');
  assert.ok(deployment.testRun.consoleErrorCount >= 1, `Expected consoleErrorCount >= 1, got ${deployment.testRun.consoleErrorCount}`);

  const eventStates = deployment.events.map((e) => e.toStatus).join('->');
  assert.equal(eventStates, 'QUEUED->BUILDING->STARTING->TESTING->FAILED');

  // Poll mock GitHub server until the asynchronous PATCH lands (up to 15s)
  let ghState = null;
  for (let i = 0; i < 60; i++) {
    const ghRes = await fetch(`${mockGhBase}/_test/state`);
    ghState = await ghRes.json();
    const patches = ghState.requests.filter((r) => r.method === 'PATCH' && r.url.endsWith('/issues/comments/9001'));
    if (patches.length >= 1) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const postComments = ghState.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/issues/601/comments'));
  const patchComments = ghState.requests.filter((r) => r.method === 'PATCH' && r.url.endsWith('/issues/comments/9001'));
  assert.equal(postComments.length, 1, 'Must still have only 1 POST (no duplicate comment created)');
  assert.equal(patchComments.length, 1, 'Generation 2 must PATCH existing sticky comment #9001 in-place');
  assert.equal(ghState.comments.length, 1);
  assert.match(ghState.comments[0].body, /reapd Preview — FAILED/);
  assert.match(ghState.comments[0].body, /deliberate phase6/);
  console.log(`✅ Generation 2 verified: TESTING -> FAILED + container removed + sticky comment #9001 updated in-place via PATCH`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE_EOF

# ── 6. Scenario 3: Deleted comment on GitHub (404 on PATCH) -> fallback POST ─
echo "🔄 Deleting comment #9001 on mock GitHub server and triggering Generation 3 to verify 404 -> POST fallback..."
curl -fsS -X DELETE "http://127.0.0.1:$MOCK_GH_PORT/_test/comments/9001" >/dev/null

send_pr_webhook "$DELIVERY_GEN3" "synchronize" "$SHA_HEALTHY"

DEPLOY_GEN3_ID="$(docker exec -i reapd-postgres psql -U reapd -d reapd -tAq -c \
  "SELECT id FROM deployments WHERE subdomain = 'pr-$PR_NUM' AND generation = 3 LIMIT 1;")"

wait_for_deployment_status "$DEPLOY_GEN3_ID" "LIVE"
wait_for_sticky_comment_id "$DEPLOY_GEN3_ID" "9002"
echo "✅ Generation 3 verified: 404 on deleted comment #9001 automatically fell back to POST (#9002)"

# ── 7. Verify Prometheus /metrics on API and Worker ──────────────────────────
node - "http://127.0.0.1:$API_PORT/metrics" "http://127.0.0.1:$WORKER_METRICS_PORT/metrics" <<'NODE_EOF'
const assert = require('node:assert/strict');
const [apiMetricsUrl, workerMetricsUrl] = process.argv.slice(2);

(async () => {
  const apiRes = await fetch(apiMetricsUrl);
  assert.equal(apiRes.status, 200);
  const apiText = await apiRes.text();
  assert.match(apiText, /reapd_webhook_requests_total\{[^}]*event="pull_request"[^}]*action="opened"[^}]*\}\s+1\b/);
  assert.match(apiText, /reapd_webhook_requests_total\{[^}]*event="pull_request"[^}]*action="synchronize"[^}]*\}\s+2\b/);

  const workerRes = await fetch(workerMetricsUrl);
  assert.equal(workerRes.status, 200);
  const workerText = await workerRes.text();
  assert.match(workerText, /reapd_deployments_total\{[^}]*status="LIVE"[^}]*\}\s+2\b/);
  assert.match(workerText, /reapd_deployments_total\{[^}]*status="FAILED"[^}]*\}\s+1\b/);
  assert.match(workerText, /reapd_smoke_results_total\{[^}]*result="PASSED"[^}]*\}\s+2\b/);
  assert.match(workerText, /reapd_smoke_results_total\{[^}]*result="FAILED"[^}]*\}\s+1\b/);
  assert.match(workerText, /reapd_build_duration_seconds_count\{[^}]*\}\s+3\b/);
  console.log('✅ Prometheus /metrics verified on API and Worker (deployments, smoke results, build duration, webhooks)');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE_EOF

echo "✅ PASS: Phase 6 verification gate complete (Playwright smoke PASSED/FAILED + rollback + sticky PR comment POST/PATCH/404-fallback)"
