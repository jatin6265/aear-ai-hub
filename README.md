# OpsAI AI Hub

Your Enterprise AI Operating Layer.

Connect any API or database. Auto-build RAG pipelines. Enforce RACI governance. Execute safely.

## Tech stack

- Vite + React + TypeScript
- Supabase (Auth, Postgres, Realtime, Storage, Edge Functions)
- Node worker runtime (`worker/connector-worker.mjs`)
- OpenAI for embeddings and LLM runtime

## Prerequisites

- Node.js 20+ recommended (Supabase JS packages target Node 20+)
- `npm`
- `jq`
- Supabase CLI (`supabase`) for deploy workflows

## Quick start (local app + backend checks)

```bash
npm run setup:e2e
npm run dev
```

In a second terminal, run:

```bash
npm run worker:run
```

## One-command backend deploy (migrations + functions + TS types)

```bash
npm run backend:deploy -- <supabase-project-ref>
```

Equivalent direct command:

```bash
scripts/deploy-backend.sh <supabase-project-ref>
```

## Verification commands

```bash
npm run backend:verify
npm run backend:verify-runtime
bash scripts/sync-supabase-env-keys.sh
```

Strict runtime check (fails if simulated/static markers are detected in critical runtime paths):

```bash
bash scripts/verify-runtime-wiring.sh --strict --project-ref <supabase-project-ref>
```

## End-to-end setup helper

Use this command to install deps, verify wiring, optionally deploy backend, and build:

```bash
scripts/setup-e2e.sh --project-ref <supabase-project-ref>
```

No deploy mode (local-only validation):

```bash
scripts/setup-e2e.sh --no-deploy
```

## Operations docs

- `docs/operations/environments.md`
- `docs/operations/deployment-runbook.md`

## Additional billing env vars

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
