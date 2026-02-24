-- Agents dashboard backend contract: enriched agent metadata + lifecycle toggles.

ALTER TABLE public.ai_agents
  ADD COLUMN IF NOT EXISTS avatar_emoji text,
  ADD COLUMN IF NOT EXISTS capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS raci_scope text,
  ADD COLUMN IF NOT EXISTS source_connection_id uuid REFERENCES public.api_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_custom boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ai_agents_tenant_source_idx
  ON public.ai_agents (tenant_id, source_connection_id);

UPDATE public.ai_agents a
SET
  avatar_emoji = COALESCE(
    a.avatar_emoji,
    CASE
      WHEN a.slug = 'finance' OR a.domain = 'finance' THEN '💰'
      WHEN a.slug = 'ops' OR a.domain = 'operations' THEN '⚙️'
      WHEN a.domain = 'hr' THEN '📦'
      WHEN a.domain IN ('inventory', 'supply_chain') THEN '📋'
      WHEN a.domain = 'analytics' THEN '📊'
      WHEN a.domain IN ('risk', 'admin') THEN '🛡️'
      ELSE '🤖'
    END
  ),
  capabilities = CASE
    WHEN COALESCE(array_length(a.capabilities, 1), 0) > 0 THEN a.capabilities
    ELSE
      CASE
        WHEN a.slug = 'finance' OR a.domain = 'finance'
          THEN ARRAY['Revenue queries', 'Invoice lookup', 'Payment requests']::text[]
        WHEN a.slug = 'ops' OR a.domain = 'operations'
          THEN ARRAY['Workflow monitoring', 'Sync diagnostics', 'Approval routing']::text[]
        WHEN a.domain = 'analytics'
          THEN ARRAY['Trend analysis', 'Forecasting', 'Anomaly detection']::text[]
        WHEN a.domain = 'customers'
          THEN ARRAY['Account lookup', 'Churn insights', 'Retention segmentation']::text[]
        WHEN a.domain = 'support'
          THEN ARRAY['Ticket triage', 'SLA tracking', 'Escalation support']::text[]
        WHEN a.domain = 'risk'
          THEN ARRAY['Risk checks', 'Compliance audit', 'Guardrail monitoring']::text[]
        ELSE ARRAY['Knowledge search', 'Data Q&A', 'Guided actions']::text[]
      END
  END,
  raci_scope = COALESCE(
    a.raci_scope,
    CASE
      WHEN a.slug = 'finance' OR a.domain = 'finance' THEN 'Restricted to Finance Manager role'
      WHEN a.slug = 'ops' OR a.domain = 'operations' THEN 'Restricted to Operations Manager role'
      WHEN a.domain = 'analytics' THEN 'Restricted to Analytics Manager role'
      WHEN a.domain IN ('risk', 'admin') THEN 'Restricted to Admin / Owner role'
      ELSE 'Restricted by tenant RACI policy'
    END
  );

WITH ranked_sources AS (
  SELECT
    a.id AS agent_id,
    c.id AS connection_id,
    ROW_NUMBER() OVER (
      PARTITION BY a.id
      ORDER BY
        CASE c.status
          WHEN 'active' THEN 0
          WHEN 'syncing' THEN 1
          WHEN 'pending' THEN 2
          ELSE 3
        END,
        c.created_at ASC
    ) AS rn
  FROM public.ai_agents a
  JOIN public.api_connections c
    ON c.tenant_id = a.tenant_id
   AND c.is_archived = false
  WHERE a.source_connection_id IS NULL
)
UPDATE public.ai_agents a
SET source_connection_id = rs.connection_id
FROM ranked_sources rs
WHERE a.id = rs.agent_id
  AND rs.rn = 1;

CREATE OR REPLACE FUNCTION public.list_agents_dashboard(
  p_search text DEFAULT NULL,
  p_status text DEFAULT 'all'
)
RETURNS TABLE (
  id uuid,
  name text,
  slug text,
  domain text,
  description text,
  status text,
  status_bucket text,
  avatar_emoji text,
  source_connection_id uuid,
  source_connection_name text,
  capabilities text[],
  raci_scope text,
  queries_today integer,
  success_rate numeric,
  avg_response_ms integer,
  lifecycle_reason text,
  is_custom boolean,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT public.get_user_tenant_id() AS tenant_id
  ),
  filtered AS (
    SELECT
      a.id,
      a.name,
      a.slug,
      a.domain,
      a.description,
      a.status,
      CASE
        WHEN a.status = 'ready' THEN 'active'
        WHEN a.status IN ('syncing', 'draft') THEN 'training'
        ELSE 'inactive'
      END AS status_bucket,
      COALESCE(
        a.avatar_emoji,
        CASE
          WHEN a.slug = 'finance' OR a.domain = 'finance' THEN '💰'
          WHEN a.slug = 'ops' OR a.domain = 'operations' THEN '⚙️'
          WHEN a.domain = 'hr' THEN '📦'
          WHEN a.domain IN ('inventory', 'supply_chain') THEN '📋'
          WHEN a.domain = 'analytics' THEN '📊'
          WHEN a.domain IN ('risk', 'admin') THEN '🛡️'
          ELSE '🤖'
        END
      ) AS avatar_emoji,
      a.source_connection_id,
      COALESCE(
        src.name,
        fallback_src.name,
        'Auto-discovered'
      ) AS source_connection_name,
      CASE
        WHEN COALESCE(array_length(a.capabilities, 1), 0) > 0 THEN a.capabilities
        ELSE
          CASE
            WHEN a.slug = 'finance' OR a.domain = 'finance'
              THEN ARRAY['Revenue queries', 'Invoice lookup', 'Payment requests']::text[]
            WHEN a.slug = 'ops' OR a.domain = 'operations'
              THEN ARRAY['Workflow monitoring', 'Sync diagnostics', 'Approval routing']::text[]
            WHEN a.domain = 'analytics'
              THEN ARRAY['Trend analysis', 'Forecasting', 'Anomaly detection']::text[]
            WHEN a.domain = 'customers'
              THEN ARRAY['Account lookup', 'Churn insights', 'Retention segmentation']::text[]
            WHEN a.domain = 'support'
              THEN ARRAY['Ticket triage', 'SLA tracking', 'Escalation support']::text[]
            WHEN a.domain = 'risk'
              THEN ARRAY['Risk checks', 'Compliance audit', 'Guardrail monitoring']::text[]
            ELSE ARRAY['Knowledge search', 'Data Q&A', 'Guided actions']::text[]
          END
      END AS capabilities,
      COALESCE(
        a.raci_scope,
        CASE
          WHEN a.slug = 'finance' OR a.domain = 'finance' THEN 'Restricted to Finance Manager role'
          WHEN a.slug = 'ops' OR a.domain = 'operations' THEN 'Restricted to Operations Manager role'
          WHEN a.domain = 'analytics' THEN 'Restricted to Analytics Manager role'
          WHEN a.domain IN ('risk', 'admin') THEN 'Restricted to Admin / Owner role'
          ELSE 'Restricted by tenant RACI policy'
        END
      ) AS raci_scope,
      a.lifecycle_reason,
      COALESCE(a.is_custom, false) AS is_custom,
      a.updated_at
    FROM public.ai_agents a
    JOIN me ON me.tenant_id = a.tenant_id
    LEFT JOIN public.api_connections src
      ON src.id = a.source_connection_id
     AND src.tenant_id = a.tenant_id
    LEFT JOIN LATERAL (
      SELECT c.name
      FROM public.api_connections c
      WHERE c.tenant_id = a.tenant_id
        AND c.is_archived = false
      ORDER BY
        CASE c.status
          WHEN 'active' THEN 0
          WHEN 'syncing' THEN 1
          WHEN 'pending' THEN 2
          ELSE 3
        END,
        c.created_at ASC
      LIMIT 1
    ) fallback_src ON true
    WHERE (
      p_search IS NULL
      OR trim(p_search) = ''
      OR a.name ILIKE '%' || trim(p_search) || '%'
      OR a.domain ILIKE '%' || trim(p_search) || '%'
      OR a.slug ILIKE '%' || trim(p_search) || '%'
    )
  ),
  stats AS (
    SELECT
      COALESCE(tr.agent_id::text, lower(trim(tr.agent_name))) AS agent_key,
      COUNT(*)::integer AS queries_today,
      ROUND(
        CASE
          WHEN COUNT(*) = 0 THEN 0
          ELSE ((COUNT(*) FILTER (WHERE tr.status IN ('success', 'blocked'))::numeric / COUNT(*)::numeric) * 100)
        END,
        2
      ) AS success_rate,
      ROUND(AVG(NULLIF(tr.latency_ms, 0)))::integer AS avg_response_ms
    FROM public.agent_tool_runs tr
    JOIN me ON me.tenant_id = tr.tenant_id
    WHERE tr.created_at >= date_trunc('day', now())
    GROUP BY COALESCE(tr.agent_id::text, lower(trim(tr.agent_name)))
  )
  SELECT
    f.id,
    f.name,
    f.slug,
    f.domain,
    f.description,
    f.status,
    f.status_bucket,
    f.avatar_emoji,
    f.source_connection_id,
    f.source_connection_name,
    f.capabilities,
    f.raci_scope,
    COALESCE(s.queries_today, 0) AS queries_today,
    COALESCE(s.success_rate, 100)::numeric AS success_rate,
    COALESCE(s.avg_response_ms, 0) AS avg_response_ms,
    f.lifecycle_reason,
    f.is_custom,
    f.updated_at
  FROM filtered f
  LEFT JOIN stats s
    ON s.agent_key = f.id::text
    OR s.agent_key = lower(trim(f.name))
  WHERE
    CASE lower(trim(COALESCE(p_status, 'all')))
      WHEN 'all' THEN true
      WHEN 'active' THEN f.status_bucket = 'active'
      WHEN 'inactive' THEN f.status_bucket = 'inactive'
      WHEN 'training' THEN f.status_bucket = 'training'
      ELSE true
    END
  ORDER BY
    CASE f.status_bucket
      WHEN 'active' THEN 0
      WHEN 'training' THEN 1
      ELSE 2
    END,
    f.updated_at DESC,
    f.name ASC;
$$;

CREATE OR REPLACE FUNCTION public.set_agent_enabled(
  p_agent_id uuid,
  p_enabled boolean
)
RETURNS TABLE (
  id uuid,
  status text,
  status_bucket text,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_has_active_connections boolean := false;
  v_has_schema boolean := false;
  v_status text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  IF p_enabled THEN
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
      WHEN v_has_active_connections AND v_has_schema THEN 'ready'
      WHEN v_has_active_connections AND NOT v_has_schema THEN 'syncing'
      ELSE 'draft'
    END;
  ELSE
    v_status := 'disabled';
  END IF;

  UPDATE public.ai_agents a
  SET
    status = v_status,
    lifecycle_reason = CASE
      WHEN p_enabled THEN 'manual_enable'
      ELSE 'manual_disable'
    END,
    updated_at = now()
  WHERE a.id = p_agent_id
    AND a.tenant_id = v_tenant_id
  RETURNING
    a.id,
    a.status,
    CASE
      WHEN a.status = 'ready' THEN 'active'
      WHEN a.status IN ('syncing', 'draft') THEN 'training'
      ELSE 'inactive'
    END,
    a.updated_at
  INTO id, status, status_bucket, updated_at;

  IF id IS NULL THEN
    RAISE EXCEPTION 'Agent not found';
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    CASE WHEN p_enabled THEN 'agent.enable' ELSE 'agent.disable' END,
    'ai_agents',
    status,
    jsonb_build_object('agent_id', p_agent_id)
  );

  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_agents_dashboard(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_agent_enabled(uuid, boolean) TO authenticated;
