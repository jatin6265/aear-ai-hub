# Environment Topology

OpsAI uses three Supabase environments:

- `dev`: active implementation and connector experiments
- `staging`: pre-production validation and soak testing
- `prod`: customer traffic and audited deployment only

## Promotion Rules

1. Merge to main triggers build + backend verification.
2. Apply migrations/functions to `dev`.
3. Run smoke tests and manual acceptance.
4. Promote to `staging` with the same migration/function artifacts.
5. Promote to `prod` only after staging sign-off.

## Required Environment Variables

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_EMBEDDING_MODEL` (`text-embedding-3-small`)
- `AGENT_RUNTIME_ENGINE` (`openclaw` or `openai`)
- `OPENCLAW_RPC_COMMAND` (required when `AGENT_RUNTIME_ENGINE=openclaw`)
- `OPENCLAW_STRICT`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CONNECTOR_WORKER_TOKEN`
- `WORKER_RUNTIME_MODE` (`polling` for Phase 1, `queue` for queue cutover)
- `REDIS_URL` (required when `WORKER_RUNTIME_MODE=queue`)
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- `SLACK_SIGNING_SECRET`
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- `WHATSAPP_APP_SECRET`
- `TELEGRAM_WEBHOOK_SECRET_TOKEN`
- `TEAMS_WEBHOOK_CLIENT_STATE`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`
- Connector crypto keys: `CONNECTOR_ENCRYPTION_KEY`, `CONNECTOR_ENCRYPTION_KEY_VERSION`
