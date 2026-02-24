#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_PATH="$ROOT_DIR/supabase/functions/deploy-manifest.json"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

PROJECT_REF="${PROJECT_ID:-${VITE_SUPABASE_PROJECT_ID:-}}"
STRICT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-ref)
      PROJECT_REF="${2:-}"
      shift 2
      ;;
    --strict)
      STRICT=1
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: scripts/verify-runtime-wiring.sh [--project-ref <ref>] [--strict]"
      exit 1
      ;;
  esac
done

if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "Missing manifest: $MANIFEST_PATH"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required"
  exit 1
fi

echo "Checking function sources from deploy manifest"
FUNCTIONS=()
while IFS= read -r fn; do
  [[ -n "$fn" ]] && FUNCTIONS+=("$fn")
done < <(jq -r '.functions[]' "$MANIFEST_PATH")
missing_sources=0
for fn in "${FUNCTIONS[@]}"; do
  if [[ ! -f "$ROOT_DIR/supabase/functions/$fn/index.ts" ]]; then
    echo "Missing function source: supabase/functions/$fn/index.ts"
    missing_sources=1
  fi
done
if [[ $missing_sources -ne 0 ]]; then
  exit 1
fi

echo "Checking critical backend SQL contracts"
required_sql_symbols=(
  "FUNCTION public.enqueue_connector_sync"
  "FUNCTION public.execute_tenant_sql_governed"
  "FUNCTION public.evaluate_action_policy"
  "FUNCTION public.search_knowledge_documents_hybrid"
  "FUNCTION public.regenerate_agents_for_tenant"
  "FUNCTION public.schedule_knowledge_embedding_reindex"
)

for symbol in "${required_sql_symbols[@]}"; do
  if ! rg -q "$symbol" "$ROOT_DIR/supabase/migrations"; then
    echo "Missing SQL contract: $symbol"
    exit 1
  fi
done

echo "Checking critical frontend to backend wiring"
required_pattern_pairs=(
  "src/pages/Connections.tsx::connector-sync-dispatch"
  "src/pages/ConnectionSchemaDetail.tsx::connector-sync-dispatch"
  "src/pages/KnowledgeBase.tsx::knowledge-reindex-dispatch"
  "src/pages/Chat.tsx::chat-execute"
  "src/pages/Approvals.tsx::approvals-queue"
  "src/pages/Guardrails.tsx::guardrails-config"
  "src/pages/Agents.tsx::agents-dashboard|agent-studio"
  "src/pages/Team.tsx::team-management"
  "src/pages/Insights.tsx::insights-feed"
  "src/pages/InsightAnomalyDetail.tsx::anomaly-detail"
)

for pair in "${required_pattern_pairs[@]}"; do
  file="${pair%%::*}"
  pattern="${pair#*::}"
  full_path="$ROOT_DIR/$file"
  if [[ ! -f "$full_path" ]]; then
    echo "Missing critical page: $file"
    exit 1
  fi
  if ! rg -q "$pattern" "$full_path"; then
    echo "Missing backend wiring in $file (expected pattern: $pattern)"
    exit 1
  fi
done

echo "Scanning critical runtime paths for simulated/static fallbacks"
marker_pattern="synthetic|simulated|local simulation path|backend function isn't deployed|placeholder for now|mockup"
marker_scope=(
  "$ROOT_DIR/src/pages/Chat.tsx"
  "$ROOT_DIR/src/pages/Connections.tsx"
  "$ROOT_DIR/src/pages/ConnectionSchemaDetail.tsx"
  "$ROOT_DIR/src/pages/KnowledgeBase.tsx"
  "$ROOT_DIR/src/pages/Insights.tsx"
  "$ROOT_DIR/src/pages/Agents.tsx"
  "$ROOT_DIR/worker/connector-worker.mjs"
  "$ROOT_DIR/supabase/functions/tool-execute/index.ts"
  "$ROOT_DIR/supabase/functions/notification-settings/index.ts"
)

marker_hits="$(rg -n -i "$marker_pattern" "${marker_scope[@]}" || true)"
if [[ -n "$marker_hits" ]]; then
  echo "Runtime warnings (potential simulation/static behavior detected):"
  echo "$marker_hits"
  if [[ $STRICT -eq 1 ]]; then
    echo "Strict mode enabled: failing because simulation/static markers were found."
    exit 1
  fi
fi

dead_anchor_hits="$(rg -n 'href="#"' "$ROOT_DIR/src/pages" "$ROOT_DIR/src/components" || true)"
if [[ -n "$dead_anchor_hits" ]]; then
  echo "UI warnings (dead anchor links detected):"
  echo "$dead_anchor_hits"
  if [[ $STRICT -eq 1 ]]; then
    echo "Strict mode enabled: failing because dead anchor links were found."
    exit 1
  fi
fi

if command -v supabase >/dev/null 2>&1 && [[ -n "$PROJECT_REF" ]]; then
  echo "Checking deployed functions in project: $PROJECT_REF"
  set +e
  functions_output="$(supabase functions list --project-ref "$PROJECT_REF" 2>&1)"
  status=$?
  set -e
  if [[ $status -ne 0 ]]; then
    echo "Warning: could not query deployed functions for project $PROJECT_REF"
    echo "$functions_output"
  else
    missing_remote=0
    for fn in "${FUNCTIONS[@]}"; do
      if ! printf "%s\n" "$functions_output" | rg -q "(^|[[:space:]])$fn([[:space:]]|$)"; then
        echo "Warning: function not found in remote list: $fn"
        missing_remote=1
      fi
    done
    if [[ $missing_remote -ne 0 && $STRICT -eq 1 ]]; then
      echo "Strict mode enabled: remote function list is incomplete."
      exit 1
    fi
  fi

  echo "Checking critical Supabase secrets are aligned with local .env"
  set +e
  secrets_output="$(supabase secrets list --project-ref "$PROJECT_REF" 2>&1)"
  secrets_status=$?
  set -e
  if [[ $secrets_status -ne 0 ]]; then
    echo "Warning: could not query remote secrets for project $PROJECT_REF"
    echo "$secrets_output"
  else
    digest_of() {
      local value="${1:-}"
      printf "%s" "$value" | shasum -a 256 | awk '{print $1}'
    }

    remote_digest_for() {
      local key="$1"
      printf "%s\n" "$secrets_output" | awk -F'|' -v target="$key" '
        {
          name=$1
          digest=$2
          gsub(/^ +| +$/, "", name)
          gsub(/^ +| +$/, "", digest)
          if (name == target) {
            print digest
            exit
          }
        }'
    }

    secret_keys=(
      "SUPABASE_URL"
      "VITE_SUPABASE_URL"
      "VITE_SUPABASE_PUBLISHABLE_KEY"
      "CONNECTOR_WORKER_TOKEN"
      "SUPABASE_SERVICE_ROLE_KEY"
    )

    optional_secret_keys=(
      "VITE_SUPABASE_SERVICE_ROLE_KEY"
      "VITE_CONNECTOR_WORKER_TOKEN"
    )

    mismatch_count=0
    for key in "${secret_keys[@]}"; do
      local_value="${!key:-}"
      if [[ -z "$local_value" ]]; then
        echo "Warning: local env missing $key"
        continue
      fi

      local_digest="$(digest_of "$local_value")"
      remote_digest="$(remote_digest_for "$key")"
      if [[ -z "$remote_digest" ]]; then
        echo "Warning: remote secret missing $key"
        mismatch_count=$((mismatch_count + 1))
        continue
      fi
      if [[ "$local_digest" != "$remote_digest" ]]; then
        if [[ "$key" == "SUPABASE_SERVICE_ROLE_KEY" ]]; then
          echo "Warning: local $key differs from project-managed runtime key. This can be valid when using legacy service_role JWT locally."
        else
          echo "Warning: remote secret digest mismatch for $key (local and deployed values differ)"
          mismatch_count=$((mismatch_count + 1))
        fi
      fi
    done

    for key in "${optional_secret_keys[@]}"; do
      local_value="${!key:-}"
      [[ -z "$local_value" ]] && continue
      local_digest="$(digest_of "$local_value")"
      remote_digest="$(remote_digest_for "$key")"
      if [[ -z "$remote_digest" ]]; then
        echo "Warning: remote optional secret missing $key"
        continue
      fi
      if [[ "$local_digest" != "$remote_digest" ]]; then
        echo "Warning: remote optional secret digest mismatch for $key"
      fi
    done

    # Guard against split-brain runtime configs where duplicated keys drift.
    remote_service_digest="$(remote_digest_for "SUPABASE_SERVICE_ROLE_KEY")"
    remote_vite_service_digest="$(remote_digest_for "VITE_SUPABASE_SERVICE_ROLE_KEY")"
    if [[ -n "$remote_service_digest" && -n "$remote_vite_service_digest" && "$remote_service_digest" != "$remote_vite_service_digest" ]]; then
      echo "Warning: remote service role key digests differ between SUPABASE_SERVICE_ROLE_KEY and VITE_SUPABASE_SERVICE_ROLE_KEY"
      mismatch_count=$((mismatch_count + 1))
    fi

    remote_worker_digest="$(remote_digest_for "CONNECTOR_WORKER_TOKEN")"
    remote_vite_worker_digest="$(remote_digest_for "VITE_CONNECTOR_WORKER_TOKEN")"
    if [[ -n "$remote_worker_digest" && -n "$remote_vite_worker_digest" && "$remote_worker_digest" != "$remote_vite_worker_digest" ]]; then
      echo "Warning: remote worker token digests differ between CONNECTOR_WORKER_TOKEN and VITE_CONNECTOR_WORKER_TOKEN"
      mismatch_count=$((mismatch_count + 1))
    fi

    remote_publishable_digest="$(remote_digest_for "SUPABASE_PUBLISHABLE_KEY")"
    remote_vite_publishable_digest="$(remote_digest_for "VITE_SUPABASE_PUBLISHABLE_KEY")"
    if [[ -n "$remote_publishable_digest" && -n "$remote_vite_publishable_digest" && "$remote_publishable_digest" != "$remote_vite_publishable_digest" ]]; then
      echo "Warning: remote publishable key digests differ between SUPABASE_PUBLISHABLE_KEY and VITE_SUPABASE_PUBLISHABLE_KEY"
      mismatch_count=$((mismatch_count + 1))
    fi

    if [[ $mismatch_count -ne 0 && $STRICT -eq 1 ]]; then
      echo "Strict mode enabled: secret mismatches detected."
      exit 1
    fi
  fi
fi

echo "Runtime wiring verification complete"
