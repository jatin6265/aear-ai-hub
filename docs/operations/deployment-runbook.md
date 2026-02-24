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
2. `scripts/verify-runtime-wiring.sh --project-ref <supabase-project-ref>`
3. `npm run build`
4. Confirm required secrets are set in Supabase Edge Function secrets.

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
