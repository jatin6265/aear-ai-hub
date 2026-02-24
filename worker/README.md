# AEAR Worker Runtime

Hybrid runtime companion for Supabase Edge Functions.

## Responsibilities

- Poll `connector_jobs` queue and execute connector sync tasks.
- Poll `embedding_jobs` queue and generate embeddings via OpenAI.
- Poll `agent_run_jobs` queue and execute agent runtime loops.
- Poll `webhook_deliveries` queue and dispatch signed webhooks with retries.
- Expand document-level embedding jobs into chunk-level reindex schedules.
- Call `connector-sync-worker-callback` with normalized schema payload.
- Persist embedding vectors on `knowledge_document_chunks`.
- Trigger periodic OAuth credential refresh dispatch.
- Enqueue due connector sync jobs automatically from `sync_frequency` + `next_sync_at`.
- Use connector-specific schema adapters (Sheets/Notion/Firebase/DBs) with relationship inference.

## Environment Variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CONNECTOR_WORKER_TOKEN`
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (optional, default `gpt-4o-mini`)
- `OPENAI_EMBEDDING_MODEL` (optional, default `text-embedding-3-small`)
- `CONNECTOR_WORKER_ID` (optional, default `node-connector-worker`)
- `WORKER_POLL_INTERVAL_MS` (optional, default `8000`)
- `WORKER_STALE_RECOVERY_MINUTES` (optional, default `20`)
- `CREDENTIAL_REFRESH_INTERVAL_MS` (optional, default `600000`)
- `CONNECTOR_SYNC_DISPATCH_INTERVAL_MS` (optional, default `60000`)
- `WEBHOOK_SIGNING_SECRET` (optional)
- `WORKER_HEARTBEAT_INTERVAL_MS` (optional, default `60000`)
- `WORKER_FAIL_FAST_CONNECTIVITY_CHECK` (optional, default `true`)

## Run

```bash
node worker/connector-worker.mjs
```

The worker runs a perpetual polling loop every 8 seconds.

Use Node.js 20+ for runtime compatibility with recent `@supabase/supabase-js` releases.

## Notes

- Uses queue-claim RPCs (`claim_connector_jobs`, `claim_embedding_jobs`) when available.
- Falls back to direct table polling for backward compatibility until migrations are deployed.
- Uses RPC `enqueue_due_connector_sync_jobs` to make connection syncs automatic (no manual-only sync loop).
