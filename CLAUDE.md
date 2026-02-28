# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev           # Start frontend (Vite)
npm run worker:run    # Start connector worker (run in a second terminal)

# Build & lint
npm run build         # Production build
npm run lint          # ESLint

# Tests
npm test              # Run all tests once (vitest)
npm run test:watch    # Watch mode

# Backend
npm run backend:verify           # Check backend artifacts
npm run backend:verify-runtime   # Runtime wiring check
npm run backend:deploy -- <project-ref>  # Deploy migrations + edge functions + types

# Full end-to-end setup (installs deps, verifies, optionally deploys, builds)
npm run setup:e2e                          # Local-only (no deploy)
scripts/setup-e2e.sh --project-ref <ref>  # With deploy
```

## Architecture

OpsAI is a multi-tenant enterprise AI operating layer. It has three runtime components that must all run:

1. **Frontend** (`src/`) – Vite + React + TypeScript SPA
2. **Supabase backend** – Postgres (with RLS + RPCs), Auth, and Edge Functions (Deno)
3. **Connector worker** (`worker/connector-worker.mjs`) – Node.js polling process that executes connector sync jobs dispatched via the `connector_jobs` table

### Frontend structure

- `src/App.tsx` – Root router with lazy-loaded pages and the full route tree
- `src/layouts/AppLayout.tsx` – Authenticated shell with sidebar/nav, wraps all `/dashboard/*` routes
- `src/hooks/useAuth.ts` – `AuthProvider` + `useAuth` hook; manages Supabase session state, JWT validation, and token refresh
- `src/lib/auth-provisioning.ts` – `ensureUserWorkspace()` (calls `provision_user_workspace` RPC), `tenantNeedsOnboarding()`, `tenantHasConnections()`
- `src/lib/edge-invoke.ts` – `invokeEdge()` wrapper for all edge function calls; handles auth headers, token refresh, and 401 retry
- `src/stores/appStore.ts` – Zustand store for sidebar state and `currentTenantId`
- `src/integrations/supabase/` – Auto-generated Supabase client and TypeScript types

### Route guard hierarchy

```
ProtectedRoute (requires auth + email verified)
├── /onboarding
├── SuperAdminRoute (checks platform_admin_users table)
│   └── /platform-admin/*
└── AppLayout
    └── OnboardingGuard (redirects to /onboarding if tenant not yet active)
        ├── AdminOnlyRoute (role === "admin" | "owner")
        │   └── /dashboard/admin/*
        └── all other /dashboard/* routes
```

### Edge Functions

All edge functions live in `supabase/functions/<name>/index.ts` and run on Deno. Shared helpers:
- `_shared/auth.ts` – `getAuthedClient()`: verifies the Bearer JWT and returns an authed Supabase client
- `_shared/service.ts` – `getServiceClient()`: returns a service-role Supabase client; `requireWorkerToken()`: validates `CONNECTOR_WORKER_TOKEN` for worker-to-function calls

Every function follows the pattern: validate auth → call a Postgres RPC → return JSON. The list of deployed functions is in `supabase/functions/deploy-manifest.json`.

### Multi-tenancy

Every user belongs to a `tenant`. Tables use `tenant_id` as a partition key and Row Level Security enforces isolation. Tenant provisioning happens via the `provision_user_workspace` Postgres RPC called during sign-in/sign-up.

User roles within a tenant: `owner`, `admin`, `member`. Platform super-admins are tracked separately in `platform_admin_users`.

### Required environment variables (edge functions / worker)

```
OPENAI_API_KEY, OPENAI_MODEL
SUPABASE_SERVICE_ROLE_KEY
CONNECTOR_WORKER_TOKEN
CONNECTOR_ENCRYPTION_KEY, CONNECTOR_ENCRYPTION_KEY_VERSION
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD
```

Frontend reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (or `VITE_SUPABASE_ANON_KEY`) from `.env`.

### Database migrations

Migrations are in `supabase/migrations/` and applied in timestamp order via `supabase db push`. The backend deploy script handles this automatically.

### Environments

Three Supabase environments: `dev` → `staging` → `prod`. Promotion requires passing `scripts/verify-runtime-wiring.sh` and a manual smoke-test checklist (see `docs/operations/deployment-runbook.md`).
