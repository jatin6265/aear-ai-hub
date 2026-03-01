# Backend Deployment Runbook

## One-command deploy (dev)

```bash
scripts/deploy-backend.sh <supabase-project-ref>
```

Full local setup + build + optional deploy:

```bash
scripts/setup-e2e.sh --project-ref <supabase-project-ref>
```

This will:

1. Run `supabase db push`
2. Deploy all edge functions from `supabase/functions/deploy-manifest.json`
3. Regenerate `src/integrations/supabase/types.ts`
4. Run runtime wiring verification before and after deploy

## Pre-flight checks

1. `scripts/verify-backend.sh`
2. `scripts/verify-worker-runtime-drift.sh`
3. `scripts/verify-worker-deploy-readiness.sh`
4. `scripts/verify-runtime-wiring.sh --project-ref <supabase-project-ref>`
5. `npm run build`
6. Confirm required secrets are set in Supabase Edge Function secrets.

Optional strict check:

```bash
scripts/verify-runtime-wiring.sh --strict --project-ref <supabase-project-ref>
```

Claim coverage reference:

- `docs/operations/feature-truth-matrix.md`

## Post-deploy smoke checks

1. Create a data connection from UI.
2. Dispatch sync job (`connector-sync-dispatch`).
3. Verify `connector_jobs` status transitions.
4. Open chat and execute one SQL + one knowledge query.
5. Trigger a Stripe webhook test event and verify `billing_events` row.
6. Trigger a Razorpay webhook test event and verify `billing_events` row with `provider=razorpay`.
7. Trigger Slack/WhatsApp/Telegram/Teams webhook test payloads and verify `ingestion_queue` + `context_events` rows.
8. Install an MCP-capable integration (e.g. Slack/HubSpot) and verify:
   - `tenant_integration_installs` row is `installed`
   - `mcp_servers` row created for tenant when MCP URL exists
   - `tool_registry` receives auto-generated integration tools
   - `ingestion_queue` receives initial sync/bootstrap event

## Staging promotion gates

1. Deploy the exact same migration and function artifacts used in `dev`.
2. Run `scripts/verify-runtime-wiring.sh --strict --project-ref <staging-project-ref>`.
3. Run smoke checks for connection dispatch, chat execution, approvals, Stripe/Razorpay webhooks, and communication webhooks.
4. Require manual sign-off before production promotion.

## Rollback strategy

1. Functions rollback: redeploy previous `deploy-manifest.json` function versions from the last successful tag.
2. App rollback: redeploy previous frontend build artifact.
3. Database rollback: apply forward-fix migration only; do not run destructive schema rollbacks on shared environments.

## Railway worker deployment (Phase 1)

1. Provision a Railway service from this repository root.
2. Set config file to `railway.worker.json` for the worker service.
3. Configure environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `CONNECTOR_WORKER_TOKEN`
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL`
   - `OPENAI_EMBEDDING_MODEL=text-embedding-3-small`
   - `AGENT_RUNTIME_ENGINE=openclaw` (or `openai`)
   - `OPENCLAW_RPC_COMMAND="openclaw agent --mode rpc --json"` (if using OpenClaw engine)
   - `OPENCLAW_STRICT=true` in staging/prod after OpenClaw connectivity is verified
   - `WORKER_RUNTIME_MODE=polling`
4. Run readiness verification locally before deploy:
   - `scripts/verify-worker-deploy-readiness.sh`
5. Deploy and confirm worker logs show:
   - Supabase connectivity probe success
   - poll loop processing `connector_jobs`
   - no auth/secret mismatch warnings
   - selected agent engine (`openclaw-rpc` or `openai`) logged for runs

Detailed checklist: [`docs/operations/worker-railway.md`](/Users/jatin/Desktop/aear-ai-hub/docs/operations/worker-railway.md)

## Redis cutover (Phase 2-ready path)

1. Provision Upstash/AWS Redis and set `REDIS_URL` in Railway worker env.
2. Switch `WORKER_RUNTIME_MODE=queue` when queue-first runtime is enabled.
3. Validate with strict checks:
   - `scripts/verify-worker-deploy-readiness.sh --strict`
   - `scripts/verify-runtime-wiring.sh --strict --project-ref <project-ref>`
4. Scale worker replicas after queue-mode cutover.

## OpenClaw cutover checklist

1. Install OpenClaw CLI on worker host (`openclaw --version` must succeed).
2. Set:
   - `AGENT_RUNTIME_ENGINE=openclaw`
   - `OPENCLAW_RPC_COMMAND` as needed for your host runtime
3. Run smoke test in `dev` with approvals + governed tool execution.
   - `npm run backend:smoke-openclaw-bridge`
4. Promote to `staging` with `OPENCLAW_STRICT=false` first to observe bridge behavior.
5. Set `OPENCLAW_STRICT=true` only after stable OpenClaw RPC health in staging.
