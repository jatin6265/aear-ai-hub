-- AEAR Agent OS big-bang continuation: runtime execution ledger, tool registry, credential vault,
-- usage/credits accounting, compatibility views, and core orchestration RPCs.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS credits_balance integer NOT NULL DEFAULT 5000,
  ADD COLUMN IF NOT EXISTS credits_used_total integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credits_last_reset_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS public.agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.ai_agents(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.chat_sessions(id) ON DELETE SET NULL,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  trigger_type text NOT NULL DEFAULT 'manual'
    CHECK (trigger_type IN ('manual', 'event', 'schedule', 'webhook', 'api')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'success', 'failed', 'cancelled', 'dead_letter')),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  execution_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  tool_calls integer NOT NULL DEFAULT 0,
  total_cost_credits integer NOT NULL DEFAULT 0,
  reservation_id uuid,
  error text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS agent_runs_tenant_status_created_idx
  ON public.agent_runs (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_runs_agent_created_idx
  ON public.agent_runs (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_runs_tenant_reservation_idx
  ON public.agent_runs (tenant_id, reservation_id);

CREATE TABLE IF NOT EXISTS public.agent_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  step_index integer NOT NULL,
  step_type text NOT NULL,
  status text NOT NULL DEFAULT 'success'
    CHECK (status IN ('queued', 'running', 'success', 'error', 'skipped')),
  tool_name text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  latency_ms integer,
  cost_credits integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_index)
);
ALTER TABLE public.agent_run_steps ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS agent_run_steps_run_idx
  ON public.agent_run_steps (run_id, step_index ASC);

CREATE TABLE IF NOT EXISTS public.agent_run_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL UNIQUE REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.ai_agents(id) ON DELETE CASCADE,
  queue text NOT NULL DEFAULT 'agent-runtime',
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'success', 'error', 'cancelled', 'dead_letter')),
  priority integer NOT NULL DEFAULT 50,
  idempotency_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  worker_id text,
  last_error text,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  triggered_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.agent_run_jobs ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS agent_run_jobs_tenant_idempotency_uidx
  ON public.agent_run_jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_run_jobs_status_sched_idx
  ON public.agent_run_jobs (status, scheduled_at, priority DESC);

CREATE INDEX IF NOT EXISTS agent_run_jobs_tenant_agent_idx
  ON public.agent_run_jobs (tenant_id, agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.tool_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  display_name text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'integration',
  input_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  handler_key text NOT NULL,
  requires_credential_service text,
  risk_level text NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  raci_required text NOT NULL DEFAULT 'R' CHECK (raci_required IN ('R', 'A', 'C', 'I', 'none')),
  is_write_action boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  version text NOT NULL DEFAULT 'v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tool_registry ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS tool_registry_global_code_uidx
  ON public.tool_registry (code)
  WHERE tenant_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tool_registry_tenant_code_uidx
  ON public.tool_registry (tenant_id, code)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tool_registry_active_idx
  ON public.tool_registry (is_active, category, code);

CREATE TABLE IF NOT EXISTS public.integration_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  service text NOT NULL,
  label text NOT NULL DEFAULT 'default',
  credential_ref text,
  algorithm text NOT NULL DEFAULT 'AES-256-GCM',
  key_version text NOT NULL DEFAULT 'v1',
  iv text NOT NULL,
  ciphertext text NOT NULL,
  auth_tag text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'revoked', 'error')),
  expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, service, label)
);
ALTER TABLE public.integration_credentials ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS integration_credentials_tenant_service_idx
  ON public.integration_credentials (tenant_id, service, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.credential_rotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL REFERENCES public.integration_credentials(id) ON DELETE CASCADE,
  rotation_type text NOT NULL DEFAULT 'automatic'
    CHECK (rotation_type IN ('refresh', 'manual', 'automatic', 'revoke')),
  status text NOT NULL DEFAULT 'success'
    CHECK (status IN ('success', 'error', 'skipped')),
  error text,
  expires_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  rotated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.credential_rotations ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS credential_rotations_credential_created_idx
  ON public.credential_rotations (credential_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.usage_meter_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  quantity numeric NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'count',
  cost_credits integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.usage_meter_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS usage_meter_events_tenant_created_idx
  ON public.usage_meter_events (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  reservation_key uuid NOT NULL DEFAULT gen_random_uuid(),
  ledger_type text NOT NULL CHECK (ledger_type IN ('reserve', 'finalize', 'refund', 'adjustment')),
  credits_delta integer NOT NULL,
  balance_after integer,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS credit_ledger_tenant_created_idx
  ON public.credit_ledger (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS credit_ledger_tenant_reservation_idx
  ON public.credit_ledger (tenant_id, reservation_key, created_at ASC);

CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  target_url text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  signature text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'success', 'error', 'dead_letter', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 6,
  last_error text,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS webhook_deliveries_status_sched_idx
  ON public.webhook_deliveries (status, scheduled_at, created_at);

CREATE INDEX IF NOT EXISTS webhook_deliveries_tenant_created_idx
  ON public.webhook_deliveries (tenant_id, created_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'set_updated_at_timestamp'
      AND pg_function_is_visible(oid)
  ) THEN
    DROP TRIGGER IF EXISTS agent_runs_set_updated_at ON public.agent_runs;
    CREATE TRIGGER agent_runs_set_updated_at
    BEFORE UPDATE ON public.agent_runs
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS agent_run_jobs_set_updated_at ON public.agent_run_jobs;
    CREATE TRIGGER agent_run_jobs_set_updated_at
    BEFORE UPDATE ON public.agent_run_jobs
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS tool_registry_set_updated_at ON public.tool_registry;
    CREATE TRIGGER tool_registry_set_updated_at
    BEFORE UPDATE ON public.tool_registry
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS integration_credentials_set_updated_at ON public.integration_credentials;
    CREATE TRIGGER integration_credentials_set_updated_at
    BEFORE UPDATE ON public.integration_credentials
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS webhook_deliveries_set_updated_at ON public.webhook_deliveries;
    CREATE TRIGGER webhook_deliveries_set_updated_at
    BEFORE UPDATE ON public.webhook_deliveries
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_timestamp();
  END IF;
END;
$$;

-- Compatibility views for organization-centric contract.
CREATE OR REPLACE VIEW public.organizations_v AS
SELECT
  t.id,
  t.name,
  t.plan AS plan_type,
  t.status,
  t.region,
  t.credits_balance AS credits,
  t.created_at
FROM public.tenants t;

CREATE OR REPLACE VIEW public.users_v AS
SELECT
  p.id,
  p.tenant_id AS organization_id,
  u.email,
  p.role,
  p.created_at
FROM public.profiles p
LEFT JOIN auth.users u ON u.id = p.id;

CREATE OR REPLACE VIEW public.agents_v AS
SELECT
  a.id,
  a.tenant_id AS organization_id,
  a.name,
  a.description,
  a.config AS config_json,
  a.status,
  COALESCE(a.config ->> 'trigger_type', 'manual') AS trigger_type,
  a.created_at
FROM public.ai_agents a;

CREATE OR REPLACE VIEW public.documents_v AS
SELECT
  d.id,
  d.tenant_id AS organization_id,
  d.file_name,
  COALESCE(d.external_url, d.storage_path) AS file_url,
  COALESCE(c.chunk_count, 0)::int AS chunk_count,
  d.created_at
FROM public.knowledge_documents d
LEFT JOIN (
  SELECT document_id, COUNT(*) AS chunk_count
  FROM public.knowledge_document_chunks
  GROUP BY document_id
) c
  ON c.document_id = d.id;

ALTER VIEW public.organizations_v SET (security_invoker = true);
ALTER VIEW public.users_v SET (security_invoker = true);
ALTER VIEW public.agents_v SET (security_invoker = true);
ALTER VIEW public.documents_v SET (security_invoker = true);

GRANT SELECT ON public.organizations_v TO authenticated;
GRANT SELECT ON public.users_v TO authenticated;
GRANT SELECT ON public.agents_v TO authenticated;
GRANT SELECT ON public.documents_v TO authenticated;

-- RLS policies
DROP POLICY IF EXISTS "Tenant members can view agent runs" ON public.agent_runs;
CREATE POLICY "Tenant members can view agent runs"
  ON public.agent_runs FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can insert agent runs" ON public.agent_runs;
CREATE POLICY "Tenant members can insert agent runs"
  ON public.agent_runs FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can update agent runs" ON public.agent_runs;
CREATE POLICY "Tenant members can update agent runs"
  ON public.agent_runs FOR UPDATE TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view agent run steps" ON public.agent_run_steps;
CREATE POLICY "Tenant members can view agent run steps"
  ON public.agent_run_steps FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage agent run steps" ON public.agent_run_steps;
CREATE POLICY "Tenant members can manage agent run steps"
  ON public.agent_run_steps FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view agent run jobs" ON public.agent_run_jobs;
CREATE POLICY "Tenant members can view agent run jobs"
  ON public.agent_run_jobs FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage agent run jobs" ON public.agent_run_jobs;
CREATE POLICY "Tenant members can manage agent run jobs"
  ON public.agent_run_jobs FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view tool registry" ON public.tool_registry;
CREATE POLICY "Tenant members can view tool registry"
  ON public.tool_registry FOR SELECT TO authenticated
  USING (tenant_id IS NULL OR tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage tenant tool registry" ON public.tool_registry;
CREATE POLICY "Tenant members can manage tenant tool registry"
  ON public.tool_registry FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Service role can manage integration credentials" ON public.integration_credentials;
CREATE POLICY "Service role can manage integration credentials"
  ON public.integration_credentials FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can manage credential rotations" ON public.credential_rotations;
CREATE POLICY "Service role can manage credential rotations"
  ON public.credential_rotations FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Tenant members can view usage meter events" ON public.usage_meter_events;
CREATE POLICY "Tenant members can view usage meter events"
  ON public.usage_meter_events FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can insert usage meter events" ON public.usage_meter_events;
CREATE POLICY "Tenant members can insert usage meter events"
  ON public.usage_meter_events FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view credit ledger" ON public.credit_ledger;
CREATE POLICY "Tenant members can view credit ledger"
  ON public.credit_ledger FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can insert credit ledger" ON public.credit_ledger;
CREATE POLICY "Tenant members can insert credit ledger"
  ON public.credit_ledger FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view webhook deliveries" ON public.webhook_deliveries;
CREATE POLICY "Tenant members can view webhook deliveries"
  ON public.webhook_deliveries FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage webhook deliveries" ON public.webhook_deliveries;
CREATE POLICY "Tenant members can manage webhook deliveries"
  ON public.webhook_deliveries FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

-- Seed global tool catalog.
INSERT INTO public.tool_registry (
  tenant_id,
  code,
  display_name,
  description,
  category,
  input_schema,
  default_config,
  handler_key,
  requires_credential_service,
  risk_level,
  raci_required,
  is_write_action,
  is_active,
  version
)
VALUES
  (NULL, 'email_reader', 'Email Reader', 'Read recent emails from connected mailbox providers.', 'communication', '{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":50}},"required":[]}'::jsonb, '{}'::jsonb, 'tool.email_reader', 'gmail', 'low', 'R', false, true, 'v1'),
  (NULL, 'gmail_send', 'Gmail Send', 'Send email through Gmail on behalf of the tenant.', 'communication', '{"type":"object","properties":{"to":{"type":"string"},"subject":{"type":"string"},"body":{"type":"string"}},"required":["to","subject","body"]}'::jsonb, '{}'::jsonb, 'tool.gmail_send', 'gmail', 'high', 'A', true, true, 'v1'),
  (NULL, 'slack_post', 'Slack Post', 'Post a message to Slack channel.', 'communication', '{"type":"object","properties":{"channel":{"type":"string"},"text":{"type":"string"}},"required":["channel","text"]}'::jsonb, '{}'::jsonb, 'tool.slack_post', 'slack', 'medium', 'R', true, true, 'v1'),
  (NULL, 'slack_read', 'Slack Read', 'Read recent messages from Slack channel.', 'communication', '{"type":"object","properties":{"channel":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":100}},"required":["channel"]}'::jsonb, '{}'::jsonb, 'tool.slack_read', 'slack', 'low', 'R', false, true, 'v1'),
  (NULL, 'http_request', 'HTTP Request', 'Perform outbound HTTP request to allowed endpoints.', 'integration', '{"type":"object","properties":{"url":{"type":"string"},"method":{"type":"string"},"headers":{"type":"object"},"body":{"type":"object"}},"required":["url"]}'::jsonb, '{"method":"GET"}'::jsonb, 'tool.http_request', NULL, 'medium', 'R', false, true, 'v1'),
  (NULL, 'webhook_call', 'Webhook Call', 'Call external webhook endpoint with payload.', 'integration', '{"type":"object","properties":{"url":{"type":"string"},"payload":{"type":"object"}},"required":["url"]}'::jsonb, '{}'::jsonb, 'tool.webhook_call', NULL, 'high', 'A', true, true, 'v1'),
  (NULL, 'database_query', 'Database Query', 'Execute governed SQL query on connected data source.', 'data', '{"type":"object","properties":{"connectionId":{"type":"string"},"sql":{"type":"string"},"limit":{"type":"integer"}},"required":["connectionId","sql"]}'::jsonb, '{"limit":200}'::jsonb, 'tool.database_query', NULL, 'medium', 'R', false, true, 'v1'),
  (NULL, 'rag_search', 'RAG Search', 'Search indexed knowledge documents and chunks.', 'memory', '{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":10}},"required":["query"]}'::jsonb, '{"limit":5}'::jsonb, 'tool.rag_search', NULL, 'low', 'R', false, true, 'v1'),
  (NULL, 'zoho_create_ticket', 'Zoho Create Ticket', 'Create support ticket in Zoho Desk.', 'crm', '{"type":"object","properties":{"subject":{"type":"string"},"body":{"type":"string"},"priority":{"type":"string"}},"required":["subject","body"]}'::jsonb, '{}'::jsonb, 'tool.zoho_create_ticket', 'zoho', 'high', 'A', true, true, 'v1'),
  (NULL, 'notion_create_page', 'Notion Create Page', 'Create page in Notion workspace database.', 'productivity', '{"type":"object","properties":{"databaseId":{"type":"string"},"title":{"type":"string"},"content":{"type":"string"}},"required":["databaseId","title"]}'::jsonb, '{}'::jsonb, 'tool.notion_create_page', 'notion', 'medium', 'R', true, true, 'v1'),
  (NULL, 'file_reader', 'File Reader', 'Read parsed text from an uploaded knowledge file.', 'documents', '{"type":"object","properties":{"documentId":{"type":"string"}},"required":["documentId"]}'::jsonb, '{}'::jsonb, 'tool.file_reader', NULL, 'low', 'R', false, true, 'v1')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.reserve_credits(
  p_estimated_credits integer,
  p_tenant_id uuid DEFAULT NULL,
  p_run_id uuid DEFAULT NULL
)
RETURNS TABLE (
  allowed boolean,
  reservation_id uuid,
  remaining_balance integer,
  reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := COALESCE(p_tenant_id, public.get_user_tenant_id());
  v_estimated integer := GREATEST(COALESCE(p_estimated_credits, 0), 0);
  v_balance integer;
  v_new_balance integer;
  v_reservation_id uuid;
BEGIN
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant context is required';
  END IF;

  SELECT credits_balance
  INTO v_balance
  FROM public.tenants
  WHERE id = v_tenant_id
  FOR UPDATE;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'Tenant not found';
  END IF;

  IF v_estimated <= 0 THEN
    v_estimated := 1;
  END IF;

  IF v_balance < v_estimated THEN
    allowed := false;
    reservation_id := NULL;
    remaining_balance := v_balance;
    reason := 'INSUFFICIENT_CREDITS';
    RETURN NEXT;
    RETURN;
  END IF;

  v_new_balance := v_balance - v_estimated;

  UPDATE public.tenants
  SET
    credits_balance = v_new_balance,
    credits_used_total = credits_used_total + v_estimated,
    updated_at = now()
  WHERE id = v_tenant_id;

  INSERT INTO public.credit_ledger (
    tenant_id,
    run_id,
    ledger_type,
    credits_delta,
    balance_after,
    details,
    created_by
  )
  VALUES (
    v_tenant_id,
    p_run_id,
    'reserve',
    -v_estimated,
    v_new_balance,
    jsonb_build_object('estimated_credits', v_estimated, 'finalized', false),
    auth.uid()
  )
  RETURNING id INTO v_reservation_id;

  allowed := true;
  reservation_id := v_reservation_id;
  remaining_balance := v_new_balance;
  reason := 'reserved';
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_credits(
  p_reservation_id uuid,
  p_actual_credits integer,
  p_status text DEFAULT 'success',
  p_run_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_tenant_id uuid;
  v_estimated integer;
  v_actual integer := GREATEST(COALESCE(p_actual_credits, 0), 0);
  v_balance integer;
  v_delta integer;
  v_balance_after integer;
  v_additional integer := 0;
BEGIN
  SELECT *
  INTO v_row
  FROM public.credit_ledger
  WHERE id = p_reservation_id
    AND ledger_type = 'reserve'
  FOR UPDATE;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Reservation not found';
  END IF;

  IF COALESCE((v_row.details ->> 'finalized')::boolean, false) THEN
    RETURN jsonb_build_object(
      'ok', true,
      'alreadyFinalized', true,
      'reservationId', p_reservation_id,
      'tenantId', v_row.tenant_id
    );
  END IF;

  v_tenant_id := v_row.tenant_id;
  v_estimated := ABS(v_row.credits_delta);

  SELECT credits_balance
  INTO v_balance
  FROM public.tenants
  WHERE id = v_tenant_id
  FOR UPDATE;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'Tenant not found';
  END IF;

  v_delta := v_estimated - v_actual;

  IF v_delta > 0 THEN
    v_balance_after := v_balance + v_delta;

    UPDATE public.tenants
    SET
      credits_balance = v_balance_after,
      credits_used_total = GREATEST(0, credits_used_total - v_delta),
      updated_at = now()
    WHERE id = v_tenant_id;

    INSERT INTO public.credit_ledger (
      tenant_id,
      run_id,
      reservation_key,
      ledger_type,
      credits_delta,
      balance_after,
      details,
      created_by
    )
    VALUES (
      v_tenant_id,
      p_run_id,
      v_row.reservation_key,
      'refund',
      v_delta,
      v_balance_after,
      jsonb_build_object('reservation_id', p_reservation_id, 'estimated', v_estimated, 'actual', v_actual),
      auth.uid()
    );
  ELSIF v_delta < 0 THEN
    v_additional := ABS(v_delta);

    IF v_balance < v_additional THEN
      v_additional := v_balance;
    END IF;

    v_balance_after := v_balance - v_additional;

    UPDATE public.tenants
    SET
      credits_balance = v_balance_after,
      credits_used_total = credits_used_total + v_additional,
      updated_at = now()
    WHERE id = v_tenant_id;

    IF v_additional > 0 THEN
      INSERT INTO public.credit_ledger (
        tenant_id,
        run_id,
        reservation_key,
        ledger_type,
        credits_delta,
        balance_after,
        details,
        created_by
      )
      VALUES (
        v_tenant_id,
        p_run_id,
        v_row.reservation_key,
        'finalize',
        -v_additional,
        v_balance_after,
        jsonb_build_object('reservation_id', p_reservation_id, 'estimated', v_estimated, 'actual', v_actual),
        auth.uid()
      );
    END IF;
  ELSE
    v_balance_after := v_balance;
  END IF;

  UPDATE public.credit_ledger
  SET details = COALESCE(details, '{}'::jsonb) || jsonb_build_object(
    'finalized', true,
    'finalized_at', now(),
    'final_status', COALESCE(NULLIF(trim(p_status), ''), 'success'),
    'actual_credits', v_actual
  )
  WHERE id = p_reservation_id;

  RETURN jsonb_build_object(
    'ok', true,
    'reservationId', p_reservation_id,
    'tenantId', v_tenant_id,
    'estimatedCredits', v_estimated,
    'actualCredits', v_actual,
    'additionalCharged', v_additional,
    'balanceAfter', v_balance_after
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_tool_definition(
  p_tool_name text,
  p_agent_id uuid DEFAULT NULL,
  p_tenant_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  code text,
  display_name text,
  description text,
  category text,
  input_schema jsonb,
  default_config jsonb,
  handler_key text,
  requires_credential_service text,
  risk_level text,
  raci_required text,
  is_write_action boolean,
  version text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := p_tenant_id;
  v_code text := lower(trim(COALESCE(p_tool_name, '')));
BEGIN
  IF v_code = '' THEN
    RAISE EXCEPTION 'Tool name is required';
  END IF;

  IF v_tenant_id IS NULL AND p_agent_id IS NOT NULL THEN
    SELECT a.tenant_id
    INTO v_tenant_id
    FROM public.ai_agents a
    WHERE a.id = p_agent_id;
  END IF;

  IF v_tenant_id IS NULL THEN
    v_tenant_id := public.get_user_tenant_id();
  END IF;

  RETURN QUERY
  SELECT
    t.id,
    t.tenant_id,
    t.code,
    t.display_name,
    t.description,
    t.category,
    t.input_schema,
    t.default_config,
    t.handler_key,
    t.requires_credential_service,
    t.risk_level,
    t.raci_required,
    t.is_write_action,
    t.version
  FROM public.tool_registry t
  WHERE t.code = v_code
    AND t.is_active = true
    AND (t.tenant_id IS NULL OR t.tenant_id = v_tenant_id)
  ORDER BY CASE WHEN t.tenant_id = v_tenant_id THEN 0 ELSE 1 END
  LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_tool_execution(
  p_run_id uuid,
  p_tool_name text,
  p_status text,
  p_tool_input jsonb DEFAULT '{}'::jsonb,
  p_tool_output jsonb DEFAULT '{}'::jsonb,
  p_latency_ms integer DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_risk_level text DEFAULT NULL,
  p_agent_id uuid DEFAULT NULL,
  p_session_id uuid DEFAULT NULL,
  p_cost_credits integer DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_inserted_id uuid;
  v_tool_name text := trim(COALESCE(p_tool_name, ''));
BEGIN
  IF v_tool_name = '' THEN
    RAISE EXCEPTION 'Tool name is required';
  END IF;

  SELECT r.tenant_id
  INTO v_tenant_id
  FROM public.agent_runs r
  WHERE r.id = p_run_id;

  IF v_tenant_id IS NULL THEN
    v_tenant_id := public.get_user_tenant_id();
  END IF;

  INSERT INTO public.agent_tool_runs (
    tenant_id,
    session_id,
    agent_id,
    agent_name,
    tool_name,
    tool_input,
    tool_output,
    status,
    latency_ms,
    error,
    risk_level
  )
  VALUES (
    v_tenant_id,
    p_session_id,
    p_agent_id,
    NULL,
    v_tool_name,
    COALESCE(p_tool_input, '{}'::jsonb),
    COALESCE(p_tool_output, '{}'::jsonb),
    CASE
      WHEN lower(COALESCE(p_status, '')) IN ('queued', 'running', 'success', 'error', 'blocked')
        THEN lower(p_status)
      ELSE 'error'
    END,
    p_latency_ms,
    p_error,
    p_risk_level
  )
  RETURNING id INTO v_inserted_id;

  IF p_run_id IS NOT NULL THEN
    UPDATE public.agent_runs
    SET
      tool_calls = tool_calls + 1,
      total_cost_credits = total_cost_credits + GREATEST(COALESCE(p_cost_credits, 0), 0),
      updated_at = now()
    WHERE id = p_run_id;
  END IF;

  RETURN v_inserted_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_agent_run(
  p_agent_id uuid,
  p_input jsonb DEFAULT '{}'::jsonb,
  p_session_id uuid DEFAULT NULL,
  p_trigger_type text DEFAULT 'manual',
  p_estimated_credits integer DEFAULT 10,
  p_priority integer DEFAULT 50,
  p_idempotency_key text DEFAULT NULL,
  p_invoked_via text DEFAULT 'app'
)
RETURNS TABLE (
  run_id uuid,
  job_id uuid,
  reservation_id uuid,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent record;
  v_trigger text := lower(trim(COALESCE(p_trigger_type, 'manual')));
  v_idempotency text := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
  v_reserve record;
  v_entitlement record;
  v_run_id uuid;
  v_job_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT a.id, a.tenant_id, a.status
  INTO v_agent
  FROM public.ai_agents a
  WHERE a.id = p_agent_id
    AND a.tenant_id = public.get_user_tenant_id();

  IF v_agent.id IS NULL THEN
    RAISE EXCEPTION 'Agent not found';
  END IF;

  IF v_agent.status = 'disabled' THEN
    RAISE EXCEPTION 'Agent is disabled';
  END IF;

  SELECT *
  INTO v_entitlement
  FROM public.tenant_entitlements_check('agent_runs', 1, v_agent.tenant_id)
  LIMIT 1;

  IF v_entitlement IS NOT NULL AND COALESCE(v_entitlement.allowed, false) = false THEN
    RAISE EXCEPTION 'Agent run entitlement denied: %', COALESCE(v_entitlement.reason, 'limit reached');
  END IF;

  SELECT *
  INTO v_reserve
  FROM public.reserve_credits(
    p_estimated_credits => p_estimated_credits,
    p_tenant_id => v_agent.tenant_id,
    p_run_id => NULL
  )
  LIMIT 1;

  IF COALESCE(v_reserve.allowed, false) = false THEN
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  IF v_trigger NOT IN ('manual', 'event', 'schedule', 'webhook', 'api') THEN
    v_trigger := 'manual';
  END IF;

  INSERT INTO public.agent_runs (
    tenant_id,
    agent_id,
    session_id,
    requested_by,
    trigger_type,
    status,
    input,
    reservation_id,
    queued_at
  )
  VALUES (
    v_agent.tenant_id,
    v_agent.id,
    p_session_id,
    auth.uid(),
    v_trigger,
    'queued',
    COALESCE(p_input, '{}'::jsonb),
    v_reserve.reservation_id,
    now()
  )
  RETURNING id INTO v_run_id;

  INSERT INTO public.agent_run_jobs (
    tenant_id,
    run_id,
    agent_id,
    queue,
    status,
    priority,
    idempotency_key,
    payload,
    triggered_by,
    scheduled_at
  )
  VALUES (
    v_agent.tenant_id,
    v_run_id,
    v_agent.id,
    'agent-runtime',
    'queued',
    GREATEST(1, LEAST(COALESCE(p_priority, 50), 100)),
    v_idempotency,
    jsonb_build_object(
      'input', COALESCE(p_input, '{}'::jsonb),
      'trigger_type', v_trigger,
      'invoked_via', COALESCE(NULLIF(trim(p_invoked_via), ''), 'app')
    ),
    auth.uid(),
    now()
  )
  RETURNING id INTO v_job_id;

  UPDATE public.credit_ledger
  SET run_id = v_run_id
  WHERE id = v_reserve.reservation_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_agent.tenant_id,
    auth.uid(),
    'agent.run.enqueue',
    'agent_runs',
    'success',
    jsonb_build_object(
      'agent_id', v_agent.id,
      'run_id', v_run_id,
      'job_id', v_job_id,
      'estimated_credits', p_estimated_credits,
      'trigger_type', v_trigger
    )
  );

  run_id := v_run_id;
  job_id := v_job_id;
  reservation_id := v_reserve.reservation_id;
  status := 'queued';
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_agent_run_jobs(
  p_worker_id text,
  p_limit integer DEFAULT 3,
  p_queues text[] DEFAULT NULL
)
RETURNS TABLE (
  job_id uuid,
  tenant_id uuid,
  run_id uuid,
  agent_id uuid,
  queue text,
  payload jsonb,
  attempt_count integer,
  max_attempts integer,
  started_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_worker_id text := NULLIF(trim(COALESCE(p_worker_id, '')), '');
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 3), 25));
BEGIN
  IF v_worker_id IS NULL THEN
    RAISE EXCEPTION 'Worker id is required';
  END IF;

  RETURN QUERY
  WITH selected AS (
    SELECT j.id
    FROM public.agent_run_jobs j
    WHERE j.status = 'queued'
      AND j.scheduled_at <= now()
      AND (
        p_queues IS NULL
        OR array_length(p_queues, 1) IS NULL
        OR j.queue = ANY(p_queues)
      )
    ORDER BY j.priority DESC, j.scheduled_at ASC, j.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  ),
  claimed AS (
    UPDATE public.agent_run_jobs j
    SET
      status = 'running',
      worker_id = v_worker_id,
      started_at = COALESCE(j.started_at, now()),
      last_error = NULL,
      updated_at = now()
    WHERE j.id IN (SELECT id FROM selected)
    RETURNING
      j.id,
      j.tenant_id,
      j.run_id,
      j.agent_id,
      j.queue,
      j.payload,
      j.attempt_count,
      j.max_attempts,
      j.started_at
  )
  SELECT
    c.id,
    c.tenant_id,
    c.run_id,
    c.agent_id,
    c.queue,
    c.payload,
    c.attempt_count,
    c.max_attempts,
    c.started_at
  FROM claimed c;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_agent_run_step(
  p_run_id uuid,
  p_step_type text,
  p_status text DEFAULT 'success',
  p_data jsonb DEFAULT '{}'::jsonb,
  p_tool_name text DEFAULT NULL,
  p_latency_ms integer DEFAULT NULL,
  p_cost_credits integer DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run record;
  v_next_index integer;
  v_status text := lower(trim(COALESCE(p_status, 'success')));
  v_step_id uuid;
  v_entry jsonb;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'Run id is required';
  END IF;

  SELECT *
  INTO v_run
  FROM public.agent_runs
  WHERE id = p_run_id;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'Run not found';
  END IF;

  IF v_status NOT IN ('queued', 'running', 'success', 'error', 'skipped') THEN
    v_status := 'success';
  END IF;

  SELECT COALESCE(MAX(s.step_index), 0) + 1
  INTO v_next_index
  FROM public.agent_run_steps s
  WHERE s.run_id = p_run_id;

  INSERT INTO public.agent_run_steps (
    tenant_id,
    run_id,
    step_index,
    step_type,
    status,
    tool_name,
    data,
    latency_ms,
    cost_credits
  )
  VALUES (
    v_run.tenant_id,
    p_run_id,
    v_next_index,
    COALESCE(NULLIF(trim(p_step_type), ''), 'system'),
    v_status,
    NULLIF(trim(COALESCE(p_tool_name, '')), ''),
    COALESCE(p_data, '{}'::jsonb),
    p_latency_ms,
    GREATEST(COALESCE(p_cost_credits, 0), 0)
  )
  RETURNING id INTO v_step_id;

  v_entry := jsonb_build_object(
    'step_index', v_next_index,
    'step_type', COALESCE(NULLIF(trim(p_step_type), ''), 'system'),
    'status', v_status,
    'tool_name', NULLIF(trim(COALESCE(p_tool_name, '')), ''),
    'data', COALESCE(p_data, '{}'::jsonb),
    'latency_ms', p_latency_ms,
    'cost_credits', GREATEST(COALESCE(p_cost_credits, 0), 0),
    'created_at', now()
  );

  UPDATE public.agent_runs r
  SET
    execution_log = COALESCE(r.execution_log, '[]'::jsonb) || jsonb_build_array(v_entry),
    tool_calls = r.tool_calls + CASE WHEN NULLIF(trim(COALESCE(p_tool_name, '')), '') IS NULL THEN 0 ELSE 1 END,
    total_cost_credits = r.total_cost_credits + GREATEST(COALESCE(p_cost_credits, 0), 0),
    updated_at = now()
  WHERE r.id = p_run_id;

  RETURN v_step_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_agent_run_replay(
  p_run_id uuid
)
RETURNS TABLE (
  step_index integer,
  step_type text,
  status text,
  tool_name text,
  data jsonb,
  latency_ms integer,
  cost_credits integer,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.step_index,
    s.step_type,
    s.status,
    s.tool_name,
    s.data,
    s.latency_ms,
    s.cost_credits,
    s.created_at
  FROM public.agent_run_steps s
  JOIN public.agent_runs r ON r.id = s.run_id
  WHERE s.run_id = p_run_id
    AND r.tenant_id = public.get_user_tenant_id()
  ORDER BY s.step_index ASC;
$$;

CREATE OR REPLACE FUNCTION public.get_usage_summary(
  p_tenant_id uuid DEFAULT NULL,
  p_window_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := COALESCE(p_tenant_id, public.get_user_tenant_id());
  v_days integer := GREATEST(1, LEAST(COALESCE(p_window_days, 30), 365));
  v_from timestamptz := now() - make_interval(days => v_days);
  v_result jsonb;
BEGIN
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant context is required';
  END IF;

  SELECT jsonb_build_object(
    'tenantId', v_tenant_id,
    'windowDays', v_days,
    'runs', jsonb_build_object(
      'total', COUNT(*)::int,
      'success', COUNT(*) FILTER (WHERE r.status = 'success')::int,
      'failed', COUNT(*) FILTER (WHERE r.status IN ('failed', 'dead_letter'))::int,
      'running', COUNT(*) FILTER (WHERE r.status = 'running')::int
    ),
    'credits', jsonb_build_object(
      'balance', t.credits_balance,
      'usedTotal', t.credits_used_total,
      'periodUsage', COALESCE(SUM(r.total_cost_credits), 0)::int,
      'ledgerDelta', COALESCE((
        SELECT SUM(cl.credits_delta)::int
        FROM public.credit_ledger cl
        WHERE cl.tenant_id = v_tenant_id
          AND cl.created_at >= v_from
      ), 0)
    ),
    'tokens', jsonb_build_object(
      'input', COALESCE(SUM(r.input_tokens), 0)::int,
      'output', COALESCE(SUM(r.output_tokens), 0)::int
    ),
    'tools', jsonb_build_object(
      'calls', COALESCE(SUM(r.tool_calls), 0)::int,
      'events', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('eventType', u.event_type, 'quantity', u.qty, 'costCredits', u.cost))
        FROM (
          SELECT ume.event_type, SUM(ume.quantity)::numeric AS qty, SUM(ume.cost_credits)::int AS cost
          FROM public.usage_meter_events ume
          WHERE ume.tenant_id = v_tenant_id
            AND ume.created_at >= v_from
          GROUP BY ume.event_type
          ORDER BY ume.event_type
        ) u
      ), '[]'::jsonb)
    )
  )
  INTO v_result
  FROM public.agent_runs r
  JOIN public.tenants t ON t.id = v_tenant_id
  WHERE r.tenant_id = v_tenant_id
    AND r.created_at >= v_from;

  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reserve_credits(integer, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_credits(uuid, integer, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_tool_definition(text, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_tool_execution(uuid, text, text, jsonb, jsonb, integer, text, text, uuid, uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_agent_run(uuid, jsonb, uuid, text, integer, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_agent_run_jobs(text, integer, text[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_agent_run_step(uuid, text, text, jsonb, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_agent_run_replay(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_usage_summary(uuid, integer) TO authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'agent_runs'
  ) THEN
    NULL;
  ELSE
    ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_runs;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'agent_run_jobs'
  ) THEN
    NULL;
  ELSE
    ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_run_jobs;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'agent_run_steps'
  ) THEN
    NULL;
  ELSE
    ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_run_steps;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'webhook_deliveries'
  ) THEN
    NULL;
  ELSE
    ALTER PUBLICATION supabase_realtime ADD TABLE public.webhook_deliveries;
  END IF;
END;
$$;
