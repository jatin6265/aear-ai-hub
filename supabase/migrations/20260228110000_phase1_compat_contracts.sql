-- Phase 1 compatibility contracts and governance hardening.
-- Purpose: provide doc-aligned contract names without renaming canonical tables.

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'vector extension not available in this environment: %', SQLERRM;
END $$;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgcrypto extension not available in this environment: %', SQLERRM;
END $$;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron extension not available in this environment: %', SQLERRM;
END $$;

-- Compatibility table for legacy embedding writers.
CREATE TABLE IF NOT EXISTS public.embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  source_kind text NOT NULL,
  source_id text,
  content text NOT NULL,
  embedding vector(1536),
  embedding_model text NOT NULL DEFAULT 'text-embedding-3-small',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_kind, source_id, content)
);

ALTER TABLE public.embeddings ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS embeddings_tenant_created_idx
  ON public.embeddings (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS embeddings_tenant_source_idx
  ON public.embeddings (tenant_id, source_kind, source_id);

CREATE INDEX IF NOT EXISTS embeddings_vector_idx
  ON public.embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

DROP POLICY IF EXISTS "Tenant members can view embeddings" ON public.embeddings;
CREATE POLICY "Tenant members can view embeddings"
  ON public.embeddings FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage embeddings" ON public.embeddings;
CREATE POLICY "Tenant members can manage embeddings"
  ON public.embeddings FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Service role can manage embeddings" ON public.embeddings;
CREATE POLICY "Service role can manage embeddings"
  ON public.embeddings FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'set_updated_at_timestamp'
      AND pg_function_is_visible(oid)
  ) THEN
    DROP TRIGGER IF EXISTS embeddings_set_updated_at ON public.embeddings;
    CREATE TRIGGER embeddings_set_updated_at
    BEFORE UPDATE ON public.embeddings
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_timestamp();
  END IF;
END $$;

-- Compatibility views (doc names mapped to canonical contracts).
CREATE OR REPLACE VIEW public.schema_entities AS
SELECT
  ce.id,
  ce.tenant_id,
  ce.connection_id,
  ce.name,
  ce.source_kind,
  ce.entity_group,
  ce.row_count,
  ce.risk_level,
  ce.sensitivity,
  ce.description,
  ce.embedding_coverage,
  ce.metadata,
  ce.created_at,
  ce.updated_at
FROM public.connection_entities ce;

CREATE OR REPLACE VIEW public.tenant_integrations AS
SELECT
  ti.id,
  ti.tenant_id,
  ti.integration_id,
  ic.code AS integration_slug,
  ic.display_name AS integration_name,
  ti.status,
  ti.config,
  ti.installed_by,
  ti.installed_at,
  ti.uninstalled_at,
  ti.last_synced_at,
  ti.created_at,
  ti.updated_at
FROM public.tenant_integration_installs ti
JOIN public.integration_catalog ic
  ON ic.id = ti.integration_id;

CREATE OR REPLACE VIEW public.credentials AS
SELECT
  ic.id,
  ic.tenant_id,
  ic.service AS integration_slug,
  ic.label,
  ic.status,
  ic.expires_at,
  ic.created_at,
  ic.updated_at,
  jsonb_build_object(
    'algorithm', ic.algorithm,
    'key_version', ic.key_version,
    'credential_ref', ic.credential_ref,
    'metadata', ic.metadata
  ) AS encrypted_data
FROM public.integration_credentials ic;

CREATE OR REPLACE VIEW public.tenant_tools AS
SELECT
  tr.id,
  tr.tenant_id,
  tr.code AS tool_code,
  tr.display_name,
  tr.category,
  tr.handler_key,
  tr.input_schema,
  tr.risk_level,
  tr.is_write_action,
  (tr.risk_level = 'critical') AS is_destructive,
  (tr.risk_level IN ('high', 'critical') OR tr.raci_required = 'A') AS requires_approval,
  tr.is_active,
  tr.created_at,
  tr.updated_at,
  NULL::uuid AS integration_id,
  false AS is_mcp
FROM public.tool_registry tr;

CREATE OR REPLACE VIEW public.risk_policies AS
SELECT
  rr.id,
  rr.tenant_id,
  rr.resource AS resource_pattern,
  rr.action AS action_pattern,
  COALESCE(rr.override_risk_level, rr.risk_level) AS default_risk,
  rr.policy AS reason,
  rr.enabled,
  rr.created_at,
  rr.updated_at
FROM public.risk_matrix_rules rr;

CREATE OR REPLACE VIEW public.subscription_plans AS
SELECT
  pp.id,
  pp.code AS name,
  pp.description AS headline,
  pp.monthly_price_cents AS price_monthly,
  pp.annual_price_cents AS price_annual,
  'usd'::text AS currency,
  pp.cta_label AS cta_text,
  pp.badge,
  pp.sort_order AS display_order,
  true AS is_active,
  pp.created_at,
  pp.updated_at,
  jsonb_build_object('source', 'pricing_plans') AS limits,
  COALESCE((
    SELECT jsonb_agg(pf.feature_text ORDER BY pf.sort_order)
    FROM public.pricing_plan_features pf
    WHERE pf.plan_code = pp.code
  ), '[]'::jsonb) AS features
FROM public.pricing_plans pp;

CREATE OR REPLACE VIEW public.roles AS
SELECT
  rr.id,
  rr.tenant_id,
  rr.name,
  rr.display_name,
  COALESCE(rr.description, '') AS description,
  false AS is_system,
  false AS is_admin,
  rr.display_order AS sort_order,
  rr.created_at,
  rr.updated_at,
  jsonb_build_object('icon', rr.icon) AS permissions
FROM public.raci_roles rr;

CREATE OR REPLACE VIEW public.role_members AS
SELECT
  rm.id,
  rm.tenant_id,
  rm.role_id,
  rm.profile_id AS user_id,
  rm.created_at
FROM public.raci_role_members rm;

CREATE OR REPLACE VIEW public.agents AS
SELECT
  a.id,
  a.tenant_id,
  a.name,
  a.slug,
  a.domain,
  a.description,
  a.status,
  COALESCE(NULLIF(a.config ->> 'model', ''), 'gpt-4.1-mini') AS model,
  COALESCE(a.config ->> 'system_prompt', '') AS system_prompt,
  a.config,
  a.created_by,
  a.created_at,
  a.updated_at
FROM public.ai_agents a;

CREATE OR REPLACE VIEW public.tools AS
SELECT
  tr.id,
  tr.tenant_id,
  tr.code,
  tr.display_name,
  tr.description,
  tr.category,
  tr.handler_key,
  tr.input_schema,
  tr.risk_level,
  tr.is_write_action,
  (tr.risk_level = 'critical') AS is_destructive,
  (tr.risk_level IN ('high', 'critical') OR tr.raci_required = 'A') AS requires_approval,
  tr.is_active,
  tr.created_at,
  tr.updated_at
FROM public.tool_registry tr;

CREATE OR REPLACE VIEW public.agent_memory AS
SELECT
  ame.id,
  ame.tenant_id,
  ame.agent_id,
  ame.memory_type,
  ame.memory_key AS key,
  ame.memory_value AS value,
  NULL::timestamptz AS expires_at,
  ame.created_at,
  ame.updated_at
FROM public.agent_memory_entries ame;

CREATE OR REPLACE VIEW public.sync_jobs AS
SELECT
  csr.id,
  csr.tenant_id,
  csr.connection_id,
  csr.status,
  csr.started_at,
  csr.finished_at,
  csr.error_message,
  csr.details,
  csr.triggered_by,
  csr.latency_ms,
  csr.rows_scanned,
  csr.rows_indexed
FROM public.connection_sync_runs csr;

CREATE OR REPLACE VIEW public.invoices AS
SELECT
  i.id,
  i.tenant_id,
  i.provider,
  i.provider_invoice_id,
  i.provider_subscription_id,
  i.currency,
  i.total_cents AS amount,
  i.invoice_status AS status,
  i.invoice_url,
  i.hosted_invoice_url,
  i.period_start,
  i.period_end,
  i.due_at,
  i.paid_at,
  i.created_at,
  i.updated_at
FROM public.invoice_snapshots i;

-- Ensure compatibility views execute with invoker RLS context.
DO $$
DECLARE
  view_name text;
BEGIN
  FOREACH view_name IN ARRAY ARRAY[
    'schema_entities',
    'tenant_integrations',
    'credentials',
    'tenant_tools',
    'risk_policies',
    'subscription_plans',
    'roles',
    'role_members',
    'agents',
    'tools',
    'agent_memory',
    'sync_jobs',
    'invoices'
  ]
  LOOP
    BEGIN
      EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', view_name);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not set security_invoker on view %: %', view_name, SQLERRM;
    END;
  END LOOP;
END $$;

GRANT SELECT ON public.schema_entities TO authenticated, service_role;
GRANT SELECT ON public.tenant_integrations TO authenticated, service_role;
GRANT SELECT ON public.credentials TO authenticated, service_role;
GRANT SELECT ON public.tenant_tools TO authenticated, service_role;
GRANT SELECT ON public.risk_policies TO authenticated, service_role;
GRANT SELECT ON public.subscription_plans TO authenticated, service_role;
GRANT SELECT ON public.roles TO authenticated, service_role;
GRANT SELECT ON public.role_members TO authenticated, service_role;
GRANT SELECT ON public.agents TO authenticated, service_role;
GRANT SELECT ON public.tools TO authenticated, service_role;
GRANT SELECT ON public.agent_memory TO authenticated, service_role;
GRANT SELECT ON public.sync_jobs TO authenticated, service_role;
GRANT SELECT ON public.invoices TO authenticated, service_role;

-- SQL audit function for Phase 1 RLS posture verification.
CREATE OR REPLACE FUNCTION public.run_phase1_rls_audit()
RETURNS TABLE (
  check_name text,
  passed boolean,
  detail text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tenant_tables_without_tid int;
  tenant_tables_without_rls int;
  tenant_tables_without_policy int;
  audit_trigger_count int;
BEGIN
  SELECT COUNT(*)
    INTO tenant_tables_without_tid
  FROM unnest(ARRAY[
    'profiles',
    'api_connections',
    'chat_sessions',
    'raci_matrix',
    'approval_requests',
    'subscriptions',
    'usage_events',
    'connection_entities',
    'connection_sync_runs',
    'ai_agents',
    'agent_runs',
    'tool_registry',
    'integration_credentials',
    'connector_jobs',
    'embedding_jobs',
    'billing_events',
    'invoice_snapshots',
    'tenant_entitlements',
    'agent_tool_runs',
    'agent_action_runs',
    'anomaly_insights',
    'raci_roles',
    'raci_role_members',
    'tenant_integration_installs',
    'context_events',
    'ingestion_queue',
    'checkout_sessions',
    'embeddings'
  ]) AS expected(table_name)
  WHERE NOT EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = expected.table_name
        AND c.column_name = 'tenant_id'
    );

  RETURN QUERY SELECT
    'tenant_column_presence'::text,
    (tenant_tables_without_tid = 0),
    format('tables_missing_tenant_id=%s', tenant_tables_without_tid);

  SELECT COUNT(*)
    INTO tenant_tables_without_rls
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT IN ('schema_migrations')
    AND c.relrowsecurity = false;

  RETURN QUERY SELECT
    'rls_enabled_on_public_tables'::text,
    (tenant_tables_without_rls = 0),
    format('tables_without_rls=%s', tenant_tables_without_rls);

  SELECT COUNT(*)
    INTO tenant_tables_without_policy
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT IN ('schema_migrations')
    AND c.relrowsecurity = true
    AND NOT EXISTS (
      SELECT 1
      FROM pg_policies p
      WHERE p.schemaname = 'public'
        AND p.tablename = c.relname
    );

  RETURN QUERY SELECT
    'rls_policy_presence'::text,
    (tenant_tables_without_policy = 0),
    format('tables_without_policies=%s', tenant_tables_without_policy);

  SELECT COUNT(*)
    INTO audit_trigger_count
  FROM pg_trigger trg
  JOIN pg_class tbl ON tbl.oid = trg.tgrelid
  JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
  WHERE ns.nspname = 'public'
    AND tbl.relname = 'audit_logs'
    AND trg.tgenabled <> 'D'
    AND trg.tgname IN ('tr_prevent_audit_log_update', 'tr_prevent_audit_log_delete');

  RETURN QUERY SELECT
    'audit_log_immutability_triggers'::text,
    (audit_trigger_count = 2),
    format('audit_log_trigger_count=%s', audit_trigger_count);
END;
$$;

GRANT EXECUTE ON FUNCTION public.run_phase1_rls_audit() TO authenticated, service_role;
