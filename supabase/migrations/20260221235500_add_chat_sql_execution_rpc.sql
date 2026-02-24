-- Read-only SQL execution RPC for chat tool pipeline.
-- Enforces tenant-bound connection ownership and blocks destructive SQL keywords.

CREATE OR REPLACE FUNCTION public.execute_tenant_read_sql(
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
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_sql text := trim(COALESCE(p_sql, ''));
  v_started_at timestamptz := clock_timestamp();
  v_rows jsonb := '[]'::jsonb;
  v_columns jsonb := '[]'::jsonb;
  v_error text := null;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000));
  v_exists boolean := false;
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
    WHERE c.id = p_connection_id
      AND c.tenant_id = v_tenant_id
      AND c.is_archived = false
  )
  INTO v_exists;

  IF NOT v_exists THEN
    RAISE EXCEPTION 'Connection not found for tenant';
  END IF;

  IF v_sql = '' THEN
    RAISE EXCEPTION 'SQL query is required';
  END IF;

  -- Multi-statement execution is not allowed.
  IF v_sql ~ ';' THEN
    RAISE EXCEPTION 'Only a single SQL statement is allowed';
  END IF;

  -- Only read-oriented statements are allowed.
  IF v_sql !~* '^\s*(select|with)\b' THEN
    RAISE EXCEPTION 'Only SELECT/WITH statements are allowed';
  END IF;

  -- Block potentially destructive or unsafe keywords.
  IF v_sql ~* '\m(insert|update|delete|drop|alter|truncate|create|grant|revoke|comment|copy|vacuum|analyze|refresh|set|reset|call|do)\M' THEN
    RAISE EXCEPTION 'Blocked by guardrails: write or administrative SQL is not allowed';
  END IF;

  -- Enforce a default LIMIT if omitted.
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

GRANT EXECUTE ON FUNCTION public.execute_tenant_read_sql(uuid, text, integer) TO authenticated;

