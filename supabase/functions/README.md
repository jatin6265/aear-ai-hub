# Supabase Edge Functions

These functions wrap the database RPC layer added in migration `20260221212000_expand_backend_models_and_functions.sql`.

## Functions

- `platform-admin-tenants`
  - `POST` body:
    - list payload: `{ "operation": "get_payload", "filters": { "search": "", "plan": "all|starter|pro|business|enterprise", "status": "all|active|trial|suspended|cancelled", "createdFrom": "YYYY-MM-DD", "createdTo": "YYYY-MM-DD", "sortBy": "mrr|created|last_active|health_score", "sortDir": "asc|desc", "limit": 100, "offset": 0 } }`
    - quick view: `{ "operation": "get_tenant_quick_view", "tenantId": "<uuid>" }`
    - suspend: `{ "operation": "suspend_tenant", "tenantId": "<uuid>" }`
    - change plan: `{ "operation": "change_plan", "tenantId": "<uuid>", "plan": "starter|pro|business|enterprise" }`
    - impersonate: `{ "operation": "impersonate_tenant", "tenantId": "<uuid>" }`
  - Calls RPCs: `get_platform_super_admin_tenants`, `get_platform_super_admin_tenant_quick_view`, `platform_admin_manage_tenant`, `platform_admin_start_impersonation`

- `platform-admin-revenue`
  - `POST` body:
    - dashboard payload: `{ "operation": "get_payload", "months": 12 }`
    - retention action: `{ "operation": "send_retention_email", "tenantId": "<uuid>", "note": "optional" }`
  - Calls RPCs: `get_platform_super_admin_revenue_dashboard`, `platform_admin_send_retention_email`

- `platform-admin-infrastructure`
  - `POST` body:
    - infrastructure payload: `{ "operation": "get_payload", "hours": 24 }`
  - Calls RPC: `get_platform_super_admin_infrastructure_health`

- `admin-console`
  - `POST` body: `{ "operation": "get_payload" }`
  - Calls RPC: `get_tenant_admin_console_overview`

- `admin-analytics`
  - `POST` body:
    - get payload: `{ "operation": "get_payload", "dateFrom": "YYYY-MM-DD", "dateTo": "YYYY-MM-DD" }`
    - update weekly schedule: `{ "operation": "set_weekly_report", "enabled": true, "dateFrom": "YYYY-MM-DD", "dateTo": "YYYY-MM-DD" }`
  - Calls RPCs: `get_tenant_admin_analytics_payload`, `set_tenant_admin_weekly_report_enabled`

- `notification-settings`
  - `POST` body:
    - get payload: `{ "operation": "get_payload" }`
    - save channels: `{ "operation": "save_channels", "channels": { "emailEnabled": true, "emailAddress": "ops@company.com", "slackEnabled": true, "slackWorkspace": "OpsAI", "slackChannel": "#alerts", "webhookEnabled": true, "webhookUrl": "https://...", "webhookSecret": "optional-new-secret" } }`
    - save event matrix: `{ "operation": "save_types", "notificationTypes": [{ "eventKey": "approval_request_received", "email": true, "slack": true, "webhook": false }] }`
    - save digest: `{ "operation": "save_digest", "digest": { "dailyDigestEnabled": true, "dailyDigestTime": "09:00", "weeklyReportEnabled": true, "weeklyReportDay": 1, "timezone": "UTC" } }`
    - send test: `{ "operation": "send_test" }`
  - Calls RPCs: `get_notification_settings_payload`, `save_notification_channel_settings`, `save_notification_type_preferences`, `save_notification_digest_settings`, `enqueue_notification_test_event`

- `tenant-billing-dashboard`
  - `GET` query or `POST` body: `{ "windowDays": 30 }`
  - Calls RPC: `get_tenant_billing_dashboard`

- `billing-plan-change`
  - `POST` body:
    - get options: `{ "operation": "get_options" }`
    - preview change: `{ "operation": "preview_change", "targetPlan": "pro", "billingCycle": "monthly|annual" }`
    - downgrade impact: `{ "operation": "get_downgrade_impact", "targetPlan": "starter|pro|business" }`
    - apply: `{ "operation": "apply_change", "targetPlan": "pro", "billingCycle": "monthly|annual", "paymentReference": "optional", "changeType": "upgrade|downgrade" }`
  - Calls RPCs: `get_billing_upgrade_options`, `preview_plan_change`, `get_plan_downgrade_impact`, `apply_plan_change`

- `billing-invoices`
  - `POST` body:
    - list payload: `{ "operation": "get_payload", "year": 2025 }`
    - invoice detail: `{ "operation": "get_invoice_detail", "invoiceId": "<uuid>" }`
    - retry payment: `{ "operation": "retry_payment", "invoiceId": "<uuid>" }`
  - Calls RPCs: `get_billing_invoice_history`, `get_billing_invoice_detail`, `request_invoice_payment_retry`

- `insights-feed`
  - `POST` body:
    - get payload: `{ "operation": "get_payload", "tab": "all|anomalies|forecasts|sla_risks|positive", "sourceId": "<uuid optional>", "includeDismissed": false }`
    - refresh: `{ "operation": "refresh", "tab": "all", "sourceId": "", "includeDismissed": false }`
    - dismiss: `{ "operation": "dismiss", "insightId": "<uuid>", "tab": "all", "sourceId": "", "includeDismissed": false }`
  - Calls RPCs: `get_predictive_insights_payload`, `refresh_predictive_insights`, `dismiss_predictive_insight`

- `anomaly-detail`
  - `POST` body:
    - detail: `{ "operation": "get_detail", "insightId": "<uuid>", "window": "7d|30d|60d|90d" }`
    - status update: `{ "operation": "set_status", "insightId": "<uuid>", "status": "active|investigating|resolved" }`
  - Calls RPCs: `get_predictive_anomaly_detail`, `update_predictive_anomaly_status`

- `widget-integration`
  - `POST` body:
    - get payload: `{ "operation": "get_payload" }`
    - save config: `{ "operation": "save_config", "config": { "name": "OpsAI Assistant Widget", "position": "bottom-right", "primaryColor": "#7c3aed", "buttonSize": "medium", "initialMessage": "How can I help you today?", "accessMode": "public|authenticated|jwt", "allowedOrigins": ["https://example.com"], "enabledAgentIds": ["<uuid>"], "features": { "executeActions": false, "viewReports": false, "requestApprovals": false } } }`
  - Calls RPCs: `get_widget_integration_payload`, `save_widget_integration_config`

- `api-keys-management`
  - `POST` body:
    - get payload: `{ "operation": "get_payload" }`
    - create key: `{ "operation": "create_key", "name": "My Integration Key", "environment": "production|development|testing", "scopes": ["read","write"], "expiryMode": "never|30_days|90_days|1_year|custom", "customExpiryDate": "YYYY-MM-DD" }`
    - revoke key: `{ "operation": "revoke_key", "keyId": "<uuid>" }`
  - Calls RPCs: `get_api_keys_management_payload`, `create_api_key_v2`, `revoke_api_key`

- `public-pricing`
  - `GET` query or `POST` body: `{ "billingInterval": "monthly|annual" }`
  - Calls RPC: `get_public_pricing_payload`
  - Public function: does not require user auth

- `marketplace-directory`
  - `POST` body:
    - payload: `{ "operation": "get_payload", "search": "", "category": "all|crm|erp|ticketing|communication|analytics|finance|hr|ecommerce", "installedOnly": false }`
    - install: `{ "operation": "install", "integrationCode": "salesforce" }`
    - configure: `{ "operation": "configure", "integrationCode": "salesforce" }`
    - uninstall: `{ "operation": "uninstall", "integrationCode": "salesforce" }`
  - Calls RPCs: `get_integration_marketplace_payload`, `set_integration_install_state`

- `guardrails-config`
  - `POST` body:
    - get payload: `{ "operation": "get_payload" }`
    - save configuration: `{ "operation": "save_configuration", "bulkUpdateLimit": "10|100|500|1000|unlimited", "simulationModeEnabled": true, "businessHoursLockEnabled": true, "businessStart": "09:00", "businessEnd": "18:00", "businessTimezone": "UTC", "financialMutationLimit": 10000, "financialCurrency": "USD", "newUserRestrictionDays": 7 }`
  - Calls RPCs: `get_guardrails_configuration_payload`, `save_guardrails_configuration`

- `audit-log`
  - `POST` body: `{ "operation": "get_payload", "search": "", "riskFilter": "all|low|medium|high|critical", "actionTypeFilter": "all|query|update|delete|blocked", "statusFilter": "all|success|failed|blocked|pending_approval", "userFilter": "<uuid optional>", "agentFilter": "all|Finance Agent|...", "dateFrom": "YYYY-MM-DD", "dateTo": "YYYY-MM-DD", "limit": 100, "offset": 0 }`
  - Calls RPC: `get_audit_log_full_payload`

- `simulate-action-preview`
  - `POST` body: `{ "action": "...", "resource": "...", "riskLevel": "high", "simulation": { ... }, "params": { ... } }`
  - Calls RPC: `simulate_action_preview`

- `approvals-queue`
  - `POST` body:
    - get payload: `{ "operation": "get_payload", "statusFilter": "all|pending|approved|rejected|expired", "search": "", "riskFilter": "all|low|medium|high|critical", "dateFrom": "YYYY-MM-DD", "dateTo": "YYYY-MM-DD" }`
    - decide: `{ "operation": "decide", "approvalId": "<uuid>", "decision": "approved|rejected", "note": "optional note" }`
    - review detail: `{ "operation": "get_review_detail", "approvalId": "<uuid>" }`
    - review decide: `{ "operation": "review_decide", "approvalId": "<uuid>", "decision": "approved|rejected|more_info", "reason": "required for reject/more_info" }`
  - Calls RPCs: `get_approvals_queue_payload`, `decide_approval_request_queue`, `get_approval_review_payload`, `submit_approval_review_decision`

- `guardrails-risk-dashboard`
  - `POST` body:
    - get payload: `{ "operation": "get_payload", "eventRiskFilter": "all|critical|high|medium|low" }`
    - override risk: `{ "operation": "override_risk", "ruleId": "<uuid>", "overrideRiskLevel": "critical", "justification": "..." }`
    - toggle policy: `{ "operation": "set_guardrail_state", "guardrailId": "<uuid>", "enabled": true }`
  - Calls RPCs: `get_guardrails_risk_dashboard`, `set_risk_rule_override`, `set_guardrail_enabled`

- `team-management`
  - `POST` body:
    - get payload: `{ "operation": "get_payload", "search": "", "roleFilter": "all|owner|admin|manager|member|viewer", "statusFilter": "all|active|invited|suspended" }`
    - invite members: `{ "operation": "invite_members", "emails": "a@x.com,b@y.com" | ["a@x.com","b@y.com"], "role": "member", "customMessage": "optional" }`
    - member role: `{ "operation": "update_member_role", "profileId": "<uuid>", "role": "manager" }`
    - member status: `{ "operation": "update_member_status", "profileId": "<uuid>", "status": "active|suspended" }`
    - remove member: `{ "operation": "remove_member", "profileId": "<uuid>" }`
    - invitation action: `{ "operation": "manage_invitation", "invitationId": "<uuid>", "action": "resend|cancel" }`
  - Calls RPCs: `get_team_management_payload`, `invite_team_members`, `update_team_member_role`, `set_team_member_status`, `remove_team_member`, `manage_team_invitation`

- `send-team-invites`
  - `POST` body: `{ "invites": [{ "email": "user@company.com", "role": "manager" }] }`
  - Calls RPC: `create_team_invitations`

- `test-data-connection`
  - `POST` body: `{ "connectionType": "postgresql", "payload": { ... } }`
  - Calls RPC: `test_connection_payload`

- `run-schema-discovery`
  - `POST` body: `{ "connectionId": "<uuid>" }`
  - Queues background schema discovery via RPC `enqueue_connector_sync` (with direct queue fallback)

- `connection-pipeline-diagnostics`
  - `POST` body:
    - get payload: `{ "operation": "get_payload", "connectionId": "<uuid optional>", "includeHealthy": false }`
  - Returns end-to-end diagnostics for connection -> schema -> embeddings -> agent readiness pipeline

- `create-data-connection`
  - `POST` body: `{ "name": "...", "type": "postgresql", "baseUrl": "...", "authType": "api_key", "config": {}, "seedSchema": false }`
  - Calls RPC: `create_api_connection` (and queues schema discovery via `enqueue_connector_sync`)

- `launch-workspace`
  - `POST` body: `{ "raciRules": [ ... ] }`
  - Calls RPC: `launch_workspace`

- `create-api-key`
  - `POST` body: `{ "name": "Production Key", "scopes": ["read","write"] }`
  - Calls RPC: `create_api_key`

- `revoke-api-key`
  - `POST` body: `{ "keyId": "<uuid>" }`
  - Calls RPC: `revoke_api_key`

- `set-guardrail-state`
  - `POST` body: `{ "guardrailId": "<uuid>", "enabled": true }`
  - Calls RPC: `set_guardrail_enabled`

- `decide-approval`
  - `POST` body: `{ "approvalId": "<uuid>", "decision": "approved" }`
  - Calls RPC: `decide_approval_request`

- `chat-execute`
  - `POST` body: `{ "sessionId": "<uuid|null>", "prompt": "..." }`
  - Runs governed planner/executor flow via RPCs `evaluate_action_policy`, `execute_tenant_sql_governed`, and hybrid knowledge search

- `chat-action-update`
  - `POST` body: `{ "actionRunId": "<uuid>", "operation": "run|cancel|request_approval|approve_execute|reject|undo|retry" }`
  - Updates `agent_action_runs` lifecycle and approval state for chat action proposal cards

- `agents-dashboard`
  - `POST` body: `{ "search": "", "status": "all|active|inactive|training" }`
  - Calls RPC: `list_agents_dashboard`

- `agent-set-enabled`
  - `POST` body: `{ "agentId": "<uuid>", "enabled": true }`
  - Calls RPC: `set_agent_enabled`

- `agent-detail`
  - `POST` body:
    - fetch: `{ "operation": "get", "agentId": "<uuid>" }`
    - rename: `{ "operation": "rename", "agentId": "<uuid>", "name": "Finance Agent" }`
    - agent toggle: `{ "operation": "toggle_agent", "agentId": "<uuid>", "enabled": true }`
    - tool toggle: `{ "operation": "toggle_tool", "agentId": "<uuid>", "toolId": "<uuid>", "enabled": true }`
    - memory clear: `{ "operation": "clear_memory", "agentId": "<uuid>", "memoryType": "session|user|organization|all" }`
    - raci update: `{ "operation": "update_raci_role", "agentId": "<uuid>", "bindingId": "<uuid>", "roleName": "manager" }`
  - Calls RPCs: `get_agent_detail_payload`, `rename_agent`, `set_agent_enabled`, `set_agent_tool_enabled`, `clear_agent_memory_entries`, `update_agent_raci_binding_role`

- `agent-studio`
  - `POST` body:
    - get payload: `{ "operation": "get_payload", "agentId": "<uuid optional>" }`
    - suggest from prompt: `{ "operation": "suggest_from_prompt", "prompt": "Build an ops copilot for invoice escalation workflows" }`
    - save/create custom agent: `{ "operation": "save_agent", "agentId": "<uuid optional>", "name": "Ops Copilot", "description": "...", "domain": "operations", "prompt": "...", "objective": "...", "systemPrompt": "...", "avatarEmoji": "⚙️", "capabilities": ["workflow orchestration"], "sourceConnectionIds": ["<uuid>"], "syncFrequency": "hourly", "vectorStrategy": "hybrid", "ragEnabled": true, "autoSync": true, "autoDeploy": true, "deployNow": true, "raciScope": "Restricted to Operations Manager role" }`
    - sync existing custom agent: `{ "operation": "sync_agent", "agentId": "<uuid>" }`
    - create from chat prompt: `{ "operation": "create_from_chat", "prompt": "Create an analytics agent for forecast anomalies", "sessionId": "<uuid optional>" }`
    - delete custom agent: `{ "operation": "delete_agent", "agentId": "<uuid>" }`
  - Calls RPCs: `get_agent_studio_payload`, `suggest_custom_agent_blueprint`, `upsert_custom_agent_studio`, `sync_custom_agent`, `create_custom_agent_from_chat_prompt`

- `agent-run-dispatch`
  - `POST` body: `{ "agentId": "<uuid>", "input": { ... }, "sessionId": "<uuid|null>", "triggerType": "manual|event|schedule|webhook|api", "estimatedCredits": 10, "priority": 50, "idempotencyKey": "optional", "invokedVia": "app|api|chat" }`
  - Calls RPC: `enqueue_agent_run`

- `agent-run-status`
  - `POST` body: `{ "runId": "<uuid>" }`
  - Returns run state + replay steps + latest queue job status

- `tool-execute`
  - `POST` body: `{ "toolName": "rag_search|database_query|http_request|...", "toolInput": { ... }, "runId": "<uuid|null>", "agentId": "<uuid|null>", "sessionId": "<uuid|null>", "dryRun": false }`
  - Calls RPCs: `resolve_tool_definition`, `evaluate_action_policy`, `record_tool_execution`, `complete_agent_run_step`

- `oauth-start`
  - `POST` body: `{ "provider": "google|gmail|slack|notion|zoho", "label": "default" }`
  - Returns provider authorization URL and signed state

- `oauth-callback`
  - `GET` query: `?code=...&state=...`
  - Exchanges OAuth code, encrypts tokens, stores/updates `integration_credentials`, records `credential_rotations`

- `credential-refresh-dispatch`
  - `POST` body (worker token required): `{ "limit": 50, "thresholdMinutes": 20 }`
  - Refreshes expiring OAuth credentials and logs rotation events

- `api-v1-gateway`
  - Supports developer platform routes via function path:
    - `POST /v1/agents`
    - `GET /v1/agents`
    - `POST /v1/agents/:id/run`
    - `GET /v1/runs/:id`
    - `GET /v1/runs`
    - `POST /v1/documents`
    - `POST /v1/api-keys` (JWT only)
    - `GET /v1/usage`
  - Auth: bearer `opsai_*` API key or JWT

- `webhook-delivery-worker-callback`
  - `POST` body (worker token required): `{ "deliveryId": "<uuid>", "status": "running|success|error|dead_letter|cancelled", "responseStatus": 200, "responseBody": "...", "error": "..." }`
  - Updates `webhook_deliveries` retry state

- `raci-editor`
  - `POST` body:
    - get payload: `{ "operation": "get_payload" }`
    - set cell: `{ "operation": "set_cell", "resourceKey": "financial_data", "action": "execute", "roleName": "manager", "raciType": "R|A|C|I|-" }`
    - add role: `{ "operation": "add_role", "roleName": "security_analyst" }`
    - rename role: `{ "operation": "rename_role", "oldRoleName": "manager", "newRoleName": "ops_manager" }`
    - delete role: `{ "operation": "delete_role", "roleName": "viewer", "force": false }`
    - add rule/resource: `{ "operation": "add_rule", "resourceKey": "inventory", "action": "update", "category": "Inventory" }`
    - import CSV rows: `{ "operation": "import_csv", "rows": [{ "resource": "inventory", "action": "update", "role": "manager", "raciType": "R", "category": "Inventory" }] }`
    - validate: `{ "operation": "validate" }`
  - Calls RPCs: `get_raci_editor_payload`, `set_raci_cell`, `add_raci_role`, `rename_raci_role`, `delete_raci_role`, `add_raci_rule_resource`, `import_raci_rules_csv_rows`, `validate_raci_matrix_rules`

- `raci-role-management`
  - `POST` body:
    - get payload: `{ "operation": "get_payload" }`
    - create/update role: `{ "operation": "upsert_role", "roleName": "finance_manager", "description": "...", "icon": "💰", "memberIds": ["<uuid>"], "previousRoleName": "finance_lead" }`
    - apply template: `{ "operation": "apply_template", "templateKey": "finance_manager", "roleName": "finance_manager", "memberIds": ["<uuid>"] }`
    - delete role: `{ "operation": "delete_role", "roleName": "finance_manager" }`
  - Calls RPCs: `get_raci_role_management_payload`, `upsert_raci_role_management`, `apply_raci_role_template`, `delete_raci_role`

- `index-knowledge-document`
  - `POST` body: `{ "documentId": "<uuid>" }`
  - Pulls uploaded file metadata/content and updates `knowledge_documents` status/excerpt

- `knowledge-reindex-dispatch`
  - `POST` body: `{ "documentId": "<uuid optional>", "force": false, "limit": 800 }`
  - Calls RPCs: `schedule_knowledge_embedding_reindex`, `get_knowledge_embedding_health`

- `connector-sync-dispatch`
  - `POST` body: `{ "connectionId": "<uuid>", "jobType": "schema_discovery", "triggerReason": "manual", "priority": 50 }`
  - Calls RPC: `enqueue_connector_sync`

- `connector-sync-worker-callback`
  - `POST` body: `{ "jobId": "<uuid>", "status": "running|success|error", "schema": { "entities": [...], "relationships": [...] } }`
  - Worker callback endpoint (requires `x-worker-token` or `Authorization: Bearer <CONNECTOR_WORKER_TOKEN>`)

- `knowledge-embed-worker-dispatch`
  - `POST` body:
    - queue single job: `{ "sourceType": "knowledge_chunk|connection_entity", "sourceId": "<uuid>" }`
    - document reindex: `{ "sourceType": "document", "sourceId": "<document_uuid>", "force": false }`
    - tenant reindex: `{ "sourceType": "tenant_reindex", "tenantId": "<uuid optional>", "force": true }`
  - Calls RPCs: `create_embedding_job` or `schedule_knowledge_embedding_reindex`

- `tenant-entitlements-check`
  - `POST` body: `{ "capability": "connections", "requested": 1 }`
  - Calls RPC: `tenant_entitlements_check`

- `agent-regenerate`
  - `POST` body: `{ "tenantId": "<uuid optional>", "force": false }`
  - Calls RPC: `regenerate_agents_for_tenant`

- `stripe-webhook`
  - `POST` body: Stripe webhook payload
  - Verifies signature and upserts `billing_events`, `subscriptions`, and `invoice_snapshots`

- `webhook-slack`
  - `POST` body: Slack Events API payload
  - Verifies Slack signature and queues message events to `ingestion_queue` + `context_events`

- `webhook-whatsapp`
  - `GET` for Meta verification (`hub.challenge`)
  - `POST` body: WhatsApp Cloud API webhook payload
  - Verifies `x-hub-signature-256` when `WHATSAPP_APP_SECRET` is set, then queues events for ingestion

- `webhook-telegram`
  - `POST` body: Telegram update payload
  - Verifies `x-telegram-bot-api-secret-token` when `TELEGRAM_WEBHOOK_SECRET_TOKEN` is set, then queues events for ingestion

- `webhook-teams`
  - `GET ?validationToken=...` returns plaintext token for Graph subscription validation
  - `POST` body: Microsoft Graph notifications payload
  - Validates optional `TEAMS_WEBHOOK_CLIENT_STATE`, then queues events for ingestion

## Deploy

```bash
supabase functions deploy <function-name> --no-verify-jwt
```

Use `scripts/deploy-backend.sh <project-ref>` to deploy all functions from `deploy-manifest.json` with consistent flags.

## Notes

- Most functions require a valid `Authorization: Bearer <access_token>` header and enforce this in `getAuthedClient`.
- Gateway JWT verification is disabled (`--no-verify-jwt`) to avoid auth failures with asymmetric user JWTs; auth is validated in-function.
- Exception: `public-pricing` is intentionally public for unauthenticated pricing page access.
- Exception: `stripe-webhook` and `connector-sync-worker-callback` use signature/token authentication, not end-user JWTs.
- Exception: `webhook-slack`, `webhook-whatsapp`, `webhook-telegram`, and `webhook-teams` use signature/token validation, not end-user JWTs.
- CORS is open for development by default (`*`). Restrict in production if needed.
- `send-team-invites` and `team-management` now deliver invitation emails through Resend.
  Required secrets:
  - `RESEND_API_KEY`
  - `RESEND_FROM_EMAIL` (or `INVITE_FROM_EMAIL`)
  Optional:
  - `INVITE_APP_BASE_URL` (defaults to request origin, then `http://localhost:8080`)
