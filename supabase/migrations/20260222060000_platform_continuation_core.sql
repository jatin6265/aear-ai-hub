-- Platform continuation core: job orchestration, hybrid retrieval, policy/entitlements, billing/admin foundations.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS stripe_customer_id text;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS billing_cycle text DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS current_period_start timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS tenants_stripe_customer_uidx
  ON public.tenants (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_stripe_subscription_uidx
  ON public.subscriptions (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

ALTER TABLE public.ai_agents
  DROP CONSTRAINT IF EXISTS ai_agents_status_check;

ALTER TABLE public.ai_agents
  ADD COLUMN IF NOT EXISTS lifecycle_reason text,
  ADD COLUMN IF NOT EXISTS schema_fingerprint text,
  ADD COLUMN IF NOT EXISTS last_regenerated_at timestamptz;

ALTER TABLE public.ai_agents
  ADD CONSTRAINT ai_agents_status_check
  CHECK (status IN ('draft', 'ready', 'syncing', 'degraded', 'disabled'));

ALTER TABLE public.knowledge_document_chunks
  ADD COLUMN IF NOT EXISTS embedding vector(1536),
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS embedded_at timestamptz;

CREATE INDEX IF NOT EXISTS knowledge_document_chunks_embedding_idx
  ON public.knowledge_document_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE TABLE IF NOT EXISTS public.connector_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.api_connections(id) ON DELETE CASCADE,
  job_type text NOT NULL DEFAULT 'schema_discovery'
    CHECK (job_type IN ('schema_discovery', 'incremental_sync', 'full_sync', 'embedding_refresh')),
  queue text NOT NULL DEFAULT 'default',
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'success', 'error', 'cancelled', 'dead_letter')),
  priority integer NOT NULL DEFAULT 50,
  idempotency_key text,
  trigger_reason text NOT NULL DEFAULT 'manual',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress numeric(5,2) NOT NULL DEFAULT 0,
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

CREATE UNIQUE INDEX IF NOT EXISTS connector_jobs_tenant_idempotency_uidx
  ON public.connector_jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS connector_jobs_status_sched_idx
  ON public.connector_jobs (status, scheduled_at, priority DESC);

CREATE INDEX IF NOT EXISTS connector_jobs_tenant_connection_idx
  ON public.connector_jobs (tenant_id, connection_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.connector_job_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.connector_jobs(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  worker_id text,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'error', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  error_message text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS connector_job_attempts_job_idx
  ON public.connector_job_attempts (job_id, started_at DESC);

CREATE TABLE IF NOT EXISTS public.embedding_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('knowledge_chunk', 'connection_entity', 'document')),
  source_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'success', 'error', 'cancelled', 'dead_letter')),
  embedding_model text NOT NULL DEFAULT 'text-embedding-3-small',
  vector_dimensions integer NOT NULL DEFAULT 1536,
  priority integer NOT NULL DEFAULT 50,
  idempotency_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_estimate integer,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  worker_id text,
  last_error text,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS embedding_jobs_tenant_idempotency_uidx
  ON public.embedding_jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS embedding_jobs_status_sched_idx
  ON public.embedding_jobs (status, scheduled_at, priority DESC);

CREATE TABLE IF NOT EXISTS public.retrieval_eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  query text NOT NULL,
  expected_source_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  retrieved_source_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS retrieval_eval_runs_tenant_created_idx
  ON public.retrieval_eval_runs (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'stripe',
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'ignored', 'error')),
  error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS billing_events_tenant_created_idx
  ON public.billing_events (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.invoice_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'stripe',
  provider_invoice_id text NOT NULL,
  provider_subscription_id text,
  currency text NOT NULL DEFAULT 'usd',
  subtotal_cents integer NOT NULL DEFAULT 0,
  tax_cents integer NOT NULL DEFAULT 0,
  total_cents integer NOT NULL DEFAULT 0,
  amount_paid_cents integer NOT NULL DEFAULT 0,
  amount_due_cents integer NOT NULL DEFAULT 0,
  invoice_status text NOT NULL DEFAULT 'draft',
  invoice_url text,
  hosted_invoice_url text,
  period_start timestamptz,
  period_end timestamptz,
  due_at timestamptz,
  paid_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_invoice_id)
);

CREATE INDEX IF NOT EXISTS invoice_snapshots_tenant_created_idx
  ON public.invoice_snapshots (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.tenant_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  capability text NOT NULL,
  soft_limit integer,
  hard_limit integer,
  current_usage integer NOT NULL DEFAULT 0,
  reset_period text NOT NULL DEFAULT 'monthly'
    CHECK (reset_period IN ('none', 'daily', 'weekly', 'monthly', 'annual')),
  reset_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, capability)
);

CREATE TABLE IF NOT EXISTS public.agent_tool_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  message_id uuid REFERENCES public.chat_messages(id) ON DELETE SET NULL,
  agent_id uuid REFERENCES public.ai_agents(id) ON DELETE SET NULL,
  agent_name text,
  tool_name text NOT NULL,
  tool_input jsonb NOT NULL DEFAULT '{}'::jsonb,
  tool_output jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'success'
    CHECK (status IN ('queued', 'running', 'success', 'error', 'blocked')),
  latency_ms integer,
  error text,
  risk_level text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_tool_runs_tenant_session_idx
  ON public.agent_tool_runs (tenant_id, session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.agent_action_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  agent_id uuid REFERENCES public.ai_agents(id) ON DELETE SET NULL,
  resource text NOT NULL,
  action text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_decision jsonb NOT NULL DEFAULT '{}'::jsonb,
  approval_request_id uuid REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'blocked', 'approved', 'executed', 'failed', 'cancelled')),
  simulation_preview jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_action_runs_tenant_status_idx
  ON public.agent_action_runs (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.integration_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  display_name text NOT NULL,
  category text NOT NULL,
  logo_url text,
  docs_url text,
  supported_auth text[] NOT NULL DEFAULT ARRAY[]::text[],
  config_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.anomaly_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES public.api_connections(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  signal_type text NOT NULL DEFAULT 'trend',
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS anomaly_insights_tenant_status_idx
  ON public.anomaly_insights (tenant_id, status, detected_at DESC);

CREATE TABLE IF NOT EXISTS public.widget_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'disabled')),
  allowed_origins text[] NOT NULL DEFAULT ARRAY[]::text[],
  appearance jsonb NOT NULL DEFAULT '{}'::jsonb,
  behavior jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_hash text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS public.platform_admin_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.connector_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_job_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.embedding_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retrieval_eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_tool_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_action_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anomaly_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_admin_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant members can view connector jobs" ON public.connector_jobs;
CREATE POLICY "Tenant members can view connector jobs"
  ON public.connector_jobs FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage connector jobs" ON public.connector_jobs;
CREATE POLICY "Tenant members can manage connector jobs"
  ON public.connector_jobs FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view connector attempts" ON public.connector_job_attempts;
CREATE POLICY "Tenant members can view connector attempts"
  ON public.connector_job_attempts FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage connector attempts" ON public.connector_job_attempts;
CREATE POLICY "Tenant members can manage connector attempts"
  ON public.connector_job_attempts FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view embedding jobs" ON public.embedding_jobs;
CREATE POLICY "Tenant members can view embedding jobs"
  ON public.embedding_jobs FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage embedding jobs" ON public.embedding_jobs;
CREATE POLICY "Tenant members can manage embedding jobs"
  ON public.embedding_jobs FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view retrieval eval runs" ON public.retrieval_eval_runs;
CREATE POLICY "Tenant members can view retrieval eval runs"
  ON public.retrieval_eval_runs FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage retrieval eval runs" ON public.retrieval_eval_runs;
CREATE POLICY "Tenant members can manage retrieval eval runs"
  ON public.retrieval_eval_runs FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view billing events" ON public.billing_events;
CREATE POLICY "Tenant members can view billing events"
  ON public.billing_events FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view invoice snapshots" ON public.invoice_snapshots;
CREATE POLICY "Tenant members can view invoice snapshots"
  ON public.invoice_snapshots FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage invoice snapshots" ON public.invoice_snapshots;
CREATE POLICY "Tenant members can manage invoice snapshots"
  ON public.invoice_snapshots FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view entitlements" ON public.tenant_entitlements;
CREATE POLICY "Tenant members can view entitlements"
  ON public.tenant_entitlements FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage entitlements" ON public.tenant_entitlements;
CREATE POLICY "Tenant members can manage entitlements"
  ON public.tenant_entitlements FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view agent tool runs" ON public.agent_tool_runs;
CREATE POLICY "Tenant members can view agent tool runs"
  ON public.agent_tool_runs FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage agent tool runs" ON public.agent_tool_runs;
CREATE POLICY "Tenant members can manage agent tool runs"
  ON public.agent_tool_runs FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view agent action runs" ON public.agent_action_runs;
CREATE POLICY "Tenant members can view agent action runs"
  ON public.agent_action_runs FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage agent action runs" ON public.agent_action_runs;
CREATE POLICY "Tenant members can manage agent action runs"
  ON public.agent_action_runs FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Authenticated users can view integration catalog" ON public.integration_catalog;
CREATE POLICY "Authenticated users can view integration catalog"
  ON public.integration_catalog FOR SELECT TO authenticated
  USING (is_active = true);

DROP POLICY IF EXISTS "Tenant members can view anomaly insights" ON public.anomaly_insights;
CREATE POLICY "Tenant members can view anomaly insights"
  ON public.anomaly_insights FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage anomaly insights" ON public.anomaly_insights;
CREATE POLICY "Tenant members can manage anomaly insights"
  ON public.anomaly_insights FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view widget configs" ON public.widget_configs;
CREATE POLICY "Tenant members can view widget configs"
  ON public.widget_configs FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage widget configs" ON public.widget_configs;
CREATE POLICY "Tenant members can manage widget configs"
  ON public.widget_configs FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Platform admins can view admin users" ON public.platform_admin_users;
CREATE POLICY "Platform admins can view admin users"
  ON public.platform_admin_users FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Platform admins can insert admin users" ON public.platform_admin_users;
CREATE POLICY "Platform admins can insert admin users"
  ON public.platform_admin_users FOR INSERT TO authenticated
  WITH CHECK (false);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'set_updated_at_timestamp'
      AND pg_function_is_visible(oid)
  ) THEN
    DROP TRIGGER IF EXISTS connector_jobs_set_updated_at ON public.connector_jobs;
    CREATE TRIGGER connector_jobs_set_updated_at
    BEFORE UPDATE ON public.connector_jobs
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS embedding_jobs_set_updated_at ON public.embedding_jobs;
    CREATE TRIGGER embedding_jobs_set_updated_at
    BEFORE UPDATE ON public.embedding_jobs
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS invoice_snapshots_set_updated_at ON public.invoice_snapshots;
    CREATE TRIGGER invoice_snapshots_set_updated_at
    BEFORE UPDATE ON public.invoice_snapshots
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS tenant_entitlements_set_updated_at ON public.tenant_entitlements;
    CREATE TRIGGER tenant_entitlements_set_updated_at
    BEFORE UPDATE ON public.tenant_entitlements
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS agent_action_runs_set_updated_at ON public.agent_action_runs;
    CREATE TRIGGER agent_action_runs_set_updated_at
    BEFORE UPDATE ON public.agent_action_runs
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS integration_catalog_set_updated_at ON public.integration_catalog;
    CREATE TRIGGER integration_catalog_set_updated_at
    BEFORE UPDATE ON public.integration_catalog
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS anomaly_insights_set_updated_at ON public.anomaly_insights;
    CREATE TRIGGER anomaly_insights_set_updated_at
    BEFORE UPDATE ON public.anomaly_insights
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS widget_configs_set_updated_at ON public.widget_configs;
    CREATE TRIGGER widget_configs_set_updated_at
    BEFORE UPDATE ON public.widget_configs
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.enqueue_connector_sync(
  p_connection_id uuid,
  p_job_type text DEFAULT 'schema_discovery',
  p_trigger_reason text DEFAULT 'manual',
  p_priority integer DEFAULT 50,
  p_idempotency_key text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  job_id uuid,
  status text,
  queue text,
  scheduled_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_job_type text := lower(trim(COALESCE(p_job_type, 'schema_discovery')));
  v_job_id uuid;
  v_queue text := CASE WHEN v_job_type = 'embedding_refresh' THEN 'embeddings' ELSE 'connector-sync' END;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.api_connections c
    WHERE c.id = p_connection_id
      AND c.tenant_id = v_tenant_id
      AND c.is_archived = false
  ) THEN
    RAISE EXCEPTION 'Connection not found for tenant';
  END IF;

  IF v_job_type NOT IN ('schema_discovery', 'incremental_sync', 'full_sync', 'embedding_refresh') THEN
    v_job_type := 'schema_discovery';
  END IF;

  INSERT INTO public.connector_jobs (
    tenant_id,
    connection_id,
    job_type,
    queue,
    status,
    priority,
    idempotency_key,
    trigger_reason,
    payload,
    triggered_by
  )
  VALUES (
    v_tenant_id,
    p_connection_id,
    v_job_type,
    v_queue,
    'queued',
    GREATEST(1, LEAST(COALESCE(p_priority, 50), 100)),
    NULLIF(trim(COALESCE(p_idempotency_key, '')), ''),
    trim(COALESCE(p_trigger_reason, 'manual')),
    COALESCE(p_payload, '{}'::jsonb),
    auth.uid()
  )
  ON CONFLICT (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL
  DO UPDATE SET
    payload = EXCLUDED.payload,
    updated_at = now(),
    priority = EXCLUDED.priority
  RETURNING id, connector_jobs.status, connector_jobs.queue, connector_jobs.scheduled_at
  INTO v_job_id, status, queue, scheduled_at;

  UPDATE public.api_connections
  SET
    status = CASE WHEN status = 'error' THEN 'pending' ELSE status END,
    analysis_started_at = COALESCE(analysis_started_at, now())
  WHERE id = p_connection_id
    AND tenant_id = v_tenant_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'connector.sync.enqueued',
    p_connection_id::text,
    'success',
    jsonb_build_object('job_id', v_job_id, 'job_type', v_job_type, 'queue', queue)
  );

  job_id := v_job_id;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_embedding_job(
  p_source_type text,
  p_source_id uuid,
  p_priority integer DEFAULT 50,
  p_idempotency_key text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  job_id uuid,
  status text,
  scheduled_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  INSERT INTO public.embedding_jobs (
    tenant_id,
    source_type,
    source_id,
    priority,
    idempotency_key,
    payload,
    created_by
  )
  VALUES (
    v_tenant_id,
    lower(trim(COALESCE(p_source_type, 'document'))),
    p_source_id,
    GREATEST(1, LEAST(COALESCE(p_priority, 50), 100)),
    NULLIF(trim(COALESCE(p_idempotency_key, '')), ''),
    COALESCE(p_payload, '{}'::jsonb),
    auth.uid()
  )
  ON CONFLICT (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL
  DO UPDATE SET
    payload = EXCLUDED.payload,
    priority = EXCLUDED.priority,
    updated_at = now()
  RETURNING id, embedding_jobs.status, embedding_jobs.scheduled_at
  INTO job_id, status, scheduled_at;

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.tenant_entitlements_check(
  p_capability text,
  p_requested integer DEFAULT 1,
  p_tenant_id uuid DEFAULT NULL
)
RETURNS TABLE (
  capability text,
  allowed boolean,
  reason text,
  hard_limit integer,
  soft_limit integer,
  current_usage integer,
  requested integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := COALESCE(p_tenant_id, public.get_user_tenant_id());
  v_plan text := 'starter';
  v_capability text := lower(trim(COALESCE(p_capability, '')));
  v_requested integer := GREATEST(1, COALESCE(p_requested, 1));
  v_hard integer;
  v_soft integer;
  v_usage integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  SELECT COALESCE(t.plan, 'starter')
  INTO v_plan
  FROM public.tenants t
  WHERE t.id = v_tenant_id;

  SELECT te.hard_limit, te.soft_limit, te.current_usage
  INTO v_hard, v_soft, v_usage
  FROM public.tenant_entitlements te
  WHERE te.tenant_id = v_tenant_id
    AND te.capability = v_capability;

  IF v_hard IS NULL THEN
    v_hard := CASE v_capability
      WHEN 'connections' THEN CASE v_plan WHEN 'starter' THEN 1 WHEN 'pro' THEN 5 WHEN 'business' THEN 25 ELSE -1 END
      WHEN 'users' THEN CASE v_plan WHEN 'starter' THEN 5 WHEN 'pro' THEN 25 WHEN 'business' THEN 100 ELSE -1 END
      WHEN 'agents' THEN CASE v_plan WHEN 'starter' THEN 3 WHEN 'pro' THEN 10 WHEN 'business' THEN 25 ELSE -1 END
      WHEN 'tokens_monthly' THEN CASE v_plan WHEN 'starter' THEN 500000 WHEN 'pro' THEN 5000000 WHEN 'business' THEN 25000000 ELSE -1 END
      WHEN 'storage_gb' THEN CASE v_plan WHEN 'starter' THEN 1 WHEN 'pro' THEN 10 WHEN 'business' THEN 50 ELSE -1 END
      ELSE -1
    END;
  END IF;

  IF v_usage = 0 THEN
    v_usage := CASE v_capability
      WHEN 'connections' THEN (
        SELECT COUNT(*)::integer FROM public.api_connections c
        WHERE c.tenant_id = v_tenant_id
          AND c.is_archived = false
      )
      WHEN 'users' THEN (
        SELECT COUNT(*)::integer FROM public.profiles p
        WHERE p.tenant_id = v_tenant_id
      )
      WHEN 'agents' THEN (
        SELECT COUNT(*)::integer FROM public.ai_agents a
        WHERE a.tenant_id = v_tenant_id
          AND a.status <> 'disabled'
      )
      WHEN 'tokens_monthly' THEN (
        SELECT COALESCE(SUM(u.quantity), 0)::integer
        FROM public.usage_events u
        WHERE u.tenant_id = v_tenant_id
          AND u.metric_type = 'tokens'
          AND u.recorded_at >= date_trunc('month', now())
      )
      ELSE COALESCE(v_usage, 0)
    END;
  END IF;

  capability := v_capability;
  hard_limit := v_hard;
  soft_limit := v_soft;
  current_usage := COALESCE(v_usage, 0);
  requested := v_requested;

  IF v_hard = -1 OR v_hard IS NULL THEN
    allowed := true;
    reason := 'Unlimited by plan';
  ELSIF (v_usage + v_requested) <= v_hard THEN
    allowed := true;
    reason := 'Within plan limit';
  ELSE
    allowed := false;
    reason := format('Plan limit exceeded for %s', v_capability);
  END IF;

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.evaluate_action_policy(
  p_resource text,
  p_action text,
  p_risk_level text DEFAULT 'low',
  p_requires_write boolean DEFAULT false
)
RETURNS TABLE (
  allow boolean,
  approval_required boolean,
  reason text,
  matched_rule jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role text := 'viewer';
  v_risk text := lower(trim(COALESCE(p_risk_level, 'low')));
  v_has_raci boolean := false;
  v_blocked_by_guardrail boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  SELECT COALESCE(p.role, 'viewer')
  INTO v_role
  FROM public.profiles p
  WHERE p.id = auth.uid();

  SELECT EXISTS (
    SELECT 1
    FROM public.raci_matrix rm
    WHERE rm.tenant_id = v_tenant_id
      AND lower(rm.resource) = lower(trim(COALESCE(p_resource, '')))
      AND lower(rm.action) = lower(trim(COALESCE(p_action, '')))
      AND lower(rm.role_name) = lower(v_role)
      AND rm.raci_type IN ('R', 'A')
  ) INTO v_has_raci;

  SELECT EXISTS (
    SELECT 1
    FROM public.guardrails g
    WHERE g.tenant_id = v_tenant_id
      AND g.enabled = true
      AND (
        lower(g.risk_level) = 'critical'
        OR (lower(g.risk_level) = 'high' AND v_risk IN ('high', 'critical'))
      )
      AND (
        COALESCE((g.config -> 'blocked_actions') ? lower(trim(COALESCE(p_action, ''))), false)
        OR COALESCE((g.config -> 'blocked_resources') ? lower(trim(COALESCE(p_resource, ''))), false)
      )
  ) INTO v_blocked_by_guardrail;

  approval_required := p_requires_write OR v_risk IN ('high', 'critical');

  IF v_blocked_by_guardrail THEN
    allow := false;
    reason := 'Blocked by guardrail policy';
  ELSIF v_has_raci THEN
    allow := true;
    reason := 'Allowed by RACI assignment';
  ELSIF NOT p_requires_write AND v_risk IN ('low', 'medium') THEN
    allow := true;
    reason := 'Read-safe action allowed';
  ELSE
    allow := false;
    reason := 'No matching RACI assignment';
  END IF;

  matched_rule := jsonb_build_object(
    'role', v_role,
    'resource', lower(trim(COALESCE(p_resource, ''))),
    'action', lower(trim(COALESCE(p_action, ''))),
    'risk', v_risk,
    'guardrail_block', v_blocked_by_guardrail,
    'raci_match', v_has_raci
  );

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.regenerate_agents_for_tenant(
  p_tenant_id uuid DEFAULT NULL,
  p_force boolean DEFAULT false
)
RETURNS TABLE (
  seeded integer,
  updated integer,
  tenant_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := COALESCE(p_tenant_id, public.get_user_tenant_id());
  v_seeded integer := 0;
  v_updated integer := 0;
  v_has_active_connections boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  v_seeded := public.seed_agents_for_tenant(v_tenant_id);

  SELECT EXISTS (
    SELECT 1
    FROM public.api_connections c
    WHERE c.tenant_id = v_tenant_id
      AND c.status IN ('active', 'syncing')
      AND c.is_archived = false
  ) INTO v_has_active_connections;

  UPDATE public.ai_agents a
  SET
    status = CASE
      WHEN v_has_active_connections THEN 'ready'
      WHEN p_force THEN 'draft'
      ELSE a.status
    END,
    lifecycle_reason = CASE
      WHEN v_has_active_connections THEN 'schema_discovery'
      WHEN p_force THEN 'no_active_connections'
      ELSE a.lifecycle_reason
    END,
    last_regenerated_at = now(),
    updated_at = now()
  WHERE a.tenant_id = v_tenant_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  seeded := v_seeded;
  updated := v_updated;
  tenant_id := v_tenant_id;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_billing_state(
  p_tenant_id uuid
)
RETURNS TABLE (
  tenant_id uuid,
  tenant_status text,
  subscription_status text,
  plan text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub_status text := 'trialing';
  v_plan text := 'starter';
  v_tenant_status text := 'trial';
BEGIN
  SELECT COALESCE(s.status, 'trialing'), COALESCE(s.plan, 'starter')
  INTO v_sub_status, v_plan
  FROM public.subscriptions s
  WHERE s.tenant_id = p_tenant_id;

  v_tenant_status := CASE
    WHEN v_sub_status IN ('active', 'trialing') THEN 'active'
    WHEN v_sub_status IN ('past_due', 'unpaid') THEN 'past_due'
    WHEN v_sub_status IN ('cancelled', 'paused') THEN 'suspended'
    ELSE 'trial'
  END;

  UPDATE public.tenants t
  SET
    status = v_tenant_status,
    plan = v_plan,
    updated_at = now()
  WHERE t.id = p_tenant_id;

  tenant_id := p_tenant_id;
  tenant_status := v_tenant_status;
  subscription_status := v_sub_status;
  plan := v_plan;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_platform_admin_metrics()
RETURNS TABLE (
  total_tenants integer,
  active_tenants integer,
  total_connections integer,
  queued_connector_jobs integer,
  running_connector_jobs integer,
  pending_embedding_jobs integer,
  monthly_usage_events integer,
  open_approvals integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.platform_admin_users pa
    WHERE pa.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Forbidden: platform admin access required';
  END IF;

  RETURN QUERY
  WITH tenant_stats AS (
    SELECT
      COUNT(*)::integer AS total_tenants,
      COUNT(*) FILTER (WHERE t.status IN ('active', 'trial'))::integer AS active_tenants
    FROM public.tenants t
  ),
  conn_stats AS (
    SELECT COUNT(*)::integer AS total_connections
    FROM public.api_connections c
    WHERE c.is_archived = false
  ),
  job_stats AS (
    SELECT
      COUNT(*) FILTER (WHERE j.status = 'queued')::integer AS queued_connector_jobs,
      COUNT(*) FILTER (WHERE j.status = 'running')::integer AS running_connector_jobs
    FROM public.connector_jobs j
  ),
  embed_stats AS (
    SELECT COUNT(*) FILTER (WHERE e.status IN ('queued', 'running'))::integer AS pending_embedding_jobs
    FROM public.embedding_jobs e
  ),
  usage_stats AS (
    SELECT COUNT(*)::integer AS monthly_usage_events
    FROM public.usage_events u
    WHERE u.recorded_at >= date_trunc('month', now())
  ),
  approval_stats AS (
    SELECT COUNT(*) FILTER (WHERE a.status = 'pending')::integer AS open_approvals
    FROM public.approval_requests a
  )
  SELECT
    tenant_stats.total_tenants,
    tenant_stats.active_tenants,
    conn_stats.total_connections,
    job_stats.queued_connector_jobs,
    job_stats.running_connector_jobs,
    embed_stats.pending_embedding_jobs,
    usage_stats.monthly_usage_events,
    approval_stats.open_approvals
  FROM tenant_stats, conn_stats, job_stats, embed_stats, usage_stats, approval_stats;
END;
$$;

CREATE OR REPLACE FUNCTION public.search_knowledge_documents_hybrid(
  p_query text,
  p_query_embedding vector(1536) DEFAULT NULL,
  p_limit int DEFAULT 5,
  p_vector_weight numeric DEFAULT 0.65,
  p_lexical_weight numeric DEFAULT 0.35
)
RETURNS TABLE (
  id uuid,
  title text,
  file_type text,
  source_type text,
  external_url text,
  storage_path text,
  excerpt text,
  relevance int,
  score_breakdown jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH params AS (
    SELECT
      public.get_user_tenant_id() AS tenant_id,
      NULLIF(trim(COALESCE(p_query, '')), '') AS q,
      GREATEST(1, LEAST(COALESCE(p_limit, 5), 20)) AS lim,
      LEAST(1, GREATEST(0, COALESCE(p_vector_weight, 0.65))) AS vector_w,
      LEAST(1, GREATEST(0, COALESCE(p_lexical_weight, 0.35))) AS lexical_w
  ),
  q_ctx AS (
    SELECT
      p.tenant_id,
      p.q,
      p.lim,
      p.vector_w,
      p.lexical_w,
      CASE WHEN p.q IS NULL THEN NULL ELSE plainto_tsquery('simple', p.q) END AS tsq
    FROM params p
  ),
  docs AS (
    SELECT
      kd.id,
      kd.tenant_id,
      kd.title,
      kd.file_type,
      kd.source_type,
      kd.external_url,
      kd.storage_path,
      kd.excerpt,
      kd.created_at
    FROM public.knowledge_documents kd
    JOIN q_ctx qc ON qc.tenant_id = kd.tenant_id
    WHERE kd.status = 'indexed'
  ),
  scored AS (
    SELECT
      d.id,
      d.title,
      d.file_type,
      d.source_type,
      d.external_url,
      d.storage_path,
      d.created_at,
      COALESCE(kdc.chunk_index, 0) AS chunk_index,
      COALESCE(NULLIF(trim(kdc.content), ''), NULLIF(trim(d.excerpt), ''), d.title, 'No indexed snippet available yet.') AS candidate_excerpt,
      CASE
        WHEN qc.q IS NULL THEN 0.5::numeric
        ELSE GREATEST(
          COALESCE(ts_rank_cd(kdc.content_tsv, qc.tsq), 0),
          COALESCE(similarity(lower(COALESCE(kdc.content, d.excerpt, d.title)), lower(qc.q)), 0)
        )
      END AS lexical_score,
      CASE
        WHEN p_query_embedding IS NULL OR kdc.embedding IS NULL THEN 0::numeric
        ELSE (1 - (kdc.embedding <=> p_query_embedding))::numeric
      END AS vector_score,
      qc.vector_w,
      qc.lexical_w,
      CASE
        WHEN qc.q IS NULL THEN true
        ELSE (
          lower(d.title) LIKE '%' || lower(qc.q) || '%'
          OR COALESCE(kdc.content_tsv @@ qc.tsq, false)
          OR COALESCE(similarity(lower(COALESCE(kdc.content, d.excerpt, d.title)), lower(qc.q)), 0) > 0.07
        )
      END AS is_match
    FROM docs d
    JOIN q_ctx qc ON true
    LEFT JOIN public.knowledge_document_chunks kdc
      ON kdc.document_id = d.id
     AND kdc.tenant_id = d.tenant_id
  ),
  ranked AS (
    SELECT
      s.*,
      (COALESCE(s.vector_score, 0) * s.vector_w + COALESCE(s.lexical_score, 0) * s.lexical_w) AS hybrid_score,
      ROW_NUMBER() OVER (
        PARTITION BY s.id
        ORDER BY
          (COALESCE(s.vector_score, 0) * s.vector_w + COALESCE(s.lexical_score, 0) * s.lexical_w) DESC,
          s.chunk_index ASC
      ) AS rn
    FROM scored s
    WHERE s.is_match
  )
  SELECT
    r.id,
    r.title,
    r.file_type,
    r.source_type,
    r.external_url,
    r.storage_path,
    LEFT(regexp_replace(r.candidate_excerpt, '\\s+', ' ', 'g'), 420) AS excerpt,
    LEAST(100, GREATEST(0, ROUND(r.hybrid_score * 100)::int)) AS relevance,
    jsonb_build_object(
      'hybrid', ROUND(r.hybrid_score::numeric, 6),
      'vector', ROUND(COALESCE(r.vector_score, 0)::numeric, 6),
      'lexical', ROUND(COALESCE(r.lexical_score, 0)::numeric, 6),
      'weights', jsonb_build_object('vector', r.vector_w, 'lexical', r.lexical_w)
    ) AS score_breakdown
  FROM ranked r
  WHERE r.rn = 1
  ORDER BY r.hybrid_score DESC, r.created_at DESC
  LIMIT (SELECT lim FROM q_ctx LIMIT 1);
$$;

GRANT EXECUTE ON FUNCTION public.enqueue_connector_sync(uuid, text, text, integer, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_embedding_job(text, uuid, integer, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_entitlements_check(text, integer, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_action_policy(text, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.regenerate_agents_for_tenant(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_billing_state(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_platform_admin_metrics() TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_knowledge_documents_hybrid(text, vector, int, numeric, numeric) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'connector_jobs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.connector_jobs;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'embedding_jobs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.embedding_jobs;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'agent_action_runs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_action_runs;
  END IF;
END
$$;
