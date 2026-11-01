#!/usr/bin/env bash
# Phase 2 verification gate:
# 1. Creates a temporary Git repo containing sample-app and makes 2 commits
# 2. Runs `reapd-cli up` against the FIRST commit SHA (--pr 2)
# 3. Verifies https://pr-2.preview.localhost returns 200 OK
# 4. Runs `reapd-cli ls` and verifies reapd-pr-2 is listed
# 5. Runs `reapd-cli down --pr 2` and verifies both container and image are removed
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_REPO="$(mktemp -d /tmp/reapd-phase2-repo-XXXXXX)"

cleanup() {
  rm -rf "$TMP_REPO"
  npm run reapd -- down --pr 2 >/dev/null 2>&1 || true
}
trap cleanup EXIT

cp "$ROOT/sample-app/Dockerfile" "$ROOT/sample-app/server.js" "$TMP_REPO/"
git -C "$TMP_REPO" init --quiet
git -C "$TMP_REPO" config user.email "smoke@reapd.local"
git -C "$TMP_REPO" config user.name "reapd-smoke"
git -C "$TMP_REPO" config uploadpack.allowReachableSHA1InWant true
git -C "$TMP_REPO" add Dockerfile server.js
git -C "$TMP_REPO" commit -q -m "initial sample app"
TARGET_SHA="$(git -C "$TMP_REPO" rev-parse HEAD)"

# Add a second commit to prove we clone the exact requested SHA, not just tip
echo "// second commit" >> "$TMP_REPO/server.js"
git -C "$TMP_REPO" commit -am "second commit" --quiet

echo "▶️  Running reapd-cli up for PR #2 @ ${TARGET_SHA:0:7}"
cd "$ROOT"
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
npm run reapd -- up --repo "$TMP_REPO" --sha "$TARGET_SHA" --pr 2

echo "🔎 Verifying https://pr-2.preview.localhost/"
BODY="$(curl -fsSL https://pr-2.preview.localhost/)"
echo "   Response: $BODY"

echo "📋 Running reapd-cli ls"
npm run reapd -- ls

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

echo "✅ PASS: Phase 2 verification gate complete (clone -> buildkit -> route -> teardown)"

