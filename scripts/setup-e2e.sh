#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROJECT_REF="${PROJECT_ID:-${VITE_SUPABASE_PROJECT_ID:-}}"
DO_DEPLOY=1
STRICT_RUNTIME=0

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

PROJECT_REF="${PROJECT_REF:-${PROJECT_ID:-${VITE_SUPABASE_PROJECT_ID:-}}}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-ref)
      PROJECT_REF="${2:-}"
      shift 2
      ;;
    --no-deploy)
      DO_DEPLOY=0
      shift
      ;;
    --strict-runtime)
      STRICT_RUNTIME=1
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: scripts/setup-e2e.sh [--project-ref <ref>] [--no-deploy] [--strict-runtime]"
      exit 1
      ;;
  esac
done

echo "OpsAI end-to-end setup started"
echo "Theme: Your Enterprise AI Operating Layer"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required"
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$node_major" -lt 20 ]]; then
    echo "Warning: Node.js 20+ is recommended. Current version: $(node -v)"
  fi
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required"
  exit 1
fi

if [[ $DO_DEPLOY -eq 1 ]] && ! command -v supabase >/dev/null 2>&1; then
  echo "supabase CLI is required when deploy is enabled"
  exit 1
fi

echo "Installing dependencies"
cd "$ROOT_DIR"
npm install

echo "Running backend artifact checks"
bash "$ROOT_DIR/scripts/verify-backend.sh"

if command -v supabase >/dev/null 2>&1; then
  echo "Syncing local Supabase keys from linked project"
  bash "$ROOT_DIR/scripts/sync-supabase-env-keys.sh" "$ROOT_DIR/.env"
fi

echo "Running runtime wiring checks"
if [[ $STRICT_RUNTIME -eq 1 ]]; then
  bash "$ROOT_DIR/scripts/verify-runtime-wiring.sh" --project-ref "$PROJECT_REF" --strict
else
  bash "$ROOT_DIR/scripts/verify-runtime-wiring.sh" --project-ref "$PROJECT_REF"
fi

if [[ $DO_DEPLOY -eq 1 ]]; then
  if [[ -z "$PROJECT_REF" ]]; then
    echo "Missing project ref. Pass --project-ref <ref> or set PROJECT_ID / VITE_SUPABASE_PROJECT_ID."
    exit 1
  fi
  echo "Deploying backend to $PROJECT_REF"
  bash "$ROOT_DIR/scripts/deploy-backend.sh" "$PROJECT_REF"
fi

echo "Running frontend build"
npm run build

echo "OpsAI end-to-end setup complete"
echo "Next:"
echo "1) Start app: npm run dev"
echo "2) Start worker (separate terminal): npm run worker:run"
if [[ -n "$PROJECT_REF" ]]; then
  echo "3) Run strict runtime check anytime: bash scripts/verify-runtime-wiring.sh --strict --project-ref \"$PROJECT_REF\""
else
  echo "3) Run strict runtime check anytime: bash scripts/verify-runtime-wiring.sh --strict --project-ref <supabase-project-ref>"
fi
