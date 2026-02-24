-- Agent detail backend contract: tools, memory, performance, RACI bindings.

CREATE TABLE IF NOT EXISTS public.agent_tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.ai_agents(id) ON DELETE CASCADE,
  name text NOT NULL,
  method text NOT NULL DEFAULT 'GET',
  endpoint text NOT NULL,
  risk_level text NOT NULL DEFAULT 'low'
    CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  raci_required text NOT NULL DEFAULT 'R'
    CHECK (raci_required IN ('R', 'A', 'C', 'I')),
  version text NOT NULL DEFAULT 'v1',
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, name)
);

ALTER TABLE public.agent_tools ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS agent_tools_tenant_agent_idx
  ON public.agent_tools (tenant_id, agent_id, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.agent_memory_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.ai_agents(id) ON DELETE CASCADE,
  memory_type text NOT NULL
    CHECK (memory_type IN ('session', 'user', 'organization')),
  session_id uuid REFERENCES public.chat_sessions(id) ON DELETE SET NULL,
  subject_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  memory_key text NOT NULL,
  memory_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_memory_entries ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS agent_memory_entries_tenant_agent_idx
  ON public.agent_memory_entries (tenant_id, agent_id, memory_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.agent_raci_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.ai_agents(id) ON DELETE CASCADE,
  resource text NOT NULL DEFAULT 'agent_action',
  action text NOT NULL DEFAULT 'execute',
  role_name text NOT NULL,
  raci_type text NOT NULL
    CHECK (raci_type IN ('R', 'A', 'C', 'I')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, action, raci_type)
);

ALTER TABLE public.agent_raci_bindings ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS agent_raci_bindings_tenant_agent_idx
  ON public.agent_raci_bindings (tenant_id, agent_id, action, raci_type);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'set_updated_at_timestamp'
      AND pg_function_is_visible(oid)
  ) THEN
    DROP TRIGGER IF EXISTS agent_tools_set_updated_at ON public.agent_tools;
    CREATE TRIGGER agent_tools_set_updated_at
    BEFORE UPDATE ON public.agent_tools
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS agent_memory_entries_set_updated_at ON public.agent_memory_entries;
    CREATE TRIGGER agent_memory_entries_set_updated_at
    BEFORE UPDATE ON public.agent_memory_entries
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS agent_raci_bindings_set_updated_at ON public.agent_raci_bindings;
    CREATE TRIGGER agent_raci_bindings_set_updated_at
    BEFORE UPDATE ON public.agent_raci_bindings
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_timestamp();
  END IF;
END;
$$;

DROP POLICY IF EXISTS "Tenant members can view agent tools" ON public.agent_tools;
CREATE POLICY "Tenant members can view agent tools"
  ON public.agent_tools FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage agent tools" ON public.agent_tools;
CREATE POLICY "Tenant members can manage agent tools"
  ON public.agent_tools FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view agent memory entries" ON public.agent_memory_entries;
CREATE POLICY "Tenant members can view agent memory entries"
  ON public.agent_memory_entries FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage agent memory entries" ON public.agent_memory_entries;
CREATE POLICY "Tenant members can manage agent memory entries"
  ON public.agent_memory_entries FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view agent raci bindings" ON public.agent_raci_bindings;
CREATE POLICY "Tenant members can view agent raci bindings"
  ON public.agent_raci_bindings FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage agent raci bindings" ON public.agent_raci_bindings;
CREATE POLICY "Tenant members can manage agent raci bindings"
  ON public.agent_raci_bindings FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

CREATE OR REPLACE FUNCTION public.ensure_default_agent_tools(
  p_agent_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_agent record;
  v_inserted integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT a.id, a.tenant_id, lower(trim(COALESCE(a.domain, ''))) AS domain
  INTO v_agent
  FROM public.ai_agents a
  WHERE a.id = p_agent_id;

  IF v_agent.id IS NULL OR v_agent.tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'Agent not found';
  END IF;

  IF v_agent.domain = 'finance' THEN
    INSERT INTO public.agent_tools (tenant_id, agent_id, name, method, endpoint, risk_level, raci_required, version)
    VALUES
      (v_tenant_id, p_agent_id, 'Revenue Query', 'POST', '/finance/revenue/query', 'low', 'R', 'v1'),
      (v_tenant_id, p_agent_id, 'Invoice Lookup', 'GET', '/finance/invoices/{id}', 'low', 'R', 'v1'),
      (v_tenant_id, p_agent_id, 'Payment Request', 'POST', '/finance/payments/request', 'high', 'A', 'v1')
    ON CONFLICT (agent_id, name) DO NOTHING;
  ELSIF v_agent.domain = 'operations' THEN
    INSERT INTO public.agent_tools (tenant_id, agent_id, name, method, endpoint, risk_level, raci_required, version)
    VALUES
      (v_tenant_id, p_agent_id, 'Sync Health Check', 'GET', '/ops/sync/health', 'low', 'R', 'v1'),
      (v_tenant_id, p_agent_id, 'Job Retry', 'POST', '/ops/jobs/retry', 'medium', 'A', 'v1'),
      (v_tenant_id, p_agent_id, 'Escalation Trigger', 'POST', '/ops/escalations', 'high', 'A', 'v1')
    ON CONFLICT (agent_id, name) DO NOTHING;
  ELSIF v_agent.domain = 'analytics' THEN
    INSERT INTO public.agent_tools (tenant_id, agent_id, name, method, endpoint, risk_level, raci_required, version)
    VALUES
      (v_tenant_id, p_agent_id, 'Trend Analyzer', 'POST', '/analytics/trends', 'low', 'R', 'v1'),
      (v_tenant_id, p_agent_id, 'Forecast Run', 'POST', '/analytics/forecast', 'medium', 'R', 'v1'),
      (v_tenant_id, p_agent_id, 'Anomaly Alert', 'POST', '/analytics/anomaly-alert', 'medium', 'A', 'v1')
    ON CONFLICT (agent_id, name) DO NOTHING;
  ELSE
    INSERT INTO public.agent_tools (tenant_id, agent_id, name, method, endpoint, risk_level, raci_required, version)
    VALUES
      (v_tenant_id, p_agent_id, 'Knowledge Search', 'POST', '/agent/knowledge/search', 'low', 'R', 'v1'),
      (v_tenant_id, p_agent_id, 'Structured Query', 'POST', '/agent/sql/query', 'medium', 'R', 'v1'),
      (v_tenant_id, p_agent_id, 'Governed Action', 'POST', '/agent/action/execute', 'high', 'A', 'v1')
    ON CONFLICT (agent_id, name) DO NOTHING;
  END IF;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.ensure_default_agent_raci_bindings(
  p_agent_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_inserted integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.ai_agents a
    WHERE a.id = p_agent_id
      AND a.tenant_id = v_tenant_id
  ) THEN
    RAISE EXCEPTION 'Agent not found';
  END IF;

  INSERT INTO public.agent_raci_bindings (tenant_id, agent_id, resource, action, role_name, raci_type)
  VALUES
    (v_tenant_id, p_agent_id, 'agent_action', 'execute', 'manager', 'R'),
    (v_tenant_id, p_agent_id, 'agent_action', 'execute', 'admin', 'A'),
    (v_tenant_id, p_agent_id, 'agent_action', 'execute', 'member', 'C'),
    (v_tenant_id, p_agent_id, 'agent_action', 'execute', 'viewer', 'I')
  ON CONFLICT (agent_id, action, raci_type) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_agent_detail_payload(
  p_agent_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_agent record;
  v_payload jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT
    a.id,
    a.name,
    a.slug,
    a.domain,
    a.description,
    a.status,
    a.avatar_emoji,
    a.source_connection_id,
    COALESCE(c.name, 'Auto-discovered') AS source_connection_name,
    a.updated_at
  INTO v_agent
  FROM public.ai_agents a
  LEFT JOIN public.api_connections c
    ON c.id = a.source_connection_id
   AND c.tenant_id = a.tenant_id
  WHERE a.id = p_agent_id
    AND a.tenant_id = v_tenant_id;

  IF v_agent.id IS NULL THEN
    RAISE EXCEPTION 'Agent not found';
  END IF;

  PERFORM public.ensure_default_agent_tools(p_agent_id);
  PERFORM public.ensure_default_agent_raci_bindings(p_agent_id);

  WITH memory_stats AS (
    SELECT
      COUNT(DISTINCT ame.session_id) FILTER (
        WHERE ame.memory_type = 'session' AND ame.session_id IS NOT NULL
      )::integer AS session_active_sessions,
      COUNT(*) FILTER (WHERE ame.memory_type = 'user')::integer AS user_entries,
      MAX(ame.updated_at) FILTER (WHERE ame.memory_type = 'user') AS user_last_updated,
      COUNT(*) FILTER (WHERE ame.memory_type = 'organization')::integer AS org_entries,
      MAX(ame.updated_at) FILTER (WHERE ame.memory_type = 'organization') AS org_last_updated
    FROM public.agent_memory_entries ame
    WHERE ame.tenant_id = v_tenant_id
      AND ame.agent_id = p_agent_id
  ),
  org_vectors AS (
    SELECT
      COUNT(*) FILTER (WHERE kdc.embedding IS NOT NULL)::integer AS vector_count,
      COALESCE(SUM(octet_length(kdc.content::text)), 0)::bigint AS storage_bytes
    FROM public.knowledge_document_chunks kdc
    WHERE kdc.tenant_id = v_tenant_id
  ),
  daily AS (
    SELECT
      d.day::date AS day,
      COALESCE(COUNT(atr.id), 0)::integer AS queries,
      COALESCE(COUNT(*) FILTER (WHERE atr.status IN ('success', 'blocked')), 0)::integer AS success_count,
      COALESCE(COUNT(*) FILTER (WHERE atr.status = 'error'), 0)::integer AS failure_count,
      COALESCE(ROUND(AVG(NULLIF(atr.latency_ms, 0))), 0)::integer AS avg_ms
    FROM (
      SELECT generate_series(current_date - 6, current_date, interval '1 day') AS day
    ) d
    LEFT JOIN public.agent_tool_runs atr
      ON atr.tenant_id = v_tenant_id
     AND atr.agent_id = p_agent_id
     AND atr.created_at >= d.day
     AND atr.created_at < d.day + interval '1 day'
    GROUP BY d.day
    ORDER BY d.day
  ),
  success_rate AS (
    SELECT
      COALESCE(COUNT(*) FILTER (WHERE atr.status IN ('success', 'blocked')), 0)::integer AS success_count,
      COALESCE(COUNT(*) FILTER (WHERE atr.status = 'error'), 0)::integer AS failure_count
    FROM public.agent_tool_runs atr
    WHERE atr.tenant_id = v_tenant_id
      AND atr.agent_id = p_agent_id
      AND atr.created_at >= now() - interval '7 days'
  ),
  most_used_tools AS (
    SELECT
      atr.tool_name,
      COUNT(*)::integer AS usage_count
    FROM public.agent_tool_runs atr
    WHERE atr.tenant_id = v_tenant_id
      AND atr.agent_id = p_agent_id
      AND atr.created_at >= now() - interval '30 days'
    GROUP BY atr.tool_name
    ORDER BY usage_count DESC, atr.tool_name ASC
    LIMIT 8
  )
  SELECT jsonb_build_object(
    'agent', jsonb_build_object(
      'id', v_agent.id,
      'name', v_agent.name,
      'slug', v_agent.slug,
      'domain', v_agent.domain,
      'description', v_agent.description,
      'status', v_agent.status,
      'avatarEmoji', v_agent.avatar_emoji,
      'sourceConnectionId', v_agent.source_connection_id,
      'sourceConnectionName', v_agent.source_connection_name,
      'updatedAt', v_agent.updated_at
    ),
    'tools', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'name', t.name,
          'method', t.method,
          'endpoint', t.endpoint,
          'riskLevel', t.risk_level,
          'raciRequired', t.raci_required,
          'version', t.version,
          'enabled', t.enabled,
          'updatedAt', t.updated_at
        )
        ORDER BY t.name ASC
      )
      FROM public.agent_tools t
      WHERE t.tenant_id = v_tenant_id
        AND t.agent_id = p_agent_id
    ), '[]'::jsonb),
    'memory', jsonb_build_object(
      'session', jsonb_build_object(
        'activeSessions', COALESCE((SELECT ms.session_active_sessions FROM memory_stats ms), 0)
      ),
      'user', jsonb_build_object(
        'entriesCount', COALESCE((SELECT ms.user_entries FROM memory_stats ms), 0),
        'lastUpdated', (SELECT ms.user_last_updated FROM memory_stats ms)
      ),
      'organization', jsonb_build_object(
        'entriesCount', COALESCE((SELECT ms.org_entries FROM memory_stats ms), 0),
        'lastUpdated', (SELECT ms.org_last_updated FROM memory_stats ms),
        'vectorCount', COALESCE((SELECT ov.vector_count FROM org_vectors ov), 0),
        'storageBytes', COALESCE((SELECT ov.storage_bytes FROM org_vectors ov), 0)
      ),
      'preview', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', ame.id,
            'memoryType', ame.memory_type,
            'key', ame.memory_key,
            'value', ame.memory_value,
            'updatedAt', ame.updated_at
          )
          ORDER BY ame.updated_at DESC
        )
        FROM (
          SELECT *
          FROM public.agent_memory_entries x
          WHERE x.tenant_id = v_tenant_id
            AND x.agent_id = p_agent_id
          ORDER BY x.updated_at DESC
          LIMIT 5
        ) ame
      ), '[]'::jsonb)
    ),
    'performance', jsonb_build_object(
      'queriesPerDay', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'day', to_char(d.day, 'YYYY-MM-DD'),
            'queries', d.queries
          )
          ORDER BY d.day ASC
        )
        FROM daily d
      ), '[]'::jsonb),
      'successFailure', jsonb_build_object(
        'success', COALESCE((SELECT sr.success_count FROM success_rate sr), 0),
        'failure', COALESCE((SELECT sr.failure_count FROM success_rate sr), 0)
      ),
      'avgResponseTrend', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'day', to_char(d.day, 'YYYY-MM-DD'),
            'avgMs', d.avg_ms
          )
          ORDER BY d.day ASC
        )
        FROM daily d
      ), '[]'::jsonb),
      'mostUsedTools', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'tool', mut.tool_name,
            'count', mut.usage_count
          )
          ORDER BY mut.usage_count DESC, mut.tool_name ASC
        )
        FROM most_used_tools mut
      ), '[]'::jsonb)
    ),
    'raciBindings', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', arb.id,
          'resource', arb.resource,
          'action', arb.action,
          'roleName', arb.role_name,
          'raciType', arb.raci_type,
          'updatedAt', arb.updated_at
        )
        ORDER BY arb.action ASC, arb.raci_type ASC
      )
      FROM public.agent_raci_bindings arb
      WHERE arb.tenant_id = v_tenant_id
        AND arb.agent_id = p_agent_id
    ), '[]'::jsonb),
    'recentExecutions', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', atr.id,
          'toolName', atr.tool_name,
          'status', atr.status,
          'riskLevel', atr.risk_level,
          'latencyMs', atr.latency_ms,
          'error', atr.error,
          'createdAt', atr.created_at
        )
        ORDER BY atr.created_at DESC
      )
      FROM (
        SELECT *
        FROM public.agent_tool_runs t
        WHERE t.tenant_id = v_tenant_id
          AND t.agent_id = p_agent_id
        ORDER BY t.created_at DESC
        LIMIT 20
      ) atr
    ), '[]'::jsonb)
  )
  INTO v_payload;

  RETURN COALESCE(v_payload, '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.rename_agent(
  p_agent_id uuid,
  p_name text
)
RETURNS TABLE (
  id uuid,
  name text,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_name text := trim(COALESCE(p_name, ''));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_name = '' THEN
    RAISE EXCEPTION 'Agent name is required';
  END IF;

  UPDATE public.ai_agents a
  SET
    name = v_name,
    updated_at = now()
  WHERE a.id = p_agent_id
    AND a.tenant_id = v_tenant_id
  RETURNING a.id, a.name, a.updated_at
  INTO id, name, updated_at;

  IF id IS NULL THEN
    RAISE EXCEPTION 'Agent not found';
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'agent.rename',
    'ai_agents',
    'success',
    jsonb_build_object('agent_id', p_agent_id, 'name', v_name)
  );

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_agent_tool_enabled(
  p_tool_id uuid,
  p_enabled boolean
)
RETURNS TABLE (
  id uuid,
  enabled boolean,
  updated_at timestamptz
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

  UPDATE public.agent_tools t
  SET
    enabled = p_enabled,
    updated_at = now()
  WHERE t.id = p_tool_id
    AND t.tenant_id = v_tenant_id
  RETURNING t.id, t.enabled, t.updated_at
  INTO id, enabled, updated_at;

  IF id IS NULL THEN
    RAISE EXCEPTION 'Tool not found';
  END IF;

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_agent_raci_binding_role(
  p_binding_id uuid,
  p_role_name text
)
RETURNS TABLE (
  id uuid,
  role_name text,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role text := lower(trim(COALESCE(p_role_name, '')));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_role = '' THEN
    RAISE EXCEPTION 'Role name is required';
  END IF;

  UPDATE public.agent_raci_bindings b
  SET
    role_name = v_role,
    updated_at = now()
  WHERE b.id = p_binding_id
    AND b.tenant_id = v_tenant_id
  RETURNING b.id, b.role_name, b.updated_at
  INTO id, role_name, updated_at;

  IF id IS NULL THEN
    RAISE EXCEPTION 'RACI binding not found';
  END IF;

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_agent_memory_entries(
  p_agent_id uuid,
  p_memory_type text DEFAULT 'all'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_memory_type text := lower(trim(COALESCE(p_memory_type, 'all')));
  v_deleted integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.ai_agents a
    WHERE a.id = p_agent_id
      AND a.tenant_id = v_tenant_id
  ) THEN
    RAISE EXCEPTION 'Agent not found';
  END IF;

  IF v_memory_type NOT IN ('all', 'session', 'user', 'organization') THEN
    RAISE EXCEPTION 'Invalid memory type';
  END IF;

  DELETE FROM public.agent_memory_entries ame
  WHERE ame.tenant_id = v_tenant_id
    AND ame.agent_id = p_agent_id
    AND (
      v_memory_type = 'all'
      OR ame.memory_type = v_memory_type
    );

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'agent.memory.clear',
    'agent_memory_entries',
    'success',
    jsonb_build_object('agent_id', p_agent_id, 'memory_type', v_memory_type, 'deleted', v_deleted)
  );

  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_default_agent_tools(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_default_agent_raci_bindings(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_detail_payload(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rename_agent(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_agent_tool_enabled(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_agent_raci_binding_role(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_agent_memory_entries(uuid, text) TO authenticated;
