# Feature Truth Matrix

This matrix maps landing-page claims to current backend/runtime contracts.

## Core theme

**Your Enterprise AI Operating Layer**

Connect any API or database. Auto-build RAG pipelines. Enforce RACI governance. Execute safely.

## Claim checks

1. `Connect any API or database`
   - Contract checks: `enqueue_connector_sync`, `connector-sync-dispatch`, worker connector adapters
   - Validation command: `bash scripts/verify-runtime-wiring.sh`
2. `Auto-build RAG pipelines`
   - Contract checks: `create_embedding_job`, `schedule_knowledge_embedding_reindex`, `search_knowledge_documents_hybrid`
   - Validation command: `bash scripts/verify-runtime-wiring.sh`
3. `Enforce RACI governance`
   - Contract checks: `evaluate_action_policy`, approvals queue RPCs, guardrails config
   - Validation command: `bash scripts/verify-runtime-wiring.sh`
4. `Execute safely`
   - Contract checks: `execute_tenant_sql_governed`, chat action approval path, audit logging
   - Validation command: `bash scripts/verify-runtime-wiring.sh`

## Notes

- `verify-runtime-wiring` reports simulation/static markers in critical runtime files.
- Run strict mode for release gates: `bash scripts/verify-runtime-wiring.sh --strict --project-ref <ref>`.
