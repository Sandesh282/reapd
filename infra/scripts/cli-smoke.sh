#!/usr/bin/env bash
# Phase 1 verification gate:
# builds sample-app, runs it hardened behind Traefik, and checks
# https://pr-1.preview.localhost serves traffic. Cleans up afterwards.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME="reapd-pr-1"
IMAGE="reapd-sample:pr-1"
HOST="pr-1.preview.localhost"
NET="reapd-preview-edge"

cleanup() { docker rm -f -v "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "🔨 Building $IMAGE"
docker build -q -t "$IMAGE" "$ROOT/sample-app"

echo "🚀 Starting hardened container"
docker run -d --name "$NAME" --network "$NET" \
  --memory 512m --memory-swap 512m --cpus 0.5 --pids-limit 100 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --log-opt max-size=10m --log-opt max-file=1 --log-opt compress=false \
  --label reapd.managed=true --label reapd.deployment_id=phase1-smoke \
  --label traefik.enable=true \
  --label "traefik.http.routers.pr-1.rule=Host(\`$HOST\`)" \
  --label traefik.http.routers.pr-1.entrypoints=websecure \
  --label traefik.http.routers.pr-1.tls=true \
  --label traefik.http.services.pr-1.loadbalancer.server.port=3000 \
  "$IMAGE" >/dev/null

echo "⏳ Waiting for https://$HOST"
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://$HOST/" || true)
  if [ "$code" = "200" ]; then
    echo "✅ PASS: https://$HOST returned 200"
    curl -s "https://$HOST/"; echo
    exit 0
  fi
  sleep 1
done

echo "❌ FAIL: https://$HOST did not return 200 (last code: $code)"
docker logs "$NAME" || true
exit 1

