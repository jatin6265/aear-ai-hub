-- Phase 1 MCP-native integration bootstrap and runtime asset provisioning.

ALTER TABLE public.mcp_servers
  ADD COLUMN IF NOT EXISTS strategy text NOT NULL DEFAULT 'mcp',
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS integration_code text,
  ADD COLUMN IF NOT EXISTS auth_type text,
  ADD COLUMN IF NOT EXISTS docs_url text,
  ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS tool_manifest jsonb NOT NULL DEFAULT '{"tools":[]}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'mcp_servers_strategy_check'
      AND conrelid = 'public.mcp_servers'::regclass
  ) THEN
    ALTER TABLE public.mcp_servers
      ADD CONSTRAINT mcp_servers_strategy_check
      CHECK (strategy IN ('mcp', 'openapi', 'custom_template'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS mcp_servers_tenant_integration_idx
  ON public.mcp_servers (tenant_id, integration_code, is_active, updated_at DESC);

UPDATE public.integration_catalog
SET mcp_server_url = CASE code
  WHEN 'slack' THEN 'https://slack.com/mcp'
  WHEN 'github' THEN 'https://github.com/modelcontextprotocol/servers/tree/main/src/github'
  WHEN 'google_drive' THEN 'https://github.com/modelcontextprotocol/servers'
  WHEN 'notion' THEN 'https://notion.so/mcp'
  WHEN 'jira' THEN 'https://github.com/modelcontextprotocol/servers/tree/main/src/jira'
  WHEN 'hubspot' THEN 'https://developers.hubspot.com/docs/platform/create-an-app'
  WHEN 'stripe' THEN 'https://stripe.com/mcp'
  WHEN 'postgresql' THEN 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres'
  WHEN 'whatsapp' THEN 'https://developers.facebook.com/docs/whatsapp'
  WHEN 'gmail' THEN 'https://github.com/modelcontextprotocol/servers'
  WHEN 'outlook' THEN 'https://github.com/modelcontextprotocol/servers'
  ELSE mcp_server_url
END
WHERE code IN (
  'slack',
  'github',
  'google_drive',
  'notion',
  'jira',
  'hubspot',
  'stripe',
  'postgresql',
  'whatsapp',
  'gmail',
  'outlook'
);

INSERT INTO public.mcp_servers (
  tenant_id,
  name,
  description,
  url,
  auth_config,
  is_active,
  status,
  strategy,
  source,
  integration_code,
  capabilities,
  tool_manifest
)
SELECT
  NULL::uuid,
  seed.name,
  seed.description,
  seed.url,
  '{}'::jsonb,
  false,
  'offline',
  'mcp',
  'template',
  seed.integration_code,
  seed.capabilities,
  '{"tools":[]}'::jsonb
FROM (
  VALUES
    ('Slack MCP', 'Read channels, post messages, and search thread history.', 'https://slack.com/mcp', 'slack', '["chat","search","threads"]'::jsonb),
    ('GitHub MCP', 'Repository, issues, pull request, and commit tooling.', 'https://github.com/modelcontextprotocol/servers/tree/main/src/github', 'github', '["repos","issues","pull_requests","code_search"]'::jsonb),
    ('Drive MCP', 'File listing, search, and document export capabilities.', 'https://github.com/modelcontextprotocol/servers', 'google_drive', '["files","search","export"]'::jsonb),
    ('Notion MCP', 'Workspace search with pages/databases traversal.', 'https://notion.so/mcp', 'notion', '["search","pages","databases"]'::jsonb),
    ('Jira MCP', 'Issue, sprint, and transition operations.', 'https://github.com/modelcontextprotocol/servers/tree/main/src/jira', 'jira', '["issues","sprints","transitions"]'::jsonb),
    ('Stripe MCP', 'Payments, subscriptions, and invoice operations.', 'https://stripe.com/mcp', 'stripe', '["payments","subscriptions","invoices"]'::jsonb),
    ('Filesystem MCP', 'Sandboxed file read/write/search operations.', 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem', 'filesystem', '["read","write","search"]'::jsonb),
    ('Web Search MCP', 'Realtime web search in tool context.', 'https://platform.openai.com/docs', 'web_search', '["search"]'::jsonb),
    ('Email MCP', 'Thread search, send, and classification.', 'https://github.com/modelcontextprotocol/servers', 'email', '["read","send","classify"]'::jsonb),
    ('WhatsApp MCP', 'Conversation ingestion and delivery operations.', 'https://developers.facebook.com/docs/whatsapp', 'whatsapp', '["conversations","messages"]'::jsonb)
) AS seed(name, description, url, integration_code, capabilities)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.mcp_servers ms
  WHERE ms.tenant_id IS NULL
    AND lower(ms.name) = lower(seed.name)
);

CREATE OR REPLACE FUNCTION public.bootstrap_tenant_integration_runtime(
  p_tenant_id uuid,
  p_user_id uuid,
  p_integration_code text,
  p_credential_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_tenant uuid;
  v_code text := lower(trim(COALESCE(p_integration_code, '')));
  v_integration_id uuid;
  v_display_name text;
  v_category text;
  v_summary text;
  v_connection_type text;
  v_auth_type text;
  v_mcp_server_url text;
  v_tool_templates jsonb;
  v_docs_url text;
  v_strategy text;
  v_install_id uuid;
  v_mcp_server_id uuid := NULL;
  v_template jsonb;
  v_tool_name text;
  v_tool_code text;
  v_handler_key text;
  v_risk_level text;
  v_requires_approval boolean;
  v_is_write_action boolean;
  v_input_schema jsonb;
  v_generated_tools integer := 0;
  v_ingestion_job_id uuid;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id is required';
  END IF;
  IF v_code = '' THEN
    RAISE EXCEPTION 'integration_code is required';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    SELECT public.get_user_tenant_id() INTO v_user_tenant;
    IF v_user_tenant IS NULL OR v_user_tenant <> p_tenant_id THEN
      RAISE EXCEPTION 'Unauthorized tenant access';
    END IF;
  END IF;

  SELECT
    c.id,
    c.display_name,
    c.category,
    c.summary,
    c.connection_type,
    c.auth_type,
    c.mcp_server_url,
    c.tool_templates,
    c.docs_url
  INTO
    v_integration_id,
    v_display_name,
    v_category,
    v_summary,
    v_connection_type,
    v_auth_type,
    v_mcp_server_url,
    v_tool_templates,
    v_docs_url
  FROM public.integration_catalog c
  WHERE lower(c.code) = v_code
    AND c.is_active = true
  LIMIT 1;

  IF v_integration_id IS NULL THEN
    RAISE EXCEPTION 'Integration % not found', v_code;
  END IF;

  v_strategy := CASE
    WHEN NULLIF(trim(COALESCE(v_mcp_server_url, '')), '') IS NOT NULL THEN 'mcp'
    WHEN lower(COALESCE(v_connection_type, '')) = 'rest_api'
      AND (
        lower(COALESCE(v_docs_url, '')) LIKE '%openapi%'
        OR lower(COALESCE(v_docs_url, '')) LIKE '%.yaml%'
        OR lower(COALESCE(v_docs_url, '')) LIKE '%.json%'
      ) THEN 'openapi'
    ELSE 'custom_template'
  END;

  INSERT INTO public.tenant_integration_installs (
    tenant_id,
    integration_id,
    status,
    installed_by,
    installed_at,
    uninstalled_at,
    created_at,
    updated_at
  )
  VALUES (
    p_tenant_id,
    v_integration_id,
    'installed',
    COALESCE(p_user_id, auth.uid()),
    now(),
    NULL,
    now(),
    now()
  )
  ON CONFLICT (tenant_id, integration_id)
  DO UPDATE SET
    status = 'installed',
    installed_by = COALESCE(EXCLUDED.installed_by, public.tenant_integration_installs.installed_by),
    uninstalled_at = NULL,
    updated_at = now()
  RETURNING id INTO v_install_id;

  IF v_strategy = 'mcp' AND NULLIF(trim(COALESCE(v_mcp_server_url, '')), '') IS NOT NULL THEN
    SELECT ms.id
      INTO v_mcp_server_id
    FROM public.mcp_servers ms
    WHERE ms.tenant_id = p_tenant_id
      AND lower(COALESCE(ms.integration_code, '')) = v_code
    ORDER BY ms.created_at ASC
    LIMIT 1;

    IF v_mcp_server_id IS NULL THEN
      INSERT INTO public.mcp_servers (
        tenant_id,
        name,
        description,
        url,
        auth_config,
        is_active,
        status,
        strategy,
        source,
        integration_code,
        auth_type,
        docs_url,
        capabilities,
        tool_manifest
      )
      VALUES (
        p_tenant_id,
        v_display_name || ' MCP',
        COALESCE(v_summary, 'MCP integration server'),
        v_mcp_server_url,
        jsonb_build_object(
          'auth_type', COALESCE(v_auth_type, 'oauth2'),
          'credential_id', p_credential_id,
          'integration_code', v_code
        ),
        true,
        'offline',
        'mcp',
        'integration_install',
        v_code,
        COALESCE(v_auth_type, 'oauth2'),
        v_docs_url,
        COALESCE(
          CASE
            WHEN jsonb_typeof(v_tool_templates) = 'array'
              THEN (
                SELECT jsonb_agg(DISTINCT t->>'name')
                FROM jsonb_array_elements(v_tool_templates) t
                WHERE NULLIF(trim(COALESCE(t->>'name', '')), '') IS NOT NULL
              )
            ELSE '[]'::jsonb
          END,
          '[]'::jsonb
        ),
        jsonb_build_object('tools', COALESCE(v_tool_templates, '[]'::jsonb))
      )
      RETURNING id INTO v_mcp_server_id;
    ELSE
      UPDATE public.mcp_servers
      SET
        name = v_display_name || ' MCP',
        description = COALESCE(v_summary, description),
        url = v_mcp_server_url,
        auth_config = jsonb_build_object(
          'auth_type', COALESCE(v_auth_type, 'oauth2'),
          'credential_id', p_credential_id,
          'integration_code', v_code
        ),
        is_active = true,
        status = 'offline',
        strategy = 'mcp',
        source = 'integration_install',
        auth_type = COALESCE(v_auth_type, auth_type),
        docs_url = COALESCE(v_docs_url, docs_url),
        tool_manifest = jsonb_build_object('tools', COALESCE(v_tool_templates, '[]'::jsonb)),
        updated_at = now()
      WHERE id = v_mcp_server_id;
    END IF;
  END IF;

  IF jsonb_typeof(COALESCE(v_tool_templates, '[]'::jsonb)) = 'array' THEN
    FOR v_template IN
      SELECT value
      FROM jsonb_array_elements(COALESCE(v_tool_templates, '[]'::jsonb))
    LOOP
      v_tool_name := lower(trim(COALESCE(v_template->>'name', '')));
      IF v_tool_name = '' THEN
        CONTINUE;
      END IF;

      v_tool_code := regexp_replace(v_code || '_' || v_tool_name, '[^a-z0-9_]+', '_', 'g');
      v_tool_code := regexp_replace(v_tool_code, '_{2,}', '_', 'g');

      v_risk_level := lower(trim(COALESCE(v_template->>'risk_level', 'low')));
      IF v_risk_level NOT IN ('low', 'medium', 'high', 'critical') THEN
        v_risk_level := 'low';
      END IF;

      v_is_write_action := COALESCE((v_template->>'is_destructive')::boolean, false)
        OR COALESCE((v_template->>'requires_approval')::boolean, false)
        OR v_risk_level IN ('high', 'critical');
      v_requires_approval := v_risk_level IN ('high', 'critical')
        OR COALESCE((v_template->>'requires_approval')::boolean, false);

      v_handler_key := CASE lower(trim(COALESCE(v_template->>'tool_type', 'http_call')))
        WHEN 'sql_query' THEN 'tool.sql_query'
        WHEN 'transformation' THEN 'tool.transform'
        WHEN 'notification' THEN 'tool.notify'
        ELSE CASE
          WHEN v_strategy = 'mcp' THEN 'tool.mcp_proxy'
          WHEN v_strategy = 'openapi' THEN 'tool.openapi_proxy'
          ELSE 'tool.http_request'
        END
      END;

      v_input_schema := CASE
        WHEN jsonb_typeof(v_template->'input_schema') = 'object' THEN v_template->'input_schema'
        ELSE '{"type":"object","properties":{},"additionalProperties":true}'::jsonb
      END;

      UPDATE public.tool_registry tr
      SET
        display_name = COALESCE(NULLIF(trim(v_template->>'display_name'), ''), initcap(replace(v_tool_name, '_', ' '))),
        description = COALESCE(NULLIF(trim(v_template->>'description'), ''), 'Auto-generated from integration template'),
        category = lower(regexp_replace(COALESCE(v_category, 'integration'), '[^a-z0-9]+', '_', 'g')),
        input_schema = v_input_schema,
        default_config = jsonb_strip_nulls(jsonb_build_object(
          'integration_code', v_code,
          'strategy', v_strategy,
          'template', v_template,
          'mcp_server_id', v_mcp_server_id
        )),
        handler_key = v_handler_key,
        requires_credential_service = v_code,
        risk_level = v_risk_level,
        raci_required = CASE WHEN v_requires_approval THEN 'A' ELSE 'R' END,
        is_write_action = v_is_write_action,
        is_active = true,
        updated_at = now()
      WHERE tr.tenant_id = p_tenant_id
        AND tr.code = v_tool_code;

      IF NOT FOUND THEN
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
        VALUES (
          p_tenant_id,
          v_tool_code,
          COALESCE(NULLIF(trim(v_template->>'display_name'), ''), initcap(replace(v_tool_name, '_', ' '))),
          COALESCE(NULLIF(trim(v_template->>'description'), ''), 'Auto-generated from integration template'),
          lower(regexp_replace(COALESCE(v_category, 'integration'), '[^a-z0-9]+', '_', 'g')),
          v_input_schema,
          jsonb_strip_nulls(jsonb_build_object(
            'integration_code', v_code,
            'strategy', v_strategy,
            'template', v_template,
            'mcp_server_id', v_mcp_server_id
          )),
          v_handler_key,
          v_code,
          v_risk_level,
          CASE WHEN v_requires_approval THEN 'A' ELSE 'R' END,
          v_is_write_action,
          true,
          'v1'
        );
      END IF;

      v_generated_tools := v_generated_tools + 1;
    END LOOP;
  END IF;

  INSERT INTO public.ingestion_queue (
    tenant_id,
    source_kind,
    source_ref,
    payload,
    status,
    retry_count,
    created_at,
    updated_at
  )
  VALUES (
    p_tenant_id,
    'structured',
    v_install_id,
    jsonb_build_object(
      'event', 'integration_install',
      'integration_code', v_code,
      'strategy', v_strategy,
      'mcp_server_id', v_mcp_server_id,
      'generated_tools', v_generated_tools
    ),
    'pending',
    0,
    now(),
    now()
  )
  RETURNING id INTO v_ingestion_job_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    p_tenant_id,
    COALESCE(p_user_id, auth.uid()),
    'marketplace.bootstrap_runtime',
    'integration',
    'success',
    jsonb_build_object(
      'integrationCode', v_code,
      'integrationId', v_integration_id,
      'strategy', v_strategy,
      'mcpServerId', v_mcp_server_id,
      'generatedTools', v_generated_tools,
      'ingestionJobId', v_ingestion_job_id
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'integrationCode', v_code,
    'strategy', v_strategy,
    'mcpServerId', v_mcp_server_id,
    'generatedTools', v_generated_tools,
    'ingestionJobId', v_ingestion_job_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.teardown_tenant_integration_runtime(
  p_tenant_id uuid,
  p_user_id uuid,
  p_integration_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_tenant uuid;
  v_code text := lower(trim(COALESCE(p_integration_code, '')));
  v_disabled_servers integer := 0;
  v_disabled_tools integer := 0;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id is required';
  END IF;
  IF v_code = '' THEN
    RAISE EXCEPTION 'integration_code is required';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    SELECT public.get_user_tenant_id() INTO v_user_tenant;
    IF v_user_tenant IS NULL OR v_user_tenant <> p_tenant_id THEN
      RAISE EXCEPTION 'Unauthorized tenant access';
    END IF;
  END IF;

  UPDATE public.mcp_servers
  SET
    is_active = false,
    status = 'offline',
    updated_at = now()
  WHERE tenant_id = p_tenant_id
    AND lower(COALESCE(integration_code, '')) = v_code;
  GET DIAGNOSTICS v_disabled_servers = ROW_COUNT;

  UPDATE public.tool_registry
  SET
    is_active = false,
    updated_at = now()
  WHERE tenant_id = p_tenant_id
    AND (
      lower(COALESCE(default_config ->> 'integration_code', '')) = v_code
      OR lower(code) LIKE v_code || '\_%' ESCAPE '\'
    );
  GET DIAGNOSTICS v_disabled_tools = ROW_COUNT;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    p_tenant_id,
    COALESCE(p_user_id, auth.uid()),
    'marketplace.teardown_runtime',
    'integration',
    'success',
    jsonb_build_object(
      'integrationCode', v_code,
      'disabledMcpServers', v_disabled_servers,
      'disabledTools', v_disabled_tools
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'integrationCode', v_code,
    'disabledMcpServers', v_disabled_servers,
    'disabledTools', v_disabled_tools
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.bootstrap_tenant_integration_runtime(uuid, uuid, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.teardown_tenant_integration_runtime(uuid, uuid, text) TO authenticated, service_role;
