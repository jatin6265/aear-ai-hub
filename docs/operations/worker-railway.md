# Worker on Railway (Phase 1 -> Phase 2 Path)

## Phase 1 target (MVP)

- Runtime: `worker/connector-worker.mjs`
- Mode: `WORKER_RUNTIME_MODE=polling`
- Redis: optional for Phase 1

## Required environment variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CONNECTOR_WORKER_TOKEN`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_EMBEDDING_MODEL=text-embedding-3-small`
- `WORKER_RUNTIME_MODE=polling`

## Deployment checklist

1. Create Railway service from repo root.
2. Use [`railway.worker.json`](/Users/jatin/Desktop/aear-ai-hub/railway.worker.json).
3. Set worker env vars in Railway.
4. Run local readiness gate:
   - `scripts/verify-worker-deploy-readiness.sh`
5. Deploy and verify logs for:
   - Supabase connectivity probe success
   - connector job claim/processing loop
   - no missing secret/runtime warnings

## Phase 2 queue-mode cutover

1. Provision Redis (Upstash/AWS ElastiCache).
2. Set:
   - `WORKER_RUNTIME_MODE=queue`
   - `REDIS_URL=<connection-url>`
3. Validate strict gates:
   - `scripts/verify-worker-deploy-readiness.sh --strict`
   - `scripts/verify-runtime-wiring.sh --strict --project-ref <project-ref>`
4. Scale worker replicas in Railway.

## Rollback

1. Revert `WORKER_RUNTIME_MODE` to `polling`.
2. Redeploy previous worker image/version in Railway.
3. Keep Redis provisioned for reattempt; do not delete until queue backlog is drained or migrated.
