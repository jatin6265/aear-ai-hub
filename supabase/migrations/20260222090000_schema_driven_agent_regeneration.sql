-- Schema-driven agent derivation and lifecycle regeneration.

CREATE OR REPLACE FUNCTION public.derive_agent_domains(
  p_tenant_id uuid,
  p_force boolean DEFAULT false
)
RETURNS TABLE (
  domain text,
  slug text,
  name text,
  description text,
  entity_count integer,
  entity_groups text[],
  sensitivities text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scoped_entities AS (
    SELECT
      lower(trim(COALESCE(e.name, ''))) AS entity_name,
      lower(trim(COALESCE(e.entity_group, 'master_data'))) AS entity_group,
      lower(trim(COALESCE(e.sensitivity, 'normal'))) AS sensitivity
    FROM public.connection_entities e
    JOIN public.api_connections c
      ON c.id = e.connection_id
     AND c.tenant_id = e.tenant_id
    WHERE e.tenant_id = p_tenant_id
      AND c.is_archived = false
  ),
  mapped AS (
    SELECT
      CASE
        WHEN entity_name ~ '(invoice|payment|revenue|finance|ledger|billing|expense|tax|pnl|cash|budget)'
          OR sensitivity = 'financial'
          THEN 'finance'
        WHEN entity_name ~ '(customer|account|client|contact|subscriber|user|profile)'
          THEN 'customers'
        WHEN entity_name ~ '(ticket|incident|case|support|sla|helpdesk)'
          THEN 'support'
        WHEN entity_name ~ '(risk|audit|compliance|policy|guardrail|approval)'
          THEN 'risk'
        WHEN entity_group IN ('logs', 'config', 'transactions')
          THEN 'operations'
        ELSE 'analytics'
      END AS domain,
      entity_group,
      sensitivity
    FROM scoped_entities
  ),
  aggregated AS (
    SELECT
      m.domain,
      COUNT(*)::integer AS entity_count,
      array_remove(array_agg(DISTINCT m.entity_group), NULL)::text[] AS entity_groups,
      array_remove(array_agg(DISTINCT m.sensitivity), NULL)::text[] AS sensitivities
    FROM mapped m
    GROUP BY m.domain
  ),
  seeded_defaults AS (
    SELECT
      d.domain,
      0::integer AS entity_count,
      ARRAY[]::text[] AS entity_groups,
      ARRAY[]::text[] AS sensitivities
    FROM (VALUES ('finance'), ('operations'), ('analytics')) AS d(domain)
    WHERE p_force
      AND NOT EXISTS (SELECT 1 FROM aggregated)
  ),
  combined AS (
    SELECT * FROM aggregated
    UNION ALL
    SELECT * FROM seeded_defaults
  )
  SELECT
    c.domain,
    CASE
      WHEN c.domain = 'operations' THEN 'ops'
      ELSE c.domain
    END AS slug,
    CASE
      WHEN c.domain = 'operations' THEN 'Ops Agent'
      ELSE initcap(replace(c.domain, '_', ' ')) || ' Agent'
    END AS name,
    CASE
      WHEN c.domain = 'finance' THEN 'Revenue, invoices, and payment intelligence'
      WHEN c.domain = 'operations' THEN 'Workflow, incidents, and sync operations'
      WHEN c.domain = 'analytics' THEN 'Trends, forecasts, and anomaly analysis'
      WHEN c.domain = 'customers' THEN 'Customer lifecycle, retention, and account intelligence'
      WHEN c.domain = 'support' THEN 'Support queue, SLA, and escalation intelligence'
      WHEN c.domain = 'risk' THEN 'Risk exposure, compliance controls, and governance insights'
      ELSE 'Domain intelligence generated from discovered schema'
    END AS description,
    c.entity_count,
    c.entity_groups,
    c.sensitivities
  FROM combined c
  ORDER BY c.entity_count DESC, c.domain ASC;
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
  v_disabled integer := 0;
  v_has_connections boolean := false;
  v_has_active_connections boolean := false;
  v_has_schema boolean := false;
  v_status text := 'draft';
  v_reason text := 'no_active_connections';
  v_schema_fingerprint text := 'schema:none';
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.api_connections c
    WHERE c.tenant_id = v_tenant_id
      AND c.is_archived = false
  ) INTO v_has_connections;

  SELECT EXISTS (
    SELECT 1
    FROM public.api_connections c
    WHERE c.tenant_id = v_tenant_id
      AND c.is_archived = false
      AND c.status IN ('active', 'syncing')
  ) INTO v_has_active_connections;

  SELECT EXISTS (
    SELECT 1
    FROM public.connection_entities e
    JOIN public.api_connections c
      ON c.id = e.connection_id
     AND c.tenant_id = e.tenant_id
    WHERE e.tenant_id = v_tenant_id
      AND c.is_archived = false
  ) INTO v_has_schema;

  v_status := CASE
    WHEN NOT v_has_connections THEN 'draft'
    WHEN v_has_active_connections AND v_has_schema THEN 'ready'
    WHEN v_has_active_connections AND NOT v_has_schema THEN 'syncing'
    ELSE 'degraded'
  END;

  v_reason := CASE
    WHEN NOT v_has_connections THEN 'no_active_connections'
    WHEN v_has_active_connections AND v_has_schema THEN 'schema_discovery'
    WHEN v_has_active_connections AND NOT v_has_schema THEN 'awaiting_schema'
    ELSE 'connections_degraded'
  END;

  SELECT COALESCE(
    md5(
      string_agg(
        d.slug || ':' || d.entity_count::text || ':' || array_to_string(d.entity_groups, ',') || ':' || array_to_string(d.sensitivities, ','),
        '|' ORDER BY d.slug
      )
    ),
    'schema:none'
  )
  INTO v_schema_fingerprint
  FROM public.derive_agent_domains(v_tenant_id, p_force) d;

  INSERT INTO public.ai_agents (
    tenant_id,
    name,
    slug,
    domain,
    description,
    status,
    config,
    lifecycle_reason,
    schema_fingerprint,
    last_regenerated_at,
    created_by
  )
  SELECT
    v_tenant_id,
    d.name,
    d.slug,
    d.domain,
    d.description,
    v_status,
    jsonb_build_object(
      'system_generated', true,
      'generated_from', 'schema_domains',
      'entity_count', d.entity_count,
      'entity_groups', d.entity_groups,
      'sensitivities', d.sensitivities
    ),
    v_reason,
    v_schema_fingerprint,
    now(),
    auth.uid()
  FROM public.derive_agent_domains(v_tenant_id, p_force) d
  ON CONFLICT (tenant_id, slug) DO NOTHING;

  GET DIAGNOSTICS v_seeded = ROW_COUNT;

  UPDATE public.ai_agents a
  SET
    name = d.name,
    domain = d.domain,
    description = d.description,
    status = v_status,
    lifecycle_reason = v_reason,
    schema_fingerprint = v_schema_fingerprint,
    config = COALESCE(a.config, '{}'::jsonb) || jsonb_build_object(
      'system_generated', true,
      'generated_from', 'schema_domains',
      'entity_count', d.entity_count,
      'entity_groups', d.entity_groups,
      'sensitivities', d.sensitivities
    ),
    last_regenerated_at = now(),
    updated_at = now()
  FROM public.derive_agent_domains(v_tenant_id, p_force) d
  WHERE a.tenant_id = v_tenant_id
    AND a.slug = d.slug;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  UPDATE public.ai_agents a
  SET
    status = 'disabled',
    lifecycle_reason = 'domain_removed',
    schema_fingerprint = v_schema_fingerprint,
    last_regenerated_at = now(),
    updated_at = now()
  WHERE a.tenant_id = v_tenant_id
    AND (
      COALESCE(a.config ->> 'system_generated', 'false') = 'true'
      OR a.slug IN ('finance', 'ops', 'analytics', 'customers', 'support', 'risk')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.derive_agent_domains(v_tenant_id, p_force) d
      WHERE d.slug = a.slug
    )
    AND a.status <> 'disabled';

  GET DIAGNOSTICS v_disabled = ROW_COUNT;
  v_updated := v_updated + v_disabled;

  seeded := v_seeded;
  updated := v_updated;
  tenant_id := v_tenant_id;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.derive_agent_domains(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.regenerate_agents_for_tenant(uuid, boolean) TO authenticated;
