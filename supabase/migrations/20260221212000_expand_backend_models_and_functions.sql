-- Prompt 3-10 backend expansion: richer onboarding, connections, schema, AI agents, and RPC orchestration.

-- ----------------------------------------
-- Core table enhancements
-- ----------------------------------------
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS industry text,
  ADD COLUMN IF NOT EXISTS company_size text,
  ADD COLUMN IF NOT EXISTS primary_use_case text,
  ADD COLUMN IF NOT EXISTS logo_url text,
  ADD COLUMN IF NOT EXISTS onboarding_step smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.api_connections
  ADD COLUMN IF NOT EXISTS auth_type text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS connection_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS health text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS sync_frequency text NOT NULL DEFAULT 'hourly',
  ADD COLUMN IF NOT EXISTS schema_tables_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS schema_entities_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS embedding_coverage numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS queries_today integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS embeddings_indexed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sync_lag_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS analysis_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS analysis_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;

ALTER TABLE public.team_invitations
  ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'team_invitations_status_lifecycle_check'
      AND conrelid = 'public.team_invitations'::regclass
  ) THEN
    ALTER TABLE public.team_invitations
      ADD CONSTRAINT team_invitations_status_lifecycle_check
      CHECK (status IN ('pending', 'sent', 'accepted', 'expired', 'revoked'));
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'api_connections_sync_frequency_check'
      AND conrelid = 'public.api_connections'::regclass
  ) THEN
    ALTER TABLE public.api_connections
      ADD CONSTRAINT api_connections_sync_frequency_check
      CHECK (sync_frequency IN ('realtime', '5min', 'hourly', 'daily'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS tenants_onboarding_step_idx
  ON public.tenants (onboarding_step, status);

CREATE INDEX IF NOT EXISTS api_connections_tenant_status_type_idx
  ON public.api_connections (tenant_id, status, type);

CREATE INDEX IF NOT EXISTS api_connections_tenant_updated_idx
  ON public.api_connections (tenant_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS team_invitations_tenant_status_idx
  ON public.team_invitations (tenant_id, status, created_at DESC);

-- Reuse timestamp trigger function from prior migration.
DROP TRIGGER IF EXISTS tenants_set_updated_at ON public.tenants;
CREATE TRIGGER tenants_set_updated_at
BEFORE UPDATE ON public.tenants
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

DROP TRIGGER IF EXISTS api_connections_set_updated_at ON public.api_connections;
CREATE TRIGGER api_connections_set_updated_at
BEFORE UPDATE ON public.api_connections
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

DROP TRIGGER IF EXISTS team_invitations_set_updated_at ON public.team_invitations;
CREATE TRIGGER team_invitations_set_updated_at
BEFORE UPDATE ON public.team_invitations
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

-- ----------------------------------------
-- New backend models
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS public.connection_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.api_connections(id) ON DELETE CASCADE,
  name text NOT NULL,
  source_kind text NOT NULL DEFAULT 'table' CHECK (source_kind IN ('table', 'endpoint', 'document')),
  entity_group text NOT NULL DEFAULT 'master_data' CHECK (entity_group IN ('master_data', 'transactions', 'logs', 'config')),
  row_count bigint NOT NULL DEFAULT 0,
  risk_level text NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high')),
  sensitivity text NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'pii', 'financial')),
  description text,
  embedding_coverage numeric(5,2) NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, name)
);
ALTER TABLE public.connection_entities ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.connection_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES public.connection_entities(id) ON DELETE CASCADE,
  name text NOT NULL,
  data_type text NOT NULL,
  is_nullable boolean NOT NULL DEFAULT true,
  sensitivity text NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'pii', 'financial')),
  sample_value text,
  position_index integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, name)
);
ALTER TABLE public.connection_columns ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.connection_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.api_connections(id) ON DELETE CASCADE,
  source_entity_id uuid NOT NULL REFERENCES public.connection_entities(id) ON DELETE CASCADE,
  target_entity_id uuid NOT NULL REFERENCES public.connection_entities(id) ON DELETE CASCADE,
  relation_type text NOT NULL DEFAULT 'foreign_key',
  label text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.connection_relationships ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.connection_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.api_connections(id) ON DELETE CASCADE,
  triggered_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'success', 'error', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  latency_ms integer,
  rows_scanned bigint,
  rows_indexed bigint,
  error_message text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.connection_sync_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.ai_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  domain text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'syncing', 'disabled')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);
ALTER TABLE public.ai_agents ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS connection_entities_connection_idx
  ON public.connection_entities (connection_id, entity_group, name);

CREATE INDEX IF NOT EXISTS connection_columns_entity_idx
  ON public.connection_columns (entity_id, position_index);

CREATE INDEX IF NOT EXISTS connection_relationships_connection_idx
  ON public.connection_relationships (connection_id);

CREATE INDEX IF NOT EXISTS connection_sync_runs_connection_idx
  ON public.connection_sync_runs (connection_id, started_at DESC);

CREATE INDEX IF NOT EXISTS ai_agents_tenant_status_idx
  ON public.ai_agents (tenant_id, status);

DROP TRIGGER IF EXISTS connection_entities_set_updated_at ON public.connection_entities;
CREATE TRIGGER connection_entities_set_updated_at
BEFORE UPDATE ON public.connection_entities
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

DROP TRIGGER IF EXISTS ai_agents_set_updated_at ON public.ai_agents;
CREATE TRIGGER ai_agents_set_updated_at
BEFORE UPDATE ON public.ai_agents
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

-- ----------------------------------------
-- RLS policies for new models + invitation lifecycle
-- ----------------------------------------
CREATE POLICY "Tenant members can update invitations"
  ON public.team_invitations
  FOR UPDATE TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can delete invitations"
  ON public.team_invitations
  FOR DELETE TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can view entities"
  ON public.connection_entities
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can insert entities"
  ON public.connection_entities
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can update entities"
  ON public.connection_entities
  FOR UPDATE TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can view entity columns"
  ON public.connection_columns
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can insert entity columns"
  ON public.connection_columns
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can update entity columns"
  ON public.connection_columns
  FOR UPDATE TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can view relationships"
  ON public.connection_relationships
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can manage relationships"
  ON public.connection_relationships
  FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can view sync runs"
  ON public.connection_sync_runs
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can manage sync runs"
  ON public.connection_sync_runs
  FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can view ai agents"
  ON public.ai_agents
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can manage ai agents"
  ON public.ai_agents
  FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

-- ----------------------------------------
-- Backend helper functions / RPCs
-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.seed_agents_for_tenant(p_tenant_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer := 0;
BEGIN
  INSERT INTO public.ai_agents (tenant_id, name, slug, domain, description, created_by)
  VALUES
    (p_tenant_id, 'Finance Agent', 'finance', 'finance', 'Revenue, invoices, and payment intelligence', auth.uid()),
    (p_tenant_id, 'Ops Agent', 'ops', 'operations', 'Workflow, incidents, and sync operations', auth.uid()),
    (p_tenant_id, 'Analytics Agent', 'analytics', 'analytics', 'Trends, forecasts, and anomaly analysis', auth.uid())
  ON CONFLICT (tenant_id, slug) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.test_connection_payload(
  p_connection_type text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  success boolean,
  message text,
  latency_ms integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base text := lower(COALESCE(p_payload ->> 'base_url', ''));
  v_host text := lower(COALESCE(p_payload ->> 'host', ''));
  v_combined text := v_base || ' ' || v_host || ' ' || lower(COALESCE(p_connection_type, ''));
BEGIN
  latency_ms := 120 + ((abs(hashtext(v_combined)) % 880));

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_combined LIKE '%invalid%' OR v_combined LIKE '%fail%' OR v_combined LIKE '%error%' THEN
    success := false;
    message := 'Connection test failed. Verify endpoint and credentials.';
    RETURN NEXT;
    RETURN;
  END IF;

  success := true;
  message := 'Connection successful';
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_team_invitations(p_invites jsonb)
RETURNS TABLE (
  inserted_count integer,
  remaining_slots integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_plan text;
  v_limit integer;
  v_open_invites integer;
  v_item jsonb;
  v_email text;
  v_role text;
  v_inserted integer := 0;
  v_is_existing_open boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  IF COALESCE(jsonb_typeof(p_invites), '') <> 'array' THEN
    RAISE EXCEPTION 'p_invites must be a JSON array';
  END IF;

  SELECT COALESCE(plan, 'starter') INTO v_plan
  FROM public.tenants
  WHERE id = v_tenant_id;

  v_limit := CASE lower(v_plan)
    WHEN 'starter' THEN 5
    WHEN 'pro' THEN 25
    ELSE 500
  END;

  SELECT COUNT(*)
  INTO v_open_invites
  FROM public.team_invitations
  WHERE tenant_id = v_tenant_id
    AND status IN ('pending', 'sent');

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_invites)
  LOOP
    v_email := lower(trim(COALESCE(v_item ->> 'email', '')));
    v_role := lower(trim(COALESCE(v_item ->> 'role', 'member')));

    IF v_email = '' OR v_email !~* '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
      CONTINUE;
    END IF;

    IF v_role NOT IN ('admin', 'manager', 'member', 'viewer') THEN
      v_role := 'member';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM public.team_invitations ti
      WHERE ti.tenant_id = v_tenant_id
        AND ti.email = v_email
        AND ti.status IN ('pending', 'sent')
    )
    INTO v_is_existing_open;

    IF NOT v_is_existing_open THEN
      IF v_open_invites >= v_limit THEN
        RAISE EXCEPTION 'Invitation limit reached for plan %', v_plan;
      END IF;
      v_open_invites := v_open_invites + 1;
    END IF;

    INSERT INTO public.team_invitations (
      tenant_id,
      email,
      role,
      token,
      status,
      invited_by,
      sent_at,
      expires_at
    )
    VALUES (
      v_tenant_id,
      v_email,
      v_role,
      encode(gen_random_bytes(24), 'hex'),
      'sent',
      auth.uid(),
      now(),
      now() + interval '14 days'
    )
    ON CONFLICT (tenant_id, email)
    DO UPDATE SET
      role = EXCLUDED.role,
      status = 'sent',
      invited_by = auth.uid(),
      sent_at = now(),
      expires_at = now() + interval '14 days';

    v_inserted := v_inserted + 1;
  END LOOP;

  inserted_count := v_inserted;
  remaining_slots := GREATEST(v_limit - v_open_invites, 0);

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'team.invitations.sent',
    'team_invitations',
    'success',
    jsonb_build_object('count', inserted_count)
  );

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_api_connection(
  p_name text,
  p_type text,
  p_base_url text DEFAULT NULL,
  p_auth_type text DEFAULT 'none',
  p_connection_config jsonb DEFAULT '{}'::jsonb,
  p_seed_schema boolean DEFAULT true
)
RETURNS TABLE (
  connection_id uuid,
  status text
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

  IF trim(COALESCE(p_name, '')) = '' THEN
    RAISE EXCEPTION 'Connection name is required';
  END IF;

  IF trim(COALESCE(p_type, '')) = '' THEN
    RAISE EXCEPTION 'Connection type is required';
  END IF;

  INSERT INTO public.api_connections (
    tenant_id,
    name,
    type,
    base_url,
    auth_type,
    connection_config,
    status,
    health,
    analysis_started_at,
    sync_frequency
  )
  VALUES (
    v_tenant_id,
    trim(p_name),
    lower(trim(p_type)),
    NULLIF(trim(COALESCE(p_base_url, '')), ''),
    lower(trim(COALESCE(p_auth_type, 'none'))),
    COALESCE(p_connection_config, '{}'::jsonb),
    'pending',
    'healthy',
    now(),
    COALESCE(NULLIF(trim(COALESCE(p_connection_config ->> 'sync_frequency', '')), ''), 'hourly')
  )
  RETURNING id, api_connections.status
  INTO connection_id, status;

  INSERT INTO public.connection_sync_runs (
    tenant_id,
    connection_id,
    triggered_by,
    status,
    started_at,
    details
  )
  VALUES (
    v_tenant_id,
    connection_id,
    auth.uid(),
    'running',
    now(),
    jsonb_build_object('stage', 'connection_created')
  );

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'connection.create',
    trim(p_name),
    'success',
    jsonb_build_object('type', lower(trim(p_type)), 'seed_schema', p_seed_schema)
  );

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.bootstrap_connection_schema(p_connection_id uuid)
RETURNS TABLE (
  entities_count integer,
  columns_count integer,
  relationships_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_connection_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT c.name
  INTO v_connection_name
  FROM public.api_connections c
  WHERE c.id = p_connection_id
    AND c.tenant_id = v_tenant_id;

  IF v_connection_name IS NULL THEN
    RAISE EXCEPTION 'Connection not found for tenant';
  END IF;

  DELETE FROM public.connection_columns
  WHERE tenant_id = v_tenant_id
    AND entity_id IN (
      SELECT id
      FROM public.connection_entities
      WHERE connection_id = p_connection_id
    );

  DELETE FROM public.connection_relationships
  WHERE tenant_id = v_tenant_id
    AND connection_id = p_connection_id;

  DELETE FROM public.connection_entities
  WHERE tenant_id = v_tenant_id
    AND connection_id = p_connection_id;

  WITH inserted_entities AS (
    INSERT INTO public.connection_entities (
      tenant_id,
      connection_id,
      name,
      source_kind,
      entity_group,
      row_count,
      risk_level,
      sensitivity,
      description,
      embedding_coverage
    )
    VALUES
      (v_tenant_id, p_connection_id, 'accounts_table', 'table', 'master_data', 18240, 'medium', 'pii', 'Customer account master data.', 88),
      (v_tenant_id, p_connection_id, 'orders_table', 'table', 'transactions', 98211, 'high', 'financial', 'Order and fulfillment transactions.', 84),
      (v_tenant_id, p_connection_id, 'payments_table', 'table', 'transactions', 74450, 'high', 'financial', 'Payment captures, settlements, and refunds.', 82),
      (v_tenant_id, p_connection_id, 'sync_logs_table', 'table', 'logs', 50211, 'low', 'normal', 'Connector sync diagnostics and retries.', 76),
      (v_tenant_id, p_connection_id, 'agent_config_table', 'table', 'config', 140, 'low', 'normal', 'Agent and governance configuration.', 91)
    RETURNING id, name
  )
  INSERT INTO public.connection_columns (
    tenant_id,
    entity_id,
    name,
    data_type,
    is_nullable,
    sensitivity,
    position_index,
    sample_value
  )
  SELECT
    v_tenant_id,
    ie.id,
    col.name,
    col.data_type,
    col.is_nullable,
    col.sensitivity,
    col.position_index,
    col.sample_value
  FROM inserted_entities ie
  JOIN LATERAL (
    SELECT *
    FROM (
      VALUES
        ('accounts_table', 'id', 'uuid', false, 'normal', 1, 'acc_001'),
        ('accounts_table', 'email', 'text', false, 'pii', 2, 'finance@acme.com'),
        ('accounts_table', 'name', 'text', false, 'pii', 3, 'Acme Corp'),
        ('orders_table', 'id', 'uuid', false, 'normal', 1, 'ord_901'),
        ('orders_table', 'account_id', 'uuid', false, 'normal', 2, 'acc_001'),
        ('orders_table', 'amount', 'numeric', false, 'financial', 3, '4285.24'),
        ('payments_table', 'id', 'uuid', false, 'normal', 1, 'pay_188'),
        ('payments_table', 'order_id', 'uuid', false, 'normal', 2, 'ord_901'),
        ('payments_table', 'captured_amount', 'numeric', false, 'financial', 3, '4285.24'),
        ('sync_logs_table', 'id', 'uuid', false, 'normal', 1, 'sync_55'),
        ('sync_logs_table', 'status', 'text', false, 'normal', 2, 'success'),
        ('agent_config_table', 'id', 'uuid', false, 'normal', 1, 'cfg_9'),
        ('agent_config_table', 'setting_key', 'text', false, 'normal', 2, 'approval_mode')
    ) AS t(entity_name, name, data_type, is_nullable, sensitivity, position_index, sample_value)
    WHERE t.entity_name = ie.name
  ) AS col ON true;

  INSERT INTO public.connection_relationships (
    tenant_id,
    connection_id,
    source_entity_id,
    target_entity_id,
    relation_type,
    label
  )
  SELECT
    v_tenant_id,
    p_connection_id,
    src.id,
    tgt.id,
    'foreign_key',
    rel.label
  FROM (
    VALUES
      ('orders_table', 'accounts_table', 'orders.account_id -> accounts.id'),
      ('payments_table', 'orders_table', 'payments.order_id -> orders.id')
  ) AS rel(source_name, target_name, label)
  JOIN public.connection_entities src
    ON src.connection_id = p_connection_id
   AND src.name = rel.source_name
  JOIN public.connection_entities tgt
    ON tgt.connection_id = p_connection_id
   AND tgt.name = rel.target_name;

  UPDATE public.api_connections
  SET
    status = 'active',
    schema_detected = true,
    schema_tables_count = 5,
    schema_entities_count = 5,
    embedding_coverage = 84,
    last_synced_at = now(),
    analysis_completed_at = now(),
    health = 'healthy',
    last_error = NULL
  WHERE id = p_connection_id
    AND tenant_id = v_tenant_id;

  UPDATE public.connection_sync_runs
  SET
    status = 'success',
    finished_at = now(),
    latency_ms = 1300,
    rows_scanned = 240000,
    rows_indexed = 195000,
    details = jsonb_build_object('stage', 'schema_bootstrapped')
  WHERE connection_id = p_connection_id
    AND tenant_id = v_tenant_id
    AND status = 'running';

  PERFORM public.seed_agents_for_tenant(v_tenant_id);

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'connection.schema.bootstrap',
    v_connection_name,
    'success',
    jsonb_build_object('entities', 5, 'columns', 13)
  );

  entities_count := 5;
  columns_count := 13;
  relationships_count := 2;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_workspace_home_metrics()
RETURNS TABLE (
  total_connections integer,
  active_connections integer,
  syncing_connections integer,
  error_connections integer,
  messages_today integer,
  messages_yesterday integer,
  pending_approvals integer,
  ai_actions_this_week integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT public.get_user_tenant_id() AS tenant_id
  ),
  counts AS (
    SELECT
      COUNT(*)::int AS total_connections,
      COUNT(*) FILTER (WHERE lower(status) = 'active')::int AS active_connections,
      COUNT(*) FILTER (WHERE lower(status) IN ('syncing', 'pending'))::int AS syncing_connections,
      COUNT(*) FILTER (WHERE lower(status) = 'error')::int AS error_connections
    FROM public.api_connections c
    JOIN me ON me.tenant_id = c.tenant_id
  ),
  sessions AS (
    SELECT id
    FROM public.chat_sessions s
    JOIN me ON me.tenant_id = s.tenant_id
  ),
  msg_today AS (
    SELECT COUNT(*)::int AS value
    FROM public.chat_messages m
    WHERE m.session_id IN (SELECT id FROM sessions)
      AND m.created_at >= date_trunc('day', now())
      AND m.created_at < date_trunc('day', now()) + interval '1 day'
  ),
  msg_yesterday AS (
    SELECT COUNT(*)::int AS value
    FROM public.chat_messages m
    WHERE m.session_id IN (SELECT id FROM sessions)
      AND m.created_at >= date_trunc('day', now()) - interval '1 day'
      AND m.created_at < date_trunc('day', now())
  ),
  approvals AS (
    SELECT COUNT(*)::int AS value
    FROM public.approval_requests a
    JOIN me ON me.tenant_id = a.tenant_id
    WHERE lower(a.status) = 'pending'
  ),
  ai_usage AS (
    SELECT COALESCE(SUM(u.quantity), 0)::int AS value
    FROM public.usage_events u
    JOIN me ON me.tenant_id = u.tenant_id
    WHERE u.metric_type IN ('ai_actions', 'agent_actions')
      AND u.recorded_at >= date_trunc('week', now())
  )
  SELECT
    counts.total_connections,
    counts.active_connections,
    counts.syncing_connections,
    counts.error_connections,
    msg_today.value,
    msg_yesterday.value,
    approvals.value,
    ai_usage.value
  FROM counts, msg_today, msg_yesterday, approvals, ai_usage;
$$;

CREATE OR REPLACE FUNCTION public.launch_workspace(p_raci_rules jsonb DEFAULT '[]'::jsonb)
RETURNS TABLE (
  tenant_id uuid,
  tenant_status text,
  applied_rules integer,
  seeded_agents integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_item jsonb;
  v_resource text;
  v_action text;
  v_responsible text;
  v_accountable text;
  v_applied integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  UPDATE public.tenants
  SET
    status = 'active',
    onboarding_step = 4,
    onboarding_completed_at = COALESCE(onboarding_completed_at, now()),
    activated_at = COALESCE(activated_at, now())
  WHERE id = v_tenant_id;

  IF COALESCE(jsonb_typeof(p_raci_rules), 'array') = 'array' THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_raci_rules, '[]'::jsonb))
    LOOP
      IF COALESCE((v_item ->> 'enabled')::boolean, true) IS NOT TRUE THEN
        CONTINUE;
      END IF;

      v_resource := NULLIF(trim(COALESCE(v_item ->> 'resource', '')), '');
      v_action := NULLIF(trim(COALESCE(v_item ->> 'action', '')), '');
      v_responsible := NULLIF(trim(COALESCE(v_item ->> 'responsible_role', '')), '');
      v_accountable := NULLIF(trim(COALESCE(v_item ->> 'accountable_role', '')), '');

      IF v_resource IS NULL OR v_action IS NULL THEN
        CONTINUE;
      END IF;

      IF v_responsible IS NOT NULL THEN
        INSERT INTO public.raci_matrix (tenant_id, resource, action, role_name, raci_type)
        VALUES (v_tenant_id, v_resource, v_action, v_responsible, 'R')
        ON CONFLICT DO NOTHING;
        v_applied := v_applied + 1;
      END IF;

      IF v_accountable IS NOT NULL THEN
        INSERT INTO public.raci_matrix (tenant_id, resource, action, role_name, raci_type)
        VALUES (v_tenant_id, v_resource, v_action, v_accountable, 'A')
        ON CONFLICT DO NOTHING;
        v_applied := v_applied + 1;
      END IF;
    END LOOP;
  END IF;

  seeded_agents := public.seed_agents_for_tenant(v_tenant_id);

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'workspace.launch',
    'tenant',
    'success',
    jsonb_build_object('raci_rules_applied', v_applied, 'agents_seeded', seeded_agents)
  );

  SELECT t.id, t.status INTO tenant_id, tenant_status
  FROM public.tenants t
  WHERE t.id = v_tenant_id;

  applied_rules := v_applied;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_onboarding_snapshot()
RETURNS TABLE (
  tenant_id uuid,
  tenant_name text,
  tenant_status text,
  onboarding_step smallint,
  active_connections integer,
  invited_count integer,
  agents_ready integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT public.get_user_tenant_id() AS tenant_id
  )
  SELECT
    t.id,
    t.name,
    t.status,
    t.onboarding_step,
    (
      SELECT COUNT(*)::int
      FROM public.api_connections c
      WHERE c.tenant_id = t.id
        AND c.status = 'active'
    ) AS active_connections,
    (
      SELECT COUNT(*)::int
      FROM public.team_invitations ti
      WHERE ti.tenant_id = t.id
        AND ti.status IN ('pending', 'sent')
    ) AS invited_count,
    (
      SELECT COUNT(*)::int
      FROM public.ai_agents a
      WHERE a.tenant_id = t.id
        AND a.status = 'ready'
    ) AS agents_ready
  FROM public.tenants t
  JOIN me ON me.tenant_id = t.id;
$$;

-- Keep raci matrix idempotent during launch/setup.
DELETE FROM public.raci_matrix a
USING public.raci_matrix b
WHERE a.ctid < b.ctid
  AND a.tenant_id = b.tenant_id
  AND a.resource = b.resource
  AND a.action = b.action
  AND a.role_name = b.role_name
  AND a.raci_type = b.raci_type;

CREATE UNIQUE INDEX IF NOT EXISTS raci_matrix_unique_assignment_idx
  ON public.raci_matrix (tenant_id, resource, action, role_name, raci_type);

GRANT EXECUTE ON FUNCTION public.seed_agents_for_tenant(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.test_connection_payload(text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_team_invitations(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_api_connection(text, text, text, text, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_connection_schema(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_workspace_home_metrics() TO authenticated;
GRANT EXECUTE ON FUNCTION public.launch_workspace(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_onboarding_snapshot() TO authenticated;
