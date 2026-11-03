#!/usr/bin/env bash
# Phase 2 verification gate:
# 1. Creates a temporary Git repo with two commits whose server.js returns DIFFERENT bodies
# 2. Runs `reapd-cli up` against the FIRST commit SHA (--pr 2)
# 3. Verifies https://pr-2.preview.localhost returns a body containing "reapd-v1" (not "reapd-v2")
# 4. Asserts the image reapd-pr-2:<sha7> exists in Docker before teardown
# 5. Runs `reapd-cli ls` and asserts reapd-pr-2 is listed
# 6. Runs `reapd-cli down --pr 2` and verifies both container and image are removed
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_REPO="$(mktemp -d /tmp/reapd-phase2-repo-XXXXXX)"

cleanup() {
  rm -rf "$TMP_REPO"
  # cd to ROOT explicitly: if we fail before the cd on line 33, the working dir
  # may be somewhere else and `npm run reapd` would silently do nothing
  (cd "$ROOT" && npm run reapd -- down --pr 2 >/dev/null 2>&1) || true
}
trap cleanup EXIT

# ── Commit 1: server.js returns "reapd-v1" in the body ──────────────────────
cat > "$TMP_REPO/server.js" <<'EOF'
const http = require('node:http');
const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('reapd-v1');
}).listen(port, '0.0.0.0');
EOF

cp "$ROOT/sample-app/Dockerfile" "$TMP_REPO/"

git -C "$TMP_REPO" init --quiet
git -C "$TMP_REPO" config user.email "smoke@reapd.local"
git -C "$TMP_REPO" config user.name "reapd-smoke"
git -C "$TMP_REPO" config commit.gpgsign false
git -C "$TMP_REPO" config uploadpack.allowReachableSHA1InWant true
git -C "$TMP_REPO" add Dockerfile server.js
git -C "$TMP_REPO" commit -q -m "v1: serve reapd-v1"
TARGET_SHA="$(git -C "$TMP_REPO" rev-parse HEAD)"

# ── Commit 2: different response body — proves we clone SHA, not HEAD ────────
cat > "$TMP_REPO/server.js" <<'EOF'
const http = require('node:http');
const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('reapd-v2');
}).listen(port, '0.0.0.0');
EOF
git -C "$TMP_REPO" commit -am "v2: serve reapd-v2" --quiet

echo "▶️  Running reapd-cli up for PR #2 @ ${TARGET_SHA:0:7}"
cd "$ROOT"
MKCERT_CAROOT="$(mkcert -CAROOT)"
export NODE_EXTRA_CA_CERTS="$MKCERT_CAROOT/rootCA.pem"
npm run reapd -- up --repo "$TMP_REPO" --sha "$TARGET_SHA" --pr 2

echo "🔎 Verifying https://pr-2.preview.localhost/ returns 'reapd-v1'"
BODY="$(curl -fsSL https://pr-2.preview.localhost/)"
echo "   Response: $BODY"
if [[ "$BODY" != *"reapd-v1"* ]]; then
  echo "❌ FAIL: expected body to contain 'reapd-v1', got: $BODY"
  exit 1
fi
if [[ "$BODY" == *"reapd-v2"* ]]; then
  echo "❌ FAIL: got HEAD content ('reapd-v2') instead of the pinned SHA's content"
  exit 1
fi

echo "🖼️  Verifying image reapd-pr-2:${TARGET_SHA:0:7} exists before teardown"
if ! docker images --format '{{.Repository}}:{{.Tag}}' | grep -q "^reapd-pr-2:${TARGET_SHA:0:7}$"; then
  echo "❌ FAIL: image reapd-pr-2:${TARGET_SHA:0:7} does not exist — was it never built?"
  exit 1
fi

echo "📋 Running reapd-cli ls (asserting reapd-pr-2 appears)"
LS_OUT="$(npm run reapd -- ls 2>&1)"
echo "$LS_OUT"
if ! echo "$LS_OUT" | grep -q "reapd-pr-2"; then
  echo "❌ FAIL: 'reapd-cli ls' did not list reapd-pr-2"
  exit 1
fi

echo "🧹 Running reapd-cli down --pr 2"
npm run reapd -- down --pr 2

if docker ps -a --format '{{.Names}}' | grep -q '^reapd-pr-2$'; then
  echo "❌ FAIL: container reapd-pr-2 still exists after teardown"
  exit 1
fi

if docker images --format '{{.Repository}}:{{.Tag}}' | grep -q "^reapd-pr-2:${TARGET_SHA:0:7}$"; then
  echo "❌ FAIL: image reapd-pr-2:${TARGET_SHA:0:7} still exists after teardown"
  exit 1
fi

echo "✅ PASS: Phase 2 verification gate complete (clone -> buildkit -> route -> body-check -> teardown)"
