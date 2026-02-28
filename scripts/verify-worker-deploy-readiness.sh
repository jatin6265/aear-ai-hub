#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
STRICT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict)
      STRICT=1
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: scripts/verify-worker-deploy-readiness.sh [--strict]"
      exit 1
      ;;
  esac
done

if [[ -f "$ENV_FILE" ]]; then
  while IFS= read -r line; do
    trimmed="$(echo "$line" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
    [[ -z "$trimmed" || "$trimmed" == \#* ]] && continue
    if [[ "$trimmed" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      raw_value="${BASH_REMATCH[2]}"
      if [[ -z "${!key:-}" ]]; then
        value="${raw_value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        export "$key=$value"
      fi
    fi
  done < "$ENV_FILE"
fi

required=(
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  CONNECTOR_WORKER_TOKEN
  OPENAI_API_KEY
)

missing=0
for key in "${required[@]}"; do
  value="${!key:-}"
  if [[ -z "$value" ]]; then
    echo "Missing required worker env: $key"
    missing=1
  fi
done

if [[ $missing -ne 0 ]]; then
  exit 1
fi

EMBEDDING_MODEL="${OPENAI_EMBEDDING_MODEL:-text-embedding-3-small}"
if [[ "${EMBEDDING_MODEL}" != "text-embedding-3-small" ]]; then
  echo "Invalid OPENAI_EMBEDDING_MODEL: expected text-embedding-3-small, got ${EMBEDDING_MODEL}"
  exit 1
fi

WORKER_RUNTIME_MODE="$(echo "${WORKER_RUNTIME_MODE:-polling}" | tr '[:upper:]' '[:lower:]')"
if [[ "$WORKER_RUNTIME_MODE" != "polling" && "$WORKER_RUNTIME_MODE" != "queue" ]]; then
  echo "Invalid WORKER_RUNTIME_MODE: $WORKER_RUNTIME_MODE (expected polling|queue)"
  exit 1
fi

if [[ "$WORKER_RUNTIME_MODE" == "queue" && -z "${REDIS_URL:-}" ]]; then
  echo "Missing REDIS_URL for WORKER_RUNTIME_MODE=queue"
  exit 1
fi

if [[ "$WORKER_RUNTIME_MODE" == "polling" && -z "${REDIS_URL:-}" ]]; then
  echo "Warning: REDIS_URL is not set."
  echo "Polling mode is valid for Phase 1, but queue mode and Phase-2 worker split require Redis."
  if [[ $STRICT -eq 1 ]]; then
    echo "Strict mode enabled: REDIS_URL is required."
    exit 1
  fi
fi

if [[ ! -f "$ROOT_DIR/worker/connector-worker.mjs" ]]; then
  echo "Missing worker runtime: worker/connector-worker.mjs"
  exit 1
fi

if [[ ! -f "$ROOT_DIR/railway.worker.json" ]]; then
  echo "Missing Railway worker config: railway.worker.json"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required"
  exit 1
fi

echo "Running worker drift verification"
bash "$ROOT_DIR/scripts/verify-worker-runtime-drift.sh"

echo "Running worker typecheck"
(
  cd "$ROOT_DIR/worker"
  npm run typecheck
)

echo "Worker deploy readiness passed"
