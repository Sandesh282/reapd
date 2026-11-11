#!/usr/bin/env bash
# Generates local-only credentials for the dev stack and writes them to the git-ignored .env.
#
# - Creates .env from .env.example if it does not exist.
# - If POSTGRES_PASSWORD / REDIS_PASSWORD are missing from .env, generates random ones and rewrites
#   DATABASE_URL / REDIS_URL to match. Existing values are never overwritten, so it is safe to re-run.
# - If the reapd-postgres container is already running with an older password, updates the role
#   password in place (Postgres only applies POSTGRES_PASSWORD when the data volume is first created).
# - Never prints the generated secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ROOT/.env.example" "$ENV_FILE"
  echo "📄 Created .env from .env.example"
fi

has_key() { grep -qE "^$1=.+" "$ENV_FILE"; }
is_placeholder() { grep -qE "^$1=.*change-me" "$ENV_FILE"; }

need_pg=false
need_redis=false
{ ! has_key POSTGRES_PASSWORD || is_placeholder POSTGRES_PASSWORD; } && need_pg=true
{ ! has_key REDIS_PASSWORD || is_placeholder REDIS_PASSWORD; } && need_redis=true

if ! $need_pg && ! $need_redis; then
  echo "✅ .env already has Postgres and Redis credentials"
  exit 0
fi

# Replaces (or appends) KEY=VALUE in .env without using sed -i (differs between macOS and Linux).
set_key() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

get_key() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }

if $need_pg; then
  set_key POSTGRES_PASSWORD "$(openssl rand -hex 24)"
fi
if $need_redis; then
  set_key REDIS_PASSWORD "$(openssl rand -hex 24)"
fi

PG_PASS="$(get_key POSTGRES_PASSWORD)"
REDIS_PASS="$(get_key REDIS_PASSWORD)"
set_key DATABASE_URL "postgres://reapd:${PG_PASS}@localhost:5432/reapd"
set_key REDIS_URL "redis://:${REDIS_PASS}@localhost:6379"
chmod 600 "$ENV_FILE"
echo "🔐 Generated local Postgres/Redis credentials in .env (not printed)"

# Apply to an already-initialised Postgres volume (local unix socket inside the container is trusted).
if $need_pg && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx reapd-postgres; then
  docker exec -i reapd-postgres psql -U reapd -d reapd -q -v ON_ERROR_STOP=1 \
    -c "ALTER USER reapd PASSWORD '${PG_PASS}'" >/dev/null
  echo "🔁 Updated the running Postgres role password"
fi

echo "ℹ️  Recreate the stack so Redis picks up the new password: npm run infra:up"

