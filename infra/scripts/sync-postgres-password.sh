#!/usr/bin/env bash
# Reconciles the Postgres role password with POSTGRES_PASSWORD from .env after `compose up`.
#
# Postgres only applies POSTGRES_PASSWORD when the data volume is first created, so a kept volume
# (stack stopped, then restarted after `npm run env:init` generated new credentials) would otherwise
# reject every app connection. Inside the container, pg_hba trusts loopback and the local socket but
# requires scram-sha-256 for any other address, so we authenticate against the container's own
# non-loopback IP to test whether the password is already correct. If not, ALTER USER is run over
# the trusted socket, with the statement fed via stdin so the password never appears in `ps` output.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env"
CONTAINER="reapd-postgres"

[[ -f "$ENV_FILE" ]] || { echo "❌ .env not found — run: npm run env:init" >&2; exit 1; }

PG_PASS="$(grep -E '^POSTGRES_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
[[ -n "$PG_PASS" ]] || { echo "❌ POSTGRES_PASSWORD is empty in .env — run: npm run env:init" >&2; exit 1; }

# Wait (up to ~60s) for Postgres to accept connections over the local socket.
ready=false
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U reapd -d reapd -q 2>/dev/null; then
    ready=true
    break
  fi
  sleep 2
done
$ready || { echo "❌ $CONTAINER did not become ready" >&2; exit 1; }

# Password is passed via the docker CLI's own environment (`-e PGPASSWORD` without a value), so it is
# not part of any process argument list.
export PGPASSWORD="$PG_PASS"
if docker exec -e PGPASSWORD "$CONTAINER" sh -c 'psql -h "$(hostname -i)" -U reapd -d reapd -tAq -c "SELECT 1"' >/dev/null 2>&1; then
  echo "✅ Postgres password already matches .env"
  exit 0
fi

printf "ALTER USER reapd PASSWORD '%s';\n" "$PG_PASS" \
  | docker exec -i "$CONTAINER" psql -U reapd -d reapd -q -v ON_ERROR_STOP=1 >/dev/null
echo "🔁 Updated Postgres role password to match .env (existing volume)"

