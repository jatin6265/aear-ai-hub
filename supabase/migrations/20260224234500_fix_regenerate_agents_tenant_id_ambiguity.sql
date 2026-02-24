-- Fix launch_workspace failure: remove tenant_id ambiguity in regenerate_agents_for_tenant.

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
  ON CONFLICT ON CONSTRAINT ai_agents_tenant_id_slug_key DO NOTHING;

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

  RETURN QUERY SELECT v_seeded, v_updated, v_tenant_id;
END;
$$;
