#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE"
  exit 1
fi

if ! command -v supabase >/dev/null 2>&1; then
  echo "supabase CLI is required"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

PROJECT_REF="${PROJECT_ID:-${VITE_SUPABASE_PROJECT_ID:-}}"
if [[ -z "${PROJECT_REF:-}" ]]; then
  echo "Missing project ref. Set PROJECT_ID or VITE_SUPABASE_PROJECT_ID in $ENV_FILE."
  exit 1
fi

api_keys_raw="$(NO_COLOR=1 supabase projects api-keys --project-ref "$PROJECT_REF" 2>&1)"
anon_key="$(printf "%s\n" "$api_keys_raw" | awk -F'|' '/^[[:space:]]*anon[[:space:]]*\|/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}')"
service_key="$(printf "%s\n" "$api_keys_raw" | awk -F'|' '/^[[:space:]]*service_role[[:space:]]*\|/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}')"
publishable_key="$(printf "%s\n" "$api_keys_raw" | awk -F'|' '/^[[:space:]]*default[[:space:]]*\|/ && $2 ~ /sb_publishable_/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}')"

if [[ -z "$anon_key" || -z "$service_key" ]]; then
  echo "Could not parse anon/service role keys from Supabase CLI output."
  exit 1
fi

if [[ -z "$publishable_key" ]]; then
  publishable_key="${VITE_SUPABASE_PUBLISHABLE_KEY:-$anon_key}"
fi

tmp_file="$(mktemp)"
awk -F'=' \
  -v anon="$anon_key" \
  -v svc="$service_key" \
  -v pub="$publishable_key" '
BEGIN { seen_anon=0; seen_svc=0; seen_pub=0 }
/^[[:space:]]*SUPABASE_ANON_KEY=/ { print "SUPABASE_ANON_KEY=" anon; seen_anon=1; next }
/^[[:space:]]*SUPABASE_SERVICE_ROLE_KEY=/ { print "SUPABASE_SERVICE_ROLE_KEY=" svc; seen_svc=1; next }
/^[[:space:]]*VITE_SUPABASE_PUBLISHABLE_KEY=/ { print "VITE_SUPABASE_PUBLISHABLE_KEY=" pub; seen_pub=1; next }
{ print $0 }
END {
  if (!seen_anon) print "SUPABASE_ANON_KEY=" anon;
  if (!seen_svc) print "SUPABASE_SERVICE_ROLE_KEY=" svc;
  if (!seen_pub) print "VITE_SUPABASE_PUBLISHABLE_KEY=" pub;
}
' "$ENV_FILE" > "$tmp_file"
mv "$tmp_file" "$ENV_FILE"

echo "Synced Supabase keys in $ENV_FILE for project $PROJECT_REF"
echo "Updated: SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_PUBLISHABLE_KEY"
