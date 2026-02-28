# Contract Map (Build Plan Names -> Canonical Contracts)

## Database Contracts

- `agents` -> `ai_agents`
- `tools` -> `tool_registry`
- `agent_memory` -> `agent_memory_entries`
- `schema_entities` -> `connection_entities`
- `tenant_integrations` -> `tenant_integration_installs`
- `credentials` -> `integration_credentials`
- `tenant_tools` -> `tool_registry` (tenant scoped)
- `hybrid_search` -> compatibility RPC over `embeddings` + `context_events`
- `bootstrap_tenant_integration_runtime` -> install-time MCP/tool/sync bootstrap
- `teardown_tenant_integration_runtime` -> uninstall-time runtime deactivation
- `risk_policies` -> `risk_matrix_rules`
- `subscription_plans` -> `pricing_plans`
- `roles` -> `raci_roles`
- `role_members` -> `raci_role_members`
- `sync_jobs` -> `connection_sync_runs`
- `invoices` -> `invoice_snapshots`

## Function Contracts

- `chat-completion` -> `chat-execute`
- `discover-connection` -> `connector-sync-dispatch`
- `embed-content` -> `knowledge-embed-worker-dispatch`
- `request-approval` -> `chat-action-update` (`operation=request_approval`)
- `execute-approved-action` -> `chat-action-update` (`operation=approve_execute`)
- `send-invitation` -> `send-team-invites`
- `check-plan-limits` -> `tenant-entitlements-check`

## Runtime Contracts

- Production worker runtime: `worker/connector-worker.mjs`
- Modular typed runtime: `worker/src/*`
- Drift control script: `scripts/verify-worker-runtime-drift.sh`
- Worker mode switch: `WORKER_RUNTIME_MODE=polling|queue` (`queue` requires `REDIS_URL`)

## Governance Invariants

- Every critical action path must call `evaluate_action_policy`.
- HIGH/CRITICAL execution must flow through approval RPCs.
- `audit_logs` remains immutable via DB trigger enforcement.
