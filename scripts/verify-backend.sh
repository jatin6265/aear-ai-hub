#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

required_files=(
  "supabase/migrations/20260222060000_platform_continuation_core.sql"
  "supabase/migrations/20260222073000_queue_claims_and_governed_sql.sql"
  "supabase/migrations/20260222080000_job_recovery_and_queue_maintenance.sql"
  "supabase/migrations/20260222090000_schema_driven_agent_regeneration.sql"
  "supabase/migrations/20260222100000_knowledge_reindex_and_health.sql"
  "supabase/migrations/20260222123000_agents_dashboard_backend.sql"
  "supabase/migrations/20260222133000_agent_detail_backend.sql"
  "supabase/migrations/20260228123000_hybrid_memory_search.sql"
  "supabase/migrations/20260228131500_mcp_bootstrap_runtime.sql"
  "supabase/functions/connector-sync-dispatch/index.ts"
  "supabase/functions/connector-sync-worker-callback/index.ts"
  "supabase/functions/knowledge-embed-worker-dispatch/index.ts"
  "supabase/functions/knowledge-reindex-dispatch/index.ts"
  "supabase/functions/tenant-entitlements-check/index.ts"
  "supabase/functions/agent-regenerate/index.ts"
  "supabase/functions/agents-dashboard/index.ts"
  "supabase/functions/agent-set-enabled/index.ts"
  "supabase/functions/agent-detail/index.ts"
  "supabase/functions/stripe-webhook/index.ts"
  "supabase/functions/webhook-slack/index.ts"
  "supabase/functions/webhook-whatsapp/index.ts"
  "supabase/functions/webhook-telegram/index.ts"
  "supabase/functions/webhook-teams/index.ts"
  "supabase/functions/create-checkout-session/index.ts"
  "supabase/functions/razorpay-webhook/index.ts"
  "supabase/functions/report-usage/index.ts"
  "supabase/functions/check-plan-limits/index.ts"
  "supabase/functions/chat-completion/index.ts"
  "supabase/functions/discover-connection/index.ts"
  "supabase/functions/generate-nl-sql/index.ts"
  "supabase/functions/marketplace-directory/index.ts"
  "supabase/functions/oauth-start/index.ts"
  "supabase/functions/oauth-callback/index.ts"
  "supabase/functions/_shared/integration-runtime.ts"
  "scripts/verify-runtime-wiring.sh"
  "scripts/verify-worker-runtime-drift.sh"
  "scripts/verify-worker-deploy-readiness.sh"
  "scripts/test-openclaw-bridge.mjs"
  "scripts/setup-e2e.sh"
)

for path in "${required_files[@]}"; do
  if [[ ! -f "$ROOT_DIR/$path" ]]; then
    echo "Missing required backend artifact: $path"
    exit 1
  fi
done

echo "Backend artifacts present"
