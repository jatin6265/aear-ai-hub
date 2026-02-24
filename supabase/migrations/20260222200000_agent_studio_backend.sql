-- Agent Studio backend: custom agent generation, configuration, deploy/sync, and chat-triggered creation.

CREATE TABLE IF NOT EXISTS public.custom_agent_specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL UNIQUE REFERENCES public.ai_agents(id) ON DELETE CASCADE,
  prompt text NOT NULL DEFAULT '',
  objective text,
  system_prompt text,
  orchestrator_model text NOT NULL DEFAULT 'gpt-4.1-mini',
  embedding_model text NOT NULL DEFAULT 'text-embedding-3-small',
  vector_index text NOT NULL DEFAULT 'pgvector',
  vector_strategy text NOT NULL DEFAULT 'hybrid'
    CHECK (vector_strategy IN ('hybrid', 'vector', 'lexical')),
  rag_enabled boolean NOT NULL DEFAULT true,
  auto_sync boolean NOT NULL DEFAULT true,
  auto_deploy boolean NOT NULL DEFAULT true,
  sync_frequency text NOT NULL DEFAULT 'hourly'
    CHECK (sync_frequency IN ('realtime', '5m', 'hourly', 'daily')),
  source_connection_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  deployment_status text NOT NULL DEFAULT 'draft'
    CHECK (deployment_status IN ('draft', 'ready', 'deploying', 'active', 'error')),
  deployment_notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.custom_agent_specs ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS custom_agent_specs_tenant_agent_idx
  ON public.custom_agent_specs (tenant_id, agent_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS custom_agent_specs_tenant_status_idx
  ON public.custom_agent_specs (tenant_id, deployment_status, updated_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'set_updated_at_timestamp'
      AND pg_function_is_visible(oid)
  ) THEN
    DROP TRIGGER IF EXISTS custom_agent_specs_set_updated_at ON public.custom_agent_specs;
    CREATE TRIGGER custom_agent_specs_set_updated_at
    BEFORE UPDATE ON public.custom_agent_specs
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_timestamp();
  END IF;
END;
$$;

DROP POLICY IF EXISTS "Tenant members can view custom agent specs" ON public.custom_agent_specs;
CREATE POLICY "Tenant members can view custom agent specs"
  ON public.custom_agent_specs FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage custom agent specs" ON public.custom_agent_specs;
CREATE POLICY "Tenant members can manage custom agent specs"
  ON public.custom_agent_specs FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

CREATE OR REPLACE FUNCTION public.agent_slugify(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(NULLIF(regexp_replace(lower(trim(COALESCE(p_text, ''))), '[^a-z0-9]+', '_', 'g'), ''), 'custom_agent');
$$;

CREATE OR REPLACE FUNCTION public.default_agent_emoji_for_domain(p_domain text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN lower(COALESCE(p_domain, '')) ~ '(finance|billing|revenue|account)' THEN '💰'
    WHEN lower(COALESCE(p_domain, '')) ~ '(ops|operation|workflow|supply|inventory)' THEN '⚙️'
    WHEN lower(COALESCE(p_domain, '')) ~ '(hr|people|talent)' THEN '📦'
    WHEN lower(COALESCE(p_domain, '')) ~ '(analytics|insight|forecast)' THEN '📊'
    WHEN lower(COALESCE(p_domain, '')) ~ '(risk|security|admin|compliance)' THEN '🛡️'
    ELSE '🤖'
  END;
$$;

CREATE OR REPLACE FUNCTION public.infer_agent_domain_from_prompt(p_prompt text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN lower(COALESCE(p_prompt, '')) ~ '(finance|billing|revenue|invoice|payment|cash|ledger)' THEN 'finance'
    WHEN lower(COALESCE(p_prompt, '')) ~ '(ops|operation|workflow|incident|queue|sync|pipeline|supply|inventory)' THEN 'operations'
    WHEN lower(COALESCE(p_prompt, '')) ~ '(analytics|insight|forecast|anomaly|trend|kpi)' THEN 'analytics'
    WHEN lower(COALESCE(p_prompt, '')) ~ '(hr|people|employee|talent|leave|payroll)' THEN 'hr'
    WHEN lower(COALESCE(p_prompt, '')) ~ '(risk|security|audit|guardrail|compliance)' THEN 'risk'
    WHEN lower(COALESCE(p_prompt, '')) ~ '(support|ticket|customer)' THEN 'support'
    ELSE 'operations'
  END;
$$;

CREATE OR REPLACE FUNCTION public.default_agent_capabilities_for_domain(p_domain text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(COALESCE(p_domain, ''))
    WHEN 'finance' THEN ARRAY['Revenue analytics', 'Invoice intelligence', 'Payment anomaly checks', 'Approval-aware actions']::text[]
    WHEN 'operations' THEN ARRAY['Workflow orchestration', 'Sync diagnostics', 'SLA monitoring', 'Runbook actions']::text[]
    WHEN 'analytics' THEN ARRAY['Trend analysis', 'Forecast generation', 'Anomaly detection', 'Executive insights']::text[]
    WHEN 'hr' THEN ARRAY['Headcount insights', 'Attrition risk flags', 'Policy Q&A', 'Workforce trend analysis']::text[]
    WHEN 'risk' THEN ARRAY['Policy checks', 'Control monitoring', 'Audit evidence lookup', 'Guardrail enforcement']::text[]
    WHEN 'support' THEN ARRAY['Ticket triage', 'Response drafting', 'Escalation routing', 'SLA breach prediction']::text[]
    ELSE ARRAY['Knowledge retrieval', 'Structured data querying', 'Governed action planning', 'Cross-system orchestration']::text[]
  END;
$$;

CREATE OR REPLACE FUNCTION public.agent_template_catalog()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_array(
    jsonb_build_object(
      'key', 'finance_analyst',
      'name', 'Finance Analyst',
      'domain', 'finance',
      'icon', '💰',
      'description', 'Revenue, margin, cashflow and invoice intelligence.',
      'capabilities', to_jsonb(public.default_agent_capabilities_for_domain('finance'))
    ),
    jsonb_build_object(
      'key', 'operations_copilot',
      'name', 'Operations Copilot',
      'domain', 'operations',
      'icon', '⚙️',
      'description', 'Monitors syncs, incidents and operational workflows.',
      'capabilities', to_jsonb(public.default_agent_capabilities_for_domain('operations'))
    ),
    jsonb_build_object(
      'key', 'analytics_planner',
      'name', 'Analytics Planner',
      'domain', 'analytics',
      'icon', '📊',
      'description', 'Forecasting, anomaly analysis and strategic insights.',
      'capabilities', to_jsonb(public.default_agent_capabilities_for_domain('analytics'))
    ),
    jsonb_build_object(
      'key', 'risk_guardian',
      'name', 'Risk Guardian',
      'domain', 'risk',
      'icon', '🛡️',
      'description', 'RACI + policy guardrails with high-risk action governance.',
      'capabilities', to_jsonb(public.default_agent_capabilities_for_domain('risk'))
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.suggest_custom_agent_blueprint(
  p_prompt text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_prompt text := trim(COALESCE(p_prompt, ''));
  v_domain text;
  v_name text;
  v_icon text;
  v_capabilities text[];
  v_connection_ids uuid[] := '{}'::uuid[];
  v_connection_names text[] := '{}'::text[];
  v_questions text[] := ARRAY[]::text[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_prompt = '' THEN
    RAISE EXCEPTION 'Prompt is required';
  END IF;

  v_domain := public.infer_agent_domain_from_prompt(v_prompt);
  v_icon := public.default_agent_emoji_for_domain(v_domain);
  v_capabilities := public.default_agent_capabilities_for_domain(v_domain);

  v_name := CASE v_domain
    WHEN 'finance' THEN 'Finance Copilot'
    WHEN 'operations' THEN 'Operations Copilot'
    WHEN 'analytics' THEN 'Analytics Copilot'
    WHEN 'hr' THEN 'HR Copilot'
    WHEN 'risk' THEN 'Risk Copilot'
    WHEN 'support' THEN 'Support Copilot'
    ELSE 'Custom Copilot'
  END;

  SELECT
    COALESCE(array_agg(c.id ORDER BY
      CASE c.status
        WHEN 'active' THEN 0
        WHEN 'syncing' THEN 1
        WHEN 'pending' THEN 2
        ELSE 3
      END,
      c.created_at ASC
    ), '{}'::uuid[]),
    COALESCE(array_agg(c.name ORDER BY
      CASE c.status
        WHEN 'active' THEN 0
        WHEN 'syncing' THEN 1
        WHEN 'pending' THEN 2
        ELSE 3
      END,
      c.created_at ASC
    ), '{}'::text[])
  INTO v_connection_ids, v_connection_names
  FROM (
    SELECT *
    FROM public.api_connections c
    WHERE c.tenant_id = v_tenant_id
      AND c.is_archived = false
      AND c.status IN ('active', 'syncing', 'pending')
    ORDER BY
      CASE c.status
        WHEN 'active' THEN 0
        WHEN 'syncing' THEN 1
        WHEN 'pending' THEN 2
        ELSE 3
      END,
      c.created_at ASC
    LIMIT 3
  ) c;

  IF COALESCE(array_length(v_connection_ids, 1), 0) = 0 THEN
    v_questions := v_questions || ARRAY['Which systems should this agent connect first?'];
  END IF;

  v_questions := v_questions || ARRAY[
    'Should the agent only answer, or also execute governed actions?',
    'What response tone do you want: executive brief, analytical, or operational?',
    'Any restricted entities or sensitive data this agent should avoid?'
  ];

  RETURN jsonb_build_object(
    'name', v_name,
    'domain', v_domain,
    'icon', v_icon,
    'description', 'Auto-generated from your prompt and tenant data topology.',
    'capabilities', to_jsonb(v_capabilities),
    'recommendedConnectionIds', to_jsonb(v_connection_ids),
    'recommendedConnections', to_jsonb(v_connection_names),
    'vectorStrategy', 'hybrid',
    'syncFrequency', 'hourly',
    'questions', to_jsonb(v_questions),
    'prompt', v_prompt
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_custom_agent_studio(
  p_agent_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_domain text DEFAULT NULL,
  p_prompt text DEFAULT NULL,
  p_objective text DEFAULT NULL,
  p_system_prompt text DEFAULT NULL,
  p_avatar_emoji text DEFAULT NULL,
  p_capabilities text[] DEFAULT '{}'::text[],
  p_source_connection_ids uuid[] DEFAULT '{}'::uuid[],
  p_sync_frequency text DEFAULT 'hourly',
  p_vector_strategy text DEFAULT 'hybrid',
  p_rag_enabled boolean DEFAULT true,
  p_auto_sync boolean DEFAULT true,
  p_auto_deploy boolean DEFAULT true,
  p_deploy_now boolean DEFAULT true,
  p_raci_scope text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_agent_id uuid := p_agent_id;
  v_now timestamptz := now();
  v_name text := trim(COALESCE(p_name, ''));
  v_description text := NULLIF(trim(COALESCE(p_description, '')), '');
  v_prompt text := trim(COALESCE(p_prompt, ''));
  v_domain text := lower(trim(COALESCE(p_domain, '')));
  v_icon text := NULLIF(trim(COALESCE(p_avatar_emoji, '')), '');
  v_slug_base text;
  v_slug text;
  v_slug_attempt integer := 0;
  v_capabilities text[] := '{}'::text[];
  v_source_connection_ids uuid[] := '{}'::uuid[];
  v_source_connection_id uuid := NULL;
  v_sync_frequency text := lower(trim(COALESCE(p_sync_frequency, 'hourly')));
  v_vector_strategy text := lower(trim(COALESCE(p_vector_strategy, 'hybrid')));
  v_raci_scope text := NULLIF(trim(COALESCE(p_raci_scope, '')), '');
  v_status text := 'draft';
  v_created boolean := false;
  v_sync_jobs integer := 0;
  v_embedding_jobs integer := 0;
  v_job_id uuid;
  v_embedding_row record;
  v_existing record;
  v_connection_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  IF v_name = '' THEN
    v_name := 'Custom Copilot';
  END IF;

  IF v_domain = '' THEN
    v_domain := public.infer_agent_domain_from_prompt(COALESCE(v_prompt, v_name));
  END IF;

  IF v_sync_frequency NOT IN ('realtime', '5m', 'hourly', 'daily') THEN
    v_sync_frequency := 'hourly';
  END IF;

  IF v_vector_strategy NOT IN ('hybrid', 'vector', 'lexical') THEN
    v_vector_strategy := 'hybrid';
  END IF;

  IF v_icon IS NULL THEN
    v_icon := public.default_agent_emoji_for_domain(v_domain);
  END IF;

  SELECT COALESCE(array_agg(trim(capability)), '{}'::text[])
  INTO v_capabilities
  FROM (
    SELECT DISTINCT lower(trim(x)) AS capability
    FROM unnest(COALESCE(p_capabilities, '{}'::text[])) AS x
    WHERE trim(COALESCE(x, '')) <> ''
  ) normalized;

  IF COALESCE(array_length(v_capabilities, 1), 0) = 0 THEN
    v_capabilities := public.default_agent_capabilities_for_domain(v_domain);
  END IF;

  SELECT COALESCE(array_agg(c.id), '{}'::uuid[])
  INTO v_source_connection_ids
  FROM public.api_connections c
  WHERE c.tenant_id = v_tenant_id
    AND c.is_archived = false
    AND c.id = ANY(COALESCE(p_source_connection_ids, '{}'::uuid[]));

  IF COALESCE(array_length(v_source_connection_ids, 1), 0) = 0 THEN
    SELECT ARRAY_REMOVE(ARRAY[c.id], NULL)
    INTO v_source_connection_ids
    FROM public.api_connections c
    WHERE c.tenant_id = v_tenant_id
      AND c.is_archived = false
    ORDER BY
      CASE c.status
        WHEN 'active' THEN 0
        WHEN 'syncing' THEN 1
        WHEN 'pending' THEN 2
        ELSE 3
      END,
      c.created_at ASC
    LIMIT 1;
  END IF;

  IF COALESCE(array_length(v_source_connection_ids, 1), 0) > 0 THEN
    v_source_connection_id := v_source_connection_ids[1];
  END IF;

  IF v_raci_scope IS NULL THEN
    v_raci_scope := CASE v_domain
      WHEN 'finance' THEN 'Restricted to Finance Manager role'
      WHEN 'operations' THEN 'Restricted to Operations Manager role'
      WHEN 'analytics' THEN 'Restricted to Analytics Manager role'
      WHEN 'risk' THEN 'Restricted to Admin / Owner role'
      ELSE 'Restricted by tenant RACI policy'
    END;
  END IF;

  v_slug_base := public.agent_slugify(v_name);
  v_slug := v_slug_base;

  LOOP
    EXIT WHEN NOT EXISTS (
      SELECT 1
      FROM public.ai_agents a
      WHERE a.tenant_id = v_tenant_id
        AND a.slug = v_slug
        AND (v_agent_id IS NULL OR a.id <> v_agent_id)
    );

    v_slug_attempt := v_slug_attempt + 1;
    v_slug := v_slug_base || '_' || v_slug_attempt::text;

    IF v_slug_attempt > 50 THEN
      RAISE EXCEPTION 'Could not derive unique slug for custom agent';
    END IF;
  END LOOP;

  IF v_agent_id IS NOT NULL THEN
    SELECT a.id, a.slug, a.name
    INTO v_existing
    FROM public.ai_agents a
    WHERE a.id = v_agent_id
      AND a.tenant_id = v_tenant_id;

    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION 'Agent not found';
    END IF;

    UPDATE public.ai_agents a
    SET
      name = v_name,
      slug = v_slug,
      domain = v_domain,
      description = v_description,
      avatar_emoji = v_icon,
      capabilities = v_capabilities,
      source_connection_id = v_source_connection_id,
      raci_scope = v_raci_scope,
      is_custom = true,
      lifecycle_reason = 'custom_agent_configured',
      updated_at = v_now
    WHERE a.id = v_agent_id
      AND a.tenant_id = v_tenant_id;
  ELSE
    INSERT INTO public.ai_agents (
      tenant_id,
      name,
      slug,
      domain,
      description,
      status,
      config,
      created_by,
      avatar_emoji,
      capabilities,
      source_connection_id,
      raci_scope,
      is_custom,
      lifecycle_reason,
      updated_at
    )
    VALUES (
      v_tenant_id,
      v_name,
      v_slug,
      v_domain,
      v_description,
      'draft',
      jsonb_build_object(
        'source_connection_ids', COALESCE(to_jsonb(v_source_connection_ids), '[]'::jsonb),
        'vector_strategy', v_vector_strategy,
        'rag_enabled', p_rag_enabled,
        'sync_frequency', v_sync_frequency,
        'system_prompt', p_system_prompt,
        'objective', p_objective,
        'prompt', v_prompt
      ),
      auth.uid(),
      v_icon,
      v_capabilities,
      v_source_connection_id,
      v_raci_scope,
      true,
      'custom_agent_created',
      v_now
    )
    RETURNING id INTO v_agent_id;

    v_created := true;
  END IF;

  INSERT INTO public.custom_agent_specs (
    tenant_id,
    agent_id,
    prompt,
    objective,
    system_prompt,
    vector_strategy,
    rag_enabled,
    auto_sync,
    auto_deploy,
    sync_frequency,
    source_connection_ids,
    deployment_status,
    deployment_notes,
    created_by,
    updated_at
  )
  VALUES (
    v_tenant_id,
    v_agent_id,
    v_prompt,
    NULLIF(trim(COALESCE(p_objective, '')), ''),
    NULLIF(trim(COALESCE(p_system_prompt, '')), ''),
    v_vector_strategy,
    COALESCE(p_rag_enabled, true),
    COALESCE(p_auto_sync, true),
    COALESCE(p_auto_deploy, true),
    v_sync_frequency,
    COALESCE(v_source_connection_ids, '{}'::uuid[]),
    CASE WHEN p_deploy_now THEN 'deploying' ELSE 'draft' END,
    CASE WHEN p_deploy_now THEN 'Deployment queued from Agent Studio' ELSE 'Saved as draft from Agent Studio' END,
    auth.uid(),
    v_now
  )
  ON CONFLICT (agent_id)
  DO UPDATE SET
    prompt = EXCLUDED.prompt,
    objective = EXCLUDED.objective,
    system_prompt = EXCLUDED.system_prompt,
    vector_strategy = EXCLUDED.vector_strategy,
    rag_enabled = EXCLUDED.rag_enabled,
    auto_sync = EXCLUDED.auto_sync,
    auto_deploy = EXCLUDED.auto_deploy,
    sync_frequency = EXCLUDED.sync_frequency,
    source_connection_ids = EXCLUDED.source_connection_ids,
    deployment_status = EXCLUDED.deployment_status,
    deployment_notes = EXCLUDED.deployment_notes,
    updated_at = EXCLUDED.updated_at;

  PERFORM public.ensure_default_agent_tools(v_agent_id);
  PERFORM public.ensure_default_agent_raci_bindings(v_agent_id);

  INSERT INTO public.agent_tools (
    tenant_id,
    agent_id,
    name,
    method,
    endpoint,
    risk_level,
    raci_required,
    version,
    enabled,
    config
  ) VALUES
    (v_tenant_id, v_agent_id, 'Knowledge Retrieval', 'POST', '/agent/custom/' || v_slug || '/knowledge', 'low', 'R', 'v1', true, jsonb_build_object('rag_enabled', p_rag_enabled, 'vector_strategy', v_vector_strategy)),
    (v_tenant_id, v_agent_id, 'Structured Analytics', 'POST', '/agent/custom/' || v_slug || '/sql', 'medium', 'R', 'v1', true, jsonb_build_object('governed', true)),
    (v_tenant_id, v_agent_id, 'Governed Action', 'POST', '/agent/custom/' || v_slug || '/action', 'high', 'A', 'v1', true, jsonb_build_object('approval_required', true)),
    (v_tenant_id, v_agent_id, 'Sync Orchestrator', 'POST', '/agent/custom/' || v_slug || '/sync', 'medium', 'A', 'v1', true, jsonb_build_object('auto_sync', p_auto_sync, 'sync_frequency', v_sync_frequency))
  ON CONFLICT (agent_id, name)
  DO UPDATE SET
    endpoint = EXCLUDED.endpoint,
    risk_level = EXCLUDED.risk_level,
    raci_required = EXCLUDED.raci_required,
    enabled = EXCLUDED.enabled,
    config = EXCLUDED.config,
    updated_at = now();

  DELETE FROM public.agent_memory_entries ame
  WHERE ame.tenant_id = v_tenant_id
    AND ame.agent_id = v_agent_id
    AND ame.memory_type = 'organization'
    AND ame.memory_key = 'agent_blueprint';

  INSERT INTO public.agent_memory_entries (
    tenant_id,
    agent_id,
    memory_type,
    memory_key,
    memory_value,
    metadata
  ) VALUES (
    v_tenant_id,
    v_agent_id,
    'organization',
    'agent_blueprint',
    jsonb_build_object(
      'name', v_name,
      'domain', v_domain,
      'objective', NULLIF(trim(COALESCE(p_objective, '')), ''),
      'capabilities', to_jsonb(v_capabilities),
      'source_connection_ids', to_jsonb(COALESCE(v_source_connection_ids, '{}'::uuid[])),
      'vector_strategy', v_vector_strategy,
      'rag_enabled', p_rag_enabled,
      'sync_frequency', v_sync_frequency,
      'prompt', v_prompt
    ),
    jsonb_build_object('source', 'agent_studio', 'updated_by', auth.uid(), 'at', v_now)
  );

  IF COALESCE(p_auto_sync, true) AND COALESCE(array_length(v_source_connection_ids, 1), 0) > 0 THEN
    FOREACH v_connection_id IN ARRAY v_source_connection_ids
    LOOP
      SELECT queued.job_id
      INTO v_job_id
      FROM public.enqueue_connector_sync(
        p_connection_id := v_connection_id,
        p_job_type := 'schema_discovery',
        p_trigger_reason := 'custom_agent_sync',
        p_priority := 72,
        p_idempotency_key := 'agent:' || v_agent_id::text || ':conn:' || v_connection_id::text,
        p_payload := jsonb_build_object('agent_id', v_agent_id, 'source', 'agent_studio')
      ) AS queued
      LIMIT 1;

      IF v_job_id IS NOT NULL THEN
        v_sync_jobs := v_sync_jobs + 1;
      END IF;
    END LOOP;
  END IF;

  IF COALESCE(p_rag_enabled, true) THEN
    BEGIN
      SELECT *
      INTO v_embedding_row
      FROM public.schedule_knowledge_embedding_reindex(
        p_document_id := NULL,
        p_tenant_id := v_tenant_id,
        p_force := false,
        p_limit := 1200
      )
      LIMIT 1;

      v_embedding_jobs := COALESCE(v_embedding_row.queued_count, 0);
    EXCEPTION WHEN OTHERS THEN
      v_embedding_jobs := 0;
    END;
  END IF;

  IF p_deploy_now THEN
    IF v_sync_jobs > 0 THEN
      v_status := 'syncing';
    ELSE
      v_status := 'ready';
    END IF;
  ELSE
    v_status := 'draft';
  END IF;

  UPDATE public.ai_agents a
  SET
    status = v_status,
    lifecycle_reason = CASE
      WHEN p_deploy_now AND v_sync_jobs > 0 THEN 'custom_agent_deploy_syncing'
      WHEN p_deploy_now THEN 'custom_agent_deployed'
      ELSE 'custom_agent_draft'
    END,
    config = COALESCE(a.config, '{}'::jsonb) || jsonb_build_object(
      'source_connection_ids', COALESCE(to_jsonb(v_source_connection_ids), '[]'::jsonb),
      'vector_strategy', v_vector_strategy,
      'rag_enabled', p_rag_enabled,
      'sync_frequency', v_sync_frequency,
      'system_prompt', p_system_prompt,
      'objective', p_objective,
      'prompt', v_prompt,
      'studio_updated_at', v_now
    ),
    updated_at = v_now
  WHERE a.id = v_agent_id
    AND a.tenant_id = v_tenant_id;

  UPDATE public.custom_agent_specs s
  SET
    deployment_status = CASE
      WHEN p_deploy_now AND v_sync_jobs > 0 THEN 'deploying'
      WHEN p_deploy_now THEN 'active'
      ELSE 'draft'
    END,
    deployment_notes = CASE
      WHEN p_deploy_now AND v_sync_jobs > 0 THEN 'Agent deployed and waiting for sync completion'
      WHEN p_deploy_now THEN 'Agent deployed successfully'
      ELSE 'Draft saved'
    END,
    updated_at = v_now
  WHERE s.agent_id = v_agent_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    CASE WHEN v_created THEN 'agent.custom.create' ELSE 'agent.custom.configure' END,
    'ai_agents',
    'success',
    jsonb_build_object(
      'agent_id', v_agent_id,
      'agent_name', v_name,
      'deploy_now', p_deploy_now,
      'sync_jobs', v_sync_jobs,
      'embedding_jobs', v_embedding_jobs,
      'source_connections', COALESCE(to_jsonb(v_source_connection_ids), '[]'::jsonb)
    )
  );

  RETURN jsonb_build_object(
    'agentId', v_agent_id,
    'name', v_name,
    'slug', v_slug,
    'domain', v_domain,
    'status', v_status,
    'created', v_created,
    'syncJobsQueued', v_sync_jobs,
    'embeddingJobsQueued', v_embedding_jobs,
    'sourceConnectionIds', COALESCE(to_jsonb(v_source_connection_ids), '[]'::jsonb),
    'deployed', p_deploy_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_custom_agent(
  p_agent_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_source_connection_ids uuid[] := '{}'::uuid[];
  v_connection_id uuid;
  v_sync_jobs integer := 0;
  v_job_id uuid;
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

  SELECT COALESCE(s.source_connection_ids, '{}'::uuid[])
  INTO v_source_connection_ids
  FROM public.custom_agent_specs s
  WHERE s.agent_id = p_agent_id
    AND s.tenant_id = v_tenant_id
  LIMIT 1;

  IF COALESCE(array_length(v_source_connection_ids, 1), 0) = 0 THEN
    SELECT ARRAY_REMOVE(ARRAY[a.source_connection_id], NULL)
    INTO v_source_connection_ids
    FROM public.ai_agents a
    WHERE a.id = p_agent_id
      AND a.tenant_id = v_tenant_id;
  END IF;

  IF COALESCE(array_length(v_source_connection_ids, 1), 0) > 0 THEN
    FOREACH v_connection_id IN ARRAY v_source_connection_ids
    LOOP
      SELECT queued.job_id
      INTO v_job_id
      FROM public.enqueue_connector_sync(
        p_connection_id := v_connection_id,
        p_job_type := 'incremental_sync',
        p_trigger_reason := 'custom_agent_manual_sync',
        p_priority := 70,
        p_idempotency_key := 'agent_sync:' || p_agent_id::text || ':' || v_connection_id::text,
        p_payload := jsonb_build_object('agent_id', p_agent_id, 'source', 'manual_sync')
      ) AS queued
      LIMIT 1;

      IF v_job_id IS NOT NULL THEN
        v_sync_jobs := v_sync_jobs + 1;
      END IF;
    END LOOP;
  END IF;

  UPDATE public.ai_agents
  SET
    status = CASE WHEN v_sync_jobs > 0 THEN 'syncing' ELSE status END,
    lifecycle_reason = CASE WHEN v_sync_jobs > 0 THEN 'custom_agent_manual_sync' ELSE lifecycle_reason END,
    updated_at = now()
  WHERE id = p_agent_id
    AND tenant_id = v_tenant_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'agent.custom.sync',
    'ai_agents',
    'success',
    jsonb_build_object('agent_id', p_agent_id, 'sync_jobs', v_sync_jobs)
  );

  RETURN jsonb_build_object(
    'agentId', p_agent_id,
    'syncJobsQueued', v_sync_jobs
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_agent_studio_payload(
  p_agent_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_payload jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT jsonb_build_object(
    'templates', public.agent_template_catalog(),
    'connections', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'name', c.name,
          'type', c.type,
          'status', c.status,
          'schemaDetected', c.schema_detected,
          'lastSyncedAt', c.last_synced_at
        )
        ORDER BY
          CASE c.status
            WHEN 'active' THEN 0
            WHEN 'syncing' THEN 1
            WHEN 'pending' THEN 2
            ELSE 3
          END,
          c.created_at ASC
      )
      FROM public.api_connections c
      WHERE c.tenant_id = v_tenant_id
        AND c.is_archived = false
    ), '[]'::jsonb),
    'agents', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'name', a.name,
          'slug', a.slug,
          'domain', a.domain,
          'description', a.description,
          'status', a.status,
          'avatarEmoji', a.avatar_emoji,
          'isCustom', COALESCE(a.is_custom, false),
          'sourceConnectionId', a.source_connection_id,
          'capabilities', a.capabilities,
          'raciScope', a.raci_scope,
          'config', a.config,
          'studio', CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', s.id,
            'prompt', s.prompt,
            'objective', s.objective,
            'systemPrompt', s.system_prompt,
            'vectorStrategy', s.vector_strategy,
            'ragEnabled', s.rag_enabled,
            'autoSync', s.auto_sync,
            'autoDeploy', s.auto_deploy,
            'syncFrequency', s.sync_frequency,
            'sourceConnectionIds', to_jsonb(s.source_connection_ids),
            'deploymentStatus', s.deployment_status,
            'deploymentNotes', s.deployment_notes,
            'updatedAt', s.updated_at
          ) END
        )
        ORDER BY a.updated_at DESC, a.name ASC
      )
      FROM public.ai_agents a
      LEFT JOIN public.custom_agent_specs s
        ON s.agent_id = a.id
       AND s.tenant_id = a.tenant_id
      WHERE a.tenant_id = v_tenant_id
    ), '[]'::jsonb),
    'selectedAgent', CASE
      WHEN p_agent_id IS NULL THEN NULL
      ELSE (
        SELECT jsonb_build_object(
          'id', a.id,
          'name', a.name,
          'slug', a.slug,
          'domain', a.domain,
          'description', a.description,
          'status', a.status,
          'avatarEmoji', a.avatar_emoji,
          'isCustom', COALESCE(a.is_custom, false),
          'capabilities', a.capabilities,
          'raciScope', a.raci_scope,
          'sourceConnectionId', a.source_connection_id,
          'config', a.config,
          'studio', CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', s.id,
            'prompt', s.prompt,
            'objective', s.objective,
            'systemPrompt', s.system_prompt,
            'vectorStrategy', s.vector_strategy,
            'ragEnabled', s.rag_enabled,
            'autoSync', s.auto_sync,
            'autoDeploy', s.auto_deploy,
            'syncFrequency', s.sync_frequency,
            'sourceConnectionIds', to_jsonb(s.source_connection_ids),
            'deploymentStatus', s.deployment_status,
            'deploymentNotes', s.deployment_notes,
            'updatedAt', s.updated_at
          ) END
        )
        FROM public.ai_agents a
        LEFT JOIN public.custom_agent_specs s
          ON s.agent_id = a.id
         AND s.tenant_id = a.tenant_id
        WHERE a.id = p_agent_id
          AND a.tenant_id = v_tenant_id
      )
    END
  )
  INTO v_payload;

  RETURN COALESCE(v_payload, '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_custom_agent_from_chat_prompt(
  p_prompt text,
  p_session_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_blueprint jsonb;
  v_result jsonb;
  v_caps text[] := '{}'::text[];
  v_source_ids uuid[] := '{}'::uuid[];
  v_questions jsonb := '[]'::jsonb;
  v_domain text;
  v_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  v_blueprint := public.suggest_custom_agent_blueprint(p_prompt);
  v_questions := COALESCE(v_blueprint -> 'questions', '[]'::jsonb);
  v_domain := COALESCE(v_blueprint ->> 'domain', public.infer_agent_domain_from_prompt(p_prompt));
  v_name := COALESCE(NULLIF(v_blueprint ->> 'name', ''), 'Custom Copilot');

  SELECT COALESCE(array_agg(value), '{}'::text[])
  INTO v_caps
  FROM jsonb_array_elements_text(COALESCE(v_blueprint -> 'capabilities', '[]'::jsonb));

  SELECT COALESCE(array_agg(value::uuid), '{}'::uuid[])
  INTO v_source_ids
  FROM jsonb_array_elements_text(COALESCE(v_blueprint -> 'recommendedConnectionIds', '[]'::jsonb)) AS t(value)
  WHERE value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

  v_result := public.upsert_custom_agent_studio(
    p_agent_id := NULL,
    p_name := v_name,
    p_description := 'Generated from chat prompt and tenant context',
    p_domain := v_domain,
    p_prompt := p_prompt,
    p_objective := p_prompt,
    p_system_prompt := 'You are an enterprise AI agent that must enforce RACI and guardrails before actions.',
    p_avatar_emoji := COALESCE(v_blueprint ->> 'icon', public.default_agent_emoji_for_domain(v_domain)),
    p_capabilities := v_caps,
    p_source_connection_ids := v_source_ids,
    p_sync_frequency := COALESCE(v_blueprint ->> 'syncFrequency', 'hourly'),
    p_vector_strategy := COALESCE(v_blueprint ->> 'vectorStrategy', 'hybrid'),
    p_rag_enabled := true,
    p_auto_sync := true,
    p_auto_deploy := true,
    p_deploy_now := true,
    p_raci_scope := NULL
  );

  IF p_session_id IS NOT NULL THEN
    INSERT INTO public.agent_memory_entries (
      tenant_id,
      agent_id,
      memory_type,
      session_id,
      memory_key,
      memory_value,
      metadata
    )
    SELECT
      public.get_user_tenant_id(),
      (v_result ->> 'agentId')::uuid,
      'session',
      p_session_id,
      'agent_creation_request',
      jsonb_build_object('prompt', p_prompt, 'questions', v_questions),
      jsonb_build_object('source', 'chat', 'created_by', auth.uid(), 'at', now());
  END IF;

  RETURN jsonb_build_object(
    'blueprint', v_blueprint,
    'provision', v_result,
    'questions', v_questions
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.agent_slugify(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.default_agent_emoji_for_domain(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.infer_agent_domain_from_prompt(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.default_agent_capabilities_for_domain(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_template_catalog() TO authenticated;
GRANT EXECUTE ON FUNCTION public.suggest_custom_agent_blueprint(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_custom_agent_studio(uuid, text, text, text, text, text, text, text, text[], uuid[], text, text, boolean, boolean, boolean, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_custom_agent(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_studio_payload(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_custom_agent_from_chat_prompt(text, uuid) TO authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'custom_agent_specs'
  ) THEN
    NULL;
  ELSE
    ALTER PUBLICATION supabase_realtime ADD TABLE public.custom_agent_specs;
  END IF;
END;
$$;
