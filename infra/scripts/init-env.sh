#!/usr/bin/env bash
# Generates local-only credentials for the dev stack and writes them to the git-ignored .env.
#
# - Creates .env from .env.example if it does not exist (mode 600).
# - If POSTGRES_PASSWORD / REDIS_PASSWORD are missing or still the `change-me` placeholder, generates
#   random ones. Existing real values are never overwritten, so it is safe to re-run.
# - DATABASE_URL / REDIS_URL are rewritten only when missing or still the placeholder/default value,
#   so custom hosts, ports or database names are preserved.
# - Never prints the generated secrets.
#
# NOTE: this script only edits .env. Postgres applies POSTGRES_PASSWORD only when its data volume is
# first created, so `infra/scripts/sync-postgres-password.sh` (run after `compose up`) reconciles an
# existing volume with the new password.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ROOT/.env.example" "$ENV_FILE"
  echo "📄 Created .env from .env.example"
fi
chmod 600 "$ENV_FILE"

get_key() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }
has_real_value() {
  local v
  v="$(get_key "$1")"
  [[ -n "$v" && "$v" != *change-me* ]]
}

# Replaces (or appends) KEY=VALUE in .env without using sed -i (differs between macOS and Linux).
set_key() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

changed=false

if ! has_real_value POSTGRES_PASSWORD; then
  set_key POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  changed=true
fi
if ! has_real_value REDIS_PASSWORD; then
  set_key REDIS_PASSWORD "$(openssl rand -hex 24)"
  changed=true
fi

PG_PASS="$(get_key POSTGRES_PASSWORD)"
REDIS_PASS="$(get_key REDIS_PASSWORD)"

# Only (re)write the connection URLs while they are missing / placeholder / the old public default.
db_url="$(get_key DATABASE_URL)"
if [[ -z "$db_url" || "$db_url" == *change-me* || "$db_url" == *reapd_dev_password* ]]; then
  set_key DATABASE_URL "postgres://reapd:${PG_PASS}@localhost:5432/reapd"
  changed=true
fi
redis_url="$(get_key REDIS_URL)"
if [[ -z "$redis_url" || "$redis_url" == *change-me* || "$redis_url" == "redis://localhost:6379" ]]; then
  set_key REDIS_URL "redis://:${REDIS_PASS}@localhost:6379"
  changed=true
fi

if $changed; then
  echo "🔐 Generated/updated local Postgres/Redis credentials in .env (not printed)"
else
  echo "✅ .env already has Postgres and Redis credentials"
fi
