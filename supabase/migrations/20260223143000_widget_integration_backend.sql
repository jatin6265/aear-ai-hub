-- Embedded widget configuration backend for /dashboard/settings/widget.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.ensure_default_widget_config(
  p_tenant_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_widget_id uuid;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant id is required';
  END IF;

  INSERT INTO public.widget_configs (
    tenant_id,
    name,
    slug,
    status,
    allowed_origins,
    appearance,
    behavior,
    created_by
  )
  VALUES (
    p_tenant_id,
    'AEAR Assistant Widget',
    'assistant',
    'active',
    ARRAY[]::text[],
    jsonb_build_object(
      'position', 'bottom-right',
      'primaryColor', '#7c3aed',
      'buttonSize', 'medium'
    ),
    jsonb_build_object(
      'initialMessage', 'How can I help you today?',
      'accessMode', 'public',
      'enabledAgentIds', '[]'::jsonb,
      'features', jsonb_build_object(
        'chat', true,
        'executeActions', false,
        'viewReports', false,
        'requestApprovals', false
      )
    ),
    auth.uid()
  )
  ON CONFLICT (tenant_id, slug) DO UPDATE
    SET updated_at = now()
  RETURNING id INTO v_widget_id;

  RETURN v_widget_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_widget_integration_payload()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_tenant_name text := 'AEAR Workspace';
  v_widget record;
  v_agents jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context found';
  END IF;

  PERFORM public.ensure_default_widget_config(v_tenant_id);

  SELECT t.name
  INTO v_tenant_name
  FROM public.tenants t
  WHERE t.id = v_tenant_id
  LIMIT 1;

  SELECT
    w.id,
    w.name,
    w.slug,
    w.status,
    w.allowed_origins,
    w.appearance,
    w.behavior,
    w.secret_hash,
    w.updated_at
  INTO v_widget
  FROM public.widget_configs w
  WHERE w.tenant_id = v_tenant_id
    AND w.slug = 'assistant'
  LIMIT 1;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'name', a.name,
        'domain', a.domain,
        'status', a.status
      )
      ORDER BY a.name
    ),
    '[]'::jsonb
  )
  INTO v_agents
  FROM public.ai_agents a
  WHERE a.tenant_id = v_tenant_id
    AND a.status <> 'disabled';

  RETURN jsonb_build_object(
    'tenantId', v_tenant_id,
    'tenantName', COALESCE(v_tenant_name, 'AEAR Workspace'),
    'widget', jsonb_build_object(
      'id', v_widget.id,
      'name', COALESCE(v_widget.name, 'AEAR Assistant Widget'),
      'slug', COALESCE(v_widget.slug, 'assistant'),
      'status', COALESCE(v_widget.status, 'active'),
      'appearance', COALESCE(v_widget.appearance, '{}'::jsonb),
      'behavior', COALESCE(v_widget.behavior, '{}'::jsonb),
      'allowedOrigins', COALESCE(v_widget.allowed_origins, ARRAY[]::text[]),
      'jwtSecretConfigured', (v_widget.secret_hash IS NOT NULL),
      'updatedAt', v_widget.updated_at
    ),
    'agents', v_agents,
    'jwtInstructions', jsonb_build_array(
      'Generate a short-lived JWT on your server with tenant_id and widget_slug claims.',
      'Sign using your server secret (never expose the signing secret in client code).',
      'Pass the JWT to window.AEAR.init({ mode: \"jwt\", token: \"...\" }) when embedding.'
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_widget_integration_config(
  p_name text,
  p_position text,
  p_primary_color text,
  p_button_size text,
  p_initial_message text,
  p_access_mode text,
  p_allowed_origins text[],
  p_enabled_agent_ids uuid[],
  p_feature_execute_actions boolean,
  p_feature_view_reports boolean,
  p_feature_request_approvals boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_position text := lower(trim(COALESCE(p_position, 'bottom-right')));
  v_size text := lower(trim(COALESCE(p_button_size, 'medium')));
  v_mode text := lower(trim(COALESCE(p_access_mode, 'public')));
  v_color text := trim(COALESCE(p_primary_color, '#7c3aed'));
  v_name text := NULLIF(trim(COALESCE(p_name, '')), '');
  v_message text := trim(COALESCE(p_initial_message, 'How can I help you today?'));
  v_widget_id uuid;
  v_jwt_hash text;
  v_status text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context found';
  END IF;

  IF v_position NOT IN ('bottom-right', 'bottom-left', 'top-right', 'top-left') THEN
    v_position := 'bottom-right';
  END IF;

  IF v_size NOT IN ('small', 'medium', 'large') THEN
    v_size := 'medium';
  END IF;

  IF v_mode NOT IN ('public', 'authenticated', 'jwt') THEN
    v_mode := 'public';
  END IF;

  IF v_color !~ '^#[0-9a-fA-F]{6}$' THEN
    v_color := '#7c3aed';
  END IF;

  v_widget_id := public.ensure_default_widget_config(v_tenant_id);

  SELECT secret_hash
  INTO v_jwt_hash
  FROM public.widget_configs
  WHERE id = v_widget_id
  LIMIT 1;

  IF v_mode = 'jwt' AND v_jwt_hash IS NULL THEN
    v_jwt_hash := encode(digest(gen_random_uuid()::text || clock_timestamp()::text, 'sha256'), 'hex');
  END IF;

  UPDATE public.widget_configs w
  SET
    name = COALESCE(v_name, w.name),
    status = 'active',
    allowed_origins = COALESCE(p_allowed_origins, ARRAY[]::text[]),
    appearance = jsonb_build_object(
      'position', v_position,
      'primaryColor', v_color,
      'buttonSize', v_size
    ),
    behavior = jsonb_build_object(
      'initialMessage', CASE WHEN v_message = '' THEN 'How can I help you today?' ELSE v_message END,
      'accessMode', v_mode,
      'enabledAgentIds', COALESCE(to_jsonb(p_enabled_agent_ids), '[]'::jsonb),
      'features', jsonb_build_object(
        'chat', true,
        'executeActions', COALESCE(p_feature_execute_actions, false),
        'viewReports', COALESCE(p_feature_view_reports, false),
        'requestApprovals', COALESCE(p_feature_request_approvals, false)
      )
    ),
    secret_hash = v_jwt_hash,
    updated_at = now()
  WHERE w.id = v_widget_id
  RETURNING w.status INTO v_status;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'widget.config.save',
    v_widget_id::text,
    'success',
    jsonb_build_object(
      'position', v_position,
      'buttonSize', v_size,
      'accessMode', v_mode,
      'allowedOriginsCount', COALESCE(array_length(p_allowed_origins, 1), 0),
      'enabledAgentCount', COALESCE(array_length(p_enabled_agent_ids, 1), 0)
    )
  );

  RETURN jsonb_build_object(
    'saved', true,
    'widgetId', v_widget_id,
    'status', v_status,
    'jwtSecretConfigured', (v_jwt_hash IS NOT NULL)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_default_widget_config(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_widget_integration_payload() TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_widget_integration_config(text, text, text, text, text, text, text[], uuid[], boolean, boolean, boolean) TO authenticated;
