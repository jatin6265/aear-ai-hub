-- Enforce schema-only agent generation; remove static default agent seeding.

CREATE OR REPLACE FUNCTION public.seed_agents_for_tenant(p_tenant_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Deprecated: agent creation is now strictly schema-driven via regenerate_agents_for_tenant.
  RETURN 0;
END;
$$;

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
  )
  SELECT
    a.domain,
    CASE
      WHEN a.domain = 'operations' THEN 'ops'
      ELSE a.domain
    END AS slug,
    CASE
      WHEN a.domain = 'operations' THEN 'Ops Agent'
      ELSE initcap(replace(a.domain, '_', ' ')) || ' Agent'
    END AS name,
    CASE
      WHEN a.domain = 'finance' THEN 'Revenue, invoices, and payment intelligence'
      WHEN a.domain = 'operations' THEN 'Workflow, incidents, and sync operations'
      WHEN a.domain = 'analytics' THEN 'Trends, forecasts, and anomaly analysis'
      WHEN a.domain = 'customers' THEN 'Customer lifecycle, retention, and account intelligence'
      WHEN a.domain = 'support' THEN 'Support queue, SLA, and escalation intelligence'
      WHEN a.domain = 'risk' THEN 'Risk exposure, compliance controls, and governance insights'
      ELSE 'Domain intelligence generated from discovered schema'
    END AS description,
    a.entity_count,
    a.entity_groups,
    a.sensitivities
  FROM aggregated a
  ORDER BY a.entity_count DESC, a.domain ASC;
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
    lifecycle_reason = CASE
      WHEN v_has_schema THEN 'domain_removed'
      ELSE 'awaiting_schema'
    END,
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
  v_seeded integer := 0;
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

  SELECT COALESCE(r.seeded, 0)
  INTO v_seeded
  FROM public.regenerate_agents_for_tenant(v_tenant_id, false) r
  LIMIT 1;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'workspace.launch',
    'tenant',
    'success',
    jsonb_build_object('raci_rules_applied', v_applied, 'agents_seeded', v_seeded)
  );

  SELECT t.id, t.status INTO tenant_id, tenant_status
  FROM public.tenants t
  WHERE t.id = v_tenant_id;

  applied_rules := v_applied;
  seeded_agents := v_seeded;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_agents_for_tenant(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.derive_agent_domains(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.regenerate_agents_for_tenant(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.launch_workspace(jsonb) TO authenticated;
