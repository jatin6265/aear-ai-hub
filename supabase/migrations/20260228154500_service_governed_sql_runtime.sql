-- Service-role compatible governed SQL functions for queued agent runtime.
-- These preserve tenant/user governance by requiring explicit tenant+user inputs.

CREATE OR REPLACE FUNCTION public.execute_tenant_read_sql_service(
  p_tenant_id uuid,
  p_user_id uuid,
  p_connection_id uuid,
  p_sql text,
  p_limit integer DEFAULT 200
)
RETURNS TABLE (
  success boolean,
  execution_ms integer,
  columns jsonb,
  rows jsonb,
  error text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sql text := trim(COALESCE(p_sql, ''));
  v_started_at timestamptz := clock_timestamp();
  v_rows jsonb := '[]'::jsonb;
  v_columns jsonb := '[]'::jsonb;
  v_error text := null;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000));
  v_exists boolean := false;
  v_has_is_archived boolean := false;
BEGIN
  IF p_tenant_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id and user_id are required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = p_user_id
      AND p.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'User does not belong to tenant';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'api_connections'
      AND column_name = 'is_archived'
  ) INTO v_has_is_archived;

  IF v_has_is_archived THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.api_connections c
      WHERE c.id = p_connection_id
        AND c.tenant_id = p_tenant_id
        AND c.is_archived = false
    )
    INTO v_exists;
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM public.api_connections c
      WHERE c.id = p_connection_id
        AND c.tenant_id = p_tenant_id
    )
    INTO v_exists;
  END IF;

  IF NOT v_exists THEN
    RAISE EXCEPTION 'Connection not found for tenant';
  END IF;

  IF v_sql = '' THEN
    RAISE EXCEPTION 'SQL query is required';
  END IF;

  IF v_sql ~ ';' THEN
    RAISE EXCEPTION 'Only a single SQL statement is allowed';
  END IF;

  IF v_sql !~* '^\s*(select|with)\b' THEN
    RAISE EXCEPTION 'Only SELECT/WITH statements are allowed';
  END IF;

  IF v_sql ~* '\m(insert|update|delete|drop|alter|truncate|create|grant|revoke|comment|copy|vacuum|analyze|refresh|set|reset|call|do)\M' THEN
    RAISE EXCEPTION 'Blocked by guardrails: write or administrative SQL is not allowed';
  END IF;

  IF v_sql !~* '\mlimit\s+\d+\M' THEN
    v_sql := v_sql || format(' LIMIT %s', v_limit);
  END IF;

  PERFORM set_config('statement_timeout', '12000', true);

  BEGIN
    EXECUTE format(
      'SELECT COALESCE(jsonb_agg(row_to_json(t)), ''[]''::jsonb) FROM (%s) t',
      v_sql
    )
    INTO v_rows;
  EXCEPTION
    WHEN OTHERS THEN
      v_error := SQLERRM;
  END;

  IF v_error IS NULL THEN
    IF jsonb_typeof(v_rows) <> 'array' THEN
      v_rows := '[]'::jsonb;
    END IF;

    IF jsonb_array_length(v_rows) > 0 THEN
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'key', key,
            'label', initcap(replace(key, '_', ' '))
          )
        ),
        '[]'::jsonb
      )
      INTO v_columns
      FROM jsonb_object_keys(v_rows -> 0) AS key;
    END IF;
  END IF;

  success := v_error IS NULL;
  execution_ms := GREATEST(
    1,
    FLOOR(EXTRACT(epoch FROM (clock_timestamp() - v_started_at)) * 1000)::integer
  );
  columns := COALESCE(v_columns, '[]'::jsonb);
  rows := COALESCE(v_rows, '[]'::jsonb);
  error := v_error;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.execute_tenant_sql_governed_service(
  p_tenant_id uuid,
  p_user_id uuid,
  p_connection_id uuid,
  p_sql text,
  p_limit integer DEFAULT 200,
  p_resource text DEFAULT 'chat_sql_execution',
  p_action text DEFAULT 'sql_query'
)
RETURNS TABLE (
  success boolean,
  execution_ms integer,
  columns jsonb,
  rows jsonb,
  error text,
  policy_decision jsonb,
  approval_required boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sql text := trim(COALESCE(p_sql, ''));
  v_requires_write boolean := false;
  v_policy record;
  v_reason text := '';
BEGIN
  IF p_tenant_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id and user_id are required';
  END IF;

  IF v_sql = '' THEN
    RAISE EXCEPTION 'SQL query is required';
  END IF;

  v_requires_write := v_sql ~* '\m(insert|update|delete|drop|alter|truncate|create|grant|revoke|comment|copy|vacuum|analyze|refresh|set|reset|call|do)\M';

  SELECT *
  INTO v_policy
  FROM public.evaluate_action_policy_service(
    p_tenant_id => p_tenant_id,
    p_user_id => p_user_id,
    p_resource => COALESCE(NULLIF(trim(p_resource), ''), 'chat_sql_execution'),
    p_action => COALESCE(NULLIF(trim(p_action), ''), 'sql_query'),
    p_risk_level => CASE WHEN v_requires_write THEN 'high' ELSE 'low' END,
    p_requires_write => v_requires_write
  )
  LIMIT 1;

  IF v_policy IS NULL THEN
    v_reason := 'Policy evaluator returned no decision';
    success := false;
    execution_ms := 0;
    columns := '[]'::jsonb;
    rows := '[]'::jsonb;
    error := v_reason;
    policy_decision := jsonb_build_object('allow', false, 'approval_required', true, 'reason', v_reason);
    approval_required := true;
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT COALESCE(v_policy.allow, false) THEN
    success := false;
    execution_ms := 0;
    columns := '[]'::jsonb;
    rows := '[]'::jsonb;
    error := COALESCE(v_policy.reason, 'Blocked by policy');
    policy_decision := to_jsonb(v_policy);
    approval_required := COALESCE(v_policy.approval_required, true);
    RETURN NEXT;
    RETURN;
  END IF;

  IF COALESCE(v_policy.approval_required, false) THEN
    success := false;
    execution_ms := 0;
    columns := '[]'::jsonb;
    rows := '[]'::jsonb;
    error := COALESCE(v_policy.reason, 'Approval required before execution');
    policy_decision := to_jsonb(v_policy);
    approval_required := true;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_requires_write THEN
    success := false;
    execution_ms := 0;
    columns := '[]'::jsonb;
    rows := '[]'::jsonb;
    error := 'Write SQL execution is disabled in governed RPC';
    policy_decision := to_jsonb(v_policy);
    approval_required := true;
    RETURN NEXT;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    q.success,
    q.execution_ms,
    q.columns,
    q.rows,
    q.error,
    to_jsonb(v_policy) AS policy_decision,
    false AS approval_required
  FROM public.execute_tenant_read_sql_service(
    p_tenant_id => p_tenant_id,
    p_user_id => p_user_id,
    p_connection_id => p_connection_id,
    p_sql => v_sql,
    p_limit => p_limit
  ) q;
END;
$$;

GRANT EXECUTE ON FUNCTION public.execute_tenant_read_sql_service(uuid, uuid, uuid, text, integer)
TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.execute_tenant_sql_governed_service(uuid, uuid, uuid, text, integer, text, text)
TO authenticated, service_role;
