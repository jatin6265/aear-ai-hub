# Phase 1 Gap Matrix

This matrix tracks OpsAI Phase 1 deliverables from the Build Plan against the canonical implementation in this repository.

## B1-B18 Schema and RLS

| Build Plan Item | Status | Canonical Implementation | Notes |
|---|---|---|---|
| B1 Extensions and setup | Partial | Multiple migrations incl. `vector`, `pgcrypto` | Phase-1 compatibility migration adds idempotent extension guards for `vector`, `pgcrypto`, `pg_cron`. |
| B2 Tenants and subscriptions | Implemented | `tenants`, `subscriptions`, `pricing_plans` | `subscription_plans` exposed via compatibility view. |
| B3 Users and profiles | Implemented | `profiles`, `team_invitations`, auth triggers | Uses Supabase Auth (`auth.users`) + profile provisioning RPC. |
| B4 Connections and schema entities | Implemented (canonical), adapter added | `api_connections`, `connection_entities`, `connection_sync_runs` | `schema_entities` compatibility view added. |
| B5 Embedding store | Implemented (canonical), adapter added | `knowledge_document_chunks.embedding` + hybrid search RPC | `embeddings` compatibility table added for legacy/adapter paths, plus `hybrid_search` contract for semantic+timeline scoring. |
| B6 RACI governance | Implemented | `raci_matrix`, `raci_roles`, `raci_role_members`, `risk_matrix_rules` | `risk_policies` compatibility view added. |
| B7 Chat sessions and messages | Implemented | `chat_sessions`, `chat_messages` | No schema gap. |
| B8 Agents and tools | Implemented (canonical), adapter added | `ai_agents`, `tool_registry`, `agent_memory_entries` | `agents`, `tools`, `agent_memory` compatibility views added. |
| B9 Approval workflows | Implemented | `approval_requests`, `approval_request_decisions`, `approval_execution_tokens` | No schema gap. |
| B10 Audit and usage | Implemented | `audit_logs`, `usage_events`, `billing_events` | Audit immutability trigger already enforced. |
| B11 Marketplace | Implemented (canonical), adapter added | `integration_catalog`, `tenant_integration_installs`, `integration_credentials` | `tenant_integrations`, `credentials`, `tenant_tools` compatibility views added. |
| B12 Context and ingestion queue | Implemented | `context_events`, `ingestion_queue` | No schema gap. |
| B13-B18 RLS policies | Implemented | RLS enabled and policies present across all base tables | Added SQL audit RPC `run_phase1_rls_audit` for validation. |

## B19-B35 Edge Functions

| Build Plan Name | Status | Canonical Function |
|---|---|---|
| provision-user-workspace | Adapter added | `provision_user_workspace` RPC |
| send-invitation | Adapter added | `send-team-invites` |
| accept-invitation | Adapter added | `accept_team_invitation_token` RPC |
| discover-connection | Adapter added | `connector-sync-dispatch` |
| chat-completion | Adapter added | `chat-execute` |
| embed-content | Adapter added | `knowledge-embed-worker-dispatch` |
| execute-approved-action | Adapter added | `chat-action-update` |
| request-approval | Adapter added | `chat-action-update` |
| decide-approval | Implemented | `decide-approval` |
| generate-nl-sql | Adapter added | New OpenAI-backed adapter |
| generate-insight | Implemented | `generate-insight` |
| create-checkout-session | Added | New provider-agnostic billing adapter |
| stripe-webhook | Implemented | `stripe-webhook` |
| report-usage | Added | New usage reporting adapter |
| check-plan-limits | Adapter added | `tenant-entitlements-check` / `tenant_entitlements_check` RPC |
| oauth-callback | Implemented | `oauth-callback` |
| webhook-slack | Implemented | `webhook-slack` |
| webhook-whatsapp | Added | `webhook-whatsapp` |
| webhook-telegram | Added | `webhook-telegram` |
| webhook-teams | Added | `webhook-teams` |

## C1-C18 Worker Files

| Build Plan File | Status | Canonical File |
|---|---|---|
| `lib/encryption.ts` | Implemented | `worker/src/lib/encryption.ts` |
| `lib/supabaseAdmin.ts` | Added compatibility | `worker/src/lib/supabase.ts` |
| `lib/queue.ts` | Implemented | `worker/src/lib/queue.ts` |
| `pipeline/embedder.ts` | Implemented | `worker/src/pipeline/embedder.ts` |
| `pipeline/retriever.ts` | Implemented | `worker/src/pipeline/retriever.ts` |
| `workers/ingestionWorker.ts` | Implemented | `worker/src/workers/ingestionWorker.ts` |
| `mcp/mcpRegistry.ts` | Implemented | `worker/src/mcp/mcpRegistry.ts` |
| `mcp/mcpRouter.ts` | Implemented | `worker/src/mcp/mcpRouter.ts` |
| `runtime/agentLoop.ts` | Implemented | `worker/src/runtime/agentLoop.ts` |
| `toolgen/autoToolGenerator.ts` | Implemented | `worker/src/toolgen/autoToolGenerator.ts` |
| `governance/governanceMiddleware.ts` | Implemented | `worker/src/governance/governanceMiddleware.ts` |
| `connectors/databaseConnector.ts` | Added compatibility | `worker/src/connectors/postgres.ts` + `factory.ts` |
| `connectors/slackConnector.ts` | Implemented | `worker/src/connectors/slackConnector.ts` |
| `connectors/driveConnector.ts` | Implemented | `worker/src/connectors/driveConnector.ts` |
| `connectors/emailConnector.ts` | Implemented | `worker/src/connectors/emailConnector.ts` |
| `pipeline/agentBuilder.ts` | Implemented | `worker/src/pipeline/agentBuilder.ts` |
| `pipeline/queryRouter.ts` | Implemented | `worker/src/pipeline/queryRouter.ts` |
| `pipeline/predictiveEngine.ts` | Implemented | `worker/src/pipeline/predictiveEngine.ts` |

### OpenClaw Edition Service Layer

| Architecture v2.0 Layer | Status | Canonical File |
|---|---|---|
| `services/agent-core` | Implemented (OpenClaw-first, compat fallback) | `worker/src/services/agent-core/*` |
| `services/governance/wrapper` | Implemented | `worker/src/services/governance/wrapper.ts` |
| `services/memory/builder` | Implemented | `worker/src/services/memory/builder.ts` |
| `services/integration/registry` | Implemented | `worker/src/services/integration/registry.ts` |
| `services/router/multi-agent` | Implemented | `worker/src/services/router/multiAgent.ts` |
| Worker runtime cutover | Implemented | `worker/src/runtime/agentLoop.ts` now delegates to `OpsAIAgent` |

## P0-P3 Frontend Routes

| Build Plan Route | Status | Canonical / Alias |
|---|---|---|
| `/dashboard/agents/create` | Added alias | `Agents` page |
| `/dashboard/admin/raci` | Added alias | `Raci` page |
| `/dashboard/admin/policies` | Added alias | `Guardrails` page |
| `/dashboard/admin/approvals` | Added alias | `Approvals` page |
| `/dashboard/admin/audit` | Added alias | `AuditLogs` page |
| `/dashboard/admin/team` | Added alias | `Team` page |
| `/dashboard/usage` | Added direct route | `Usage` page |
| `/dashboard/admin/api-keys` | Added alias | `ApiKeys` page |
| `/dashboard/admin/widget` | Added alias | `WidgetIntegration` page |

## Hybrid Memory (Phase 1)

| Memory Type | Status | Contract |
|---|---|---|
| Semantic memory (pgvector) | Implemented | `embeddings` + `hybrid_search` RPC |
| Structured memory (SQL tools) | Implemented | `schema_entities` compatibility view + governed SQL tool path |
| Event timeline memory | Implemented | `context_events` + ingestion event writes from worker pipeline |

## MCP-Native + Agent Runtime (Sections 5-6)

| Requirement | Status | Implementation |
|---|---|---|
| MCP vs OpenAPI vs custom strategy | Implemented | `resolveToolingApproach` in worker + edge shared runtime bootstrap |
| Key MCP server registry support | Implemented | `mcp_servers` metadata columns + seeded global MCP templates |
| MCP governance enforcement | Implemented | `mcpRouter.callTool` -> governance check -> approval gate -> audit |
| Install-time auto MCP/tool bootstrap | Implemented | `bootstrap_tenant_integration_runtime` RPC wired from marketplace + OAuth callback |
| Runtime teardown on uninstall | Implemented | `teardown_tenant_integration_runtime` RPC |
| Agent runtime with tool call processing | Implemented (Phase 1) | `agentLoop` now loads MCP tools, executes governed calls, then finalizes LLM response |
| Structured-output blueprint generation | Implemented | `agentBuilder` uses strict JSON schema response format and ID filtering |
| OpenClaw execution substrate | Implemented (Phase-1 callback bridge) | `openclaw-rpc` runs iterative planning with governed tenant tool callbacks and strict fallback control via `OPENCLAW_STRICT` |
