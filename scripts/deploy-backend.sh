#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_PATH="$ROOT_DIR/supabase/functions/deploy-manifest.json"

if ! command -v supabase >/dev/null 2>&1; then
  echo "supabase CLI is required"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required"
  exit 1
fi

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

# Accept common alias names used in frontend/local env files.
export PROJECT_ID="${PROJECT_ID:-${VITE_SUPABASE_PROJECT_ID:-}}"
export SUPABASE_URL="${SUPABASE_URL:-${VITE_SUPABASE_URL:-}}"
export SUPABASE_PUBLISHABLE_KEY="${SUPABASE_PUBLISHABLE_KEY:-${VITE_SUPABASE_PUBLISHABLE_KEY:-}}"
# Keep runtime key aliases canonical. Never source legacy VITE_SUPABASE_ANON_KEY here.
export SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-${SUPABASE_PUBLISHABLE_KEY:-}}"
export SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-${VITE_SUPABASE_SERVICE_ROLE_KEY:-}}"
export CONNECTOR_WORKER_TOKEN="${CONNECTOR_WORKER_TOKEN:-${VITE_CONNECTOR_WORKER_TOKEN:-}}"
export SUPABASE_ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:-${SUPABASE_PAT:-${SUPABASE_PERSONAL_ACCESS_TOKEN:-}}}"

PROJECT_REF="${1:-${PROJECT_ID:-${VITE_SUPABASE_PROJECT_ID:-}}}"
if [[ -z "$PROJECT_REF" ]]; then
  echo "Usage: scripts/deploy-backend.sh <project-ref>"
  echo "Or set PROJECT_ID in env"
  exit 1
fi

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "Missing SUPABASE_ACCESS_TOKEN (or SUPABASE_PAT / SUPABASE_PERSONAL_ACCESS_TOKEN)."
  echo "Set it in .env before deploying functions/migrations."
  exit 1
fi

if [[ -z "${SUPABASE_ANON_KEY:-}" ]]; then
  echo "SUPABASE_ANON_KEY not found in env; fetching legacy anon key from Supabase API."
  api_keys_raw="$(NO_COLOR=1 supabase projects api-keys --project-ref "$PROJECT_REF" 2>&1 || true)"
  fetched_anon_key="$(printf "%s\n" "$api_keys_raw" | awk -F'|' '/^[[:space:]]*anon[[:space:]]*\|/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}')"
  if [[ -z "$fetched_anon_key" || "$fetched_anon_key" == "null" ]]; then
    echo "Could not resolve legacy anon key. Set SUPABASE_ANON_KEY in .env and retry."
    exit 1
  fi
  export SUPABASE_ANON_KEY="$fetched_anon_key"
fi

if [[ -z "${SUPABASE_PUBLISHABLE_KEY:-}" ]]; then
  echo "SUPABASE_PUBLISHABLE_KEY/VITE_SUPABASE_PUBLISHABLE_KEY not found; defaulting runtime publishable secret to anon key."
  export SUPABASE_PUBLISHABLE_KEY="$SUPABASE_ANON_KEY"
fi
if [[ -n "${SUPABASE_ANON_KEY:-}" && -n "${SUPABASE_PUBLISHABLE_KEY:-}" && "$SUPABASE_ANON_KEY" != "$SUPABASE_PUBLISHABLE_KEY" ]]; then
  echo "Warning: local SUPABASE_ANON_KEY differs from VITE_SUPABASE_PUBLISHABLE_KEY. Runtime will use publishable key for browser-facing function auth."
fi

if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "Missing manifest: $MANIFEST_PATH"
  exit 1
fi

echo "Running local backend artifact checks"
bash "$ROOT_DIR/scripts/verify-backend.sh"
bash "$ROOT_DIR/scripts/verify-runtime-wiring.sh" --project-ref "$PROJECT_REF"

echo "Applying migrations to linked project"
supabase db push --linked --include-all --yes

echo "Syncing runtime secrets"
# Prevent stale VITE service-role key drift; Supabase manages SUPABASE_SERVICE_ROLE_KEY natively.
if [[ -n "${PROJECT_REF:-}" ]]; then
  set +e
  supabase secrets unset VITE_SUPABASE_SERVICE_ROLE_KEY --project-ref "$PROJECT_REF" >/dev/null 2>&1
  supabase secrets unset VITE_SUPABASE_ANON_KEY --project-ref "$PROJECT_REF" >/dev/null 2>&1
  set -e
fi

secret_args=(
  --project-ref "$PROJECT_REF"
  "VITE_SUPABASE_URL=$SUPABASE_URL"
  "VITE_SUPABASE_PUBLISHABLE_KEY=$SUPABASE_PUBLISHABLE_KEY"
)
if [[ -n "${CONNECTOR_WORKER_TOKEN:-}" ]]; then
  secret_args+=("CONNECTOR_WORKER_TOKEN=$CONNECTOR_WORKER_TOKEN")
  secret_args+=("VITE_CONNECTOR_WORKER_TOKEN=$CONNECTOR_WORKER_TOKEN")
fi
supabase secrets set "${secret_args[@]}"

echo "Deploying edge functions"
FUNCTIONS=()
while IFS= read -r fn; do
  [[ -n "$fn" ]] && FUNCTIONS+=("$fn")
done < <(jq -r '.functions[]' "$MANIFEST_PATH")
for fn in "${FUNCTIONS[@]}"; do
  echo " - $fn"
  supabase functions deploy "$fn" --no-verify-jwt --project-ref "$PROJECT_REF"
done

echo "Regenerating TS types"
supabase gen types typescript --project-id "$PROJECT_REF" --schema public > "$ROOT_DIR/src/integrations/supabase/types.ts"

echo "Running post-deploy runtime wiring checks"
bash "$ROOT_DIR/scripts/verify-runtime-wiring.sh" --project-ref "$PROJECT_REF"

echo "Backend deployment completed"
