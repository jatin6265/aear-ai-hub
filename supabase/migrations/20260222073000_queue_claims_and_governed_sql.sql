-- Queue claim RPCs for worker leasing + governed SQL execution wrapper.

CREATE OR REPLACE FUNCTION public.claim_connector_jobs(
  p_worker_id text,
  p_limit integer DEFAULT 3,
  p_queues text[] DEFAULT NULL
)
RETURNS TABLE (
  job_id uuid,
  tenant_id uuid,
  connection_id uuid,
  job_type text,
  queue text,
  payload jsonb,
  attempt_count integer,
  max_attempts integer,
  started_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_worker_id text := NULLIF(trim(COALESCE(p_worker_id, '')), '');
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 3), 25));
BEGIN
  IF v_worker_id IS NULL THEN
    RAISE EXCEPTION 'Worker id is required';
  END IF;

  RETURN QUERY
  WITH selected AS (
    SELECT j.id
    FROM public.connector_jobs j
    WHERE j.status = 'queued'
      AND j.scheduled_at <= now()
      AND (
        p_queues IS NULL
        OR array_length(p_queues, 1) IS NULL
        OR j.queue = ANY (p_queues)
      )
    ORDER BY j.priority DESC, j.scheduled_at ASC, j.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  ),
  claimed AS (
    UPDATE public.connector_jobs j
    SET
      status = 'running',
      worker_id = v_worker_id,
      started_at = COALESCE(j.started_at, now()),
      last_error = NULL,
      updated_at = now()
    WHERE j.id IN (SELECT id FROM selected)
    RETURNING
      j.id,
      j.tenant_id,
      j.connection_id,
      j.job_type,
      j.queue,
      j.payload,
      j.attempt_count,
      j.max_attempts,
      j.started_at
  )
  SELECT
    c.id,
    c.tenant_id,
    c.connection_id,
    c.job_type,
    c.queue,
    c.payload,
    c.attempt_count,
    c.max_attempts,
    c.started_at
  FROM claimed c;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_embedding_jobs(
  p_worker_id text,
  p_limit integer DEFAULT 5
)
RETURNS TABLE (
  job_id uuid,
  tenant_id uuid,
  source_type text,
  source_id uuid,
  embedding_model text,
  payload jsonb,
  attempt_count integer,
  max_attempts integer,
  started_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_worker_id text := NULLIF(trim(COALESCE(p_worker_id, '')), '');
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 5), 40));
BEGIN
  IF v_worker_id IS NULL THEN
    RAISE EXCEPTION 'Worker id is required';
  END IF;

  RETURN QUERY
  WITH selected AS (
    SELECT e.id
    FROM public.embedding_jobs e
    WHERE e.status = 'queued'
      AND e.scheduled_at <= now()
    ORDER BY e.priority DESC, e.scheduled_at ASC, e.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  ),
  claimed AS (
    UPDATE public.embedding_jobs e
    SET
      status = 'running',
      worker_id = v_worker_id,
      started_at = COALESCE(e.started_at, now()),
      last_error = NULL,
      updated_at = now()
    WHERE e.id IN (SELECT id FROM selected)
    RETURNING
      e.id,
      e.tenant_id,
      e.source_type,
      e.source_id,
      e.embedding_model,
      e.payload,
      e.attempt_count,
      e.max_attempts,
      e.started_at
  )
  SELECT
    c.id,
    c.tenant_id,
    c.source_type,
    c.source_id,
    c.embedding_model,
    c.payload,
    c.attempt_count,
    c.max_attempts,
    c.started_at
  FROM claimed c;
END;
$$;

CREATE OR REPLACE FUNCTION public.execute_tenant_sql_governed(
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
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_sql = '' THEN
    RAISE EXCEPTION 'SQL query is required';
  END IF;

  v_requires_write := v_sql ~* '\m(insert|update|delete|drop|alter|truncate|create|grant|revoke|comment|copy|vacuum|analyze|refresh|set|reset|call|do)\M';

  SELECT *
  INTO v_policy
  FROM public.evaluate_action_policy(
    COALESCE(NULLIF(trim(p_resource), ''), 'chat_sql_execution'),
    COALESCE(NULLIF(trim(p_action), ''), 'sql_query'),
    CASE WHEN v_requires_write THEN 'high' ELSE 'low' END,
    v_requires_write
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
  FROM public.execute_tenant_read_sql(
    p_connection_id => p_connection_id,
    p_sql => v_sql,
    p_limit => p_limit
  ) q;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_connector_jobs(text, integer, text[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_embedding_jobs(text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.execute_tenant_sql_governed(uuid, text, integer, text, text) TO authenticated;
