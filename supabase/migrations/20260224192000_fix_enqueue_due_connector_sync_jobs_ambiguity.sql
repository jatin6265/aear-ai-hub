CREATE OR REPLACE FUNCTION public.enqueue_due_connector_sync_jobs(
  p_limit integer DEFAULT 25,
  p_trigger_reason text DEFAULT 'scheduled_auto'
)
RETURNS TABLE (
  job_id uuid,
  tenant_id uuid,
  connection_id uuid,
  sync_frequency text,
  queue text,
  scheduled_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_role text := COALESCE(auth.role(), '');
  v_tenant_id uuid := public.get_user_tenant_id();
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 25), 200));
  v_trigger_reason text := COALESCE(NULLIF(trim(COALESCE(p_trigger_reason, '')), ''), 'scheduled_auto');
BEGIN
  IF v_role <> 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Authentication required';
    END IF;

    IF v_tenant_id IS NULL THEN
      RAISE EXCEPTION 'No tenant found for authenticated user';
    END IF;
  END IF;

  RETURN QUERY
  WITH due_connections AS (
    SELECT
      c.id,
      c.tenant_id,
      public.normalize_sync_frequency(c.sync_frequency) AS normalized_frequency,
      public.compute_next_sync_at(c.sync_frequency, now()) AS next_due_at,
      format(
        '%s:auto:%s',
        c.id::text,
        to_char(date_trunc('minute', now()), 'YYYYMMDDHH24MI')
      ) AS generated_idempotency_key
    FROM public.api_connections c
    WHERE c.is_archived = false
      AND c.status IN ('active', 'pending', 'error')
      AND COALESCE(c.next_sync_at, now()) <= now()
      AND (v_role = 'service_role' OR c.tenant_id = v_tenant_id)
      AND NOT EXISTS (
        SELECT 1
        FROM public.connector_jobs j
        WHERE j.connection_id = c.id
          AND j.queue = 'connector-sync'
          AND j.status IN ('queued', 'running')
      )
    ORDER BY c.next_sync_at NULLS FIRST, c.updated_at ASC
    LIMIT v_limit
  ),
  inserted_jobs AS (
    INSERT INTO public.connector_jobs (
      tenant_id,
      connection_id,
      job_type,
      queue,
      status,
      priority,
      idempotency_key,
      trigger_reason,
      payload,
      triggered_by,
      scheduled_at
    )
    SELECT
      d.tenant_id,
      d.id,
      'incremental_sync',
      'connector-sync',
      'queued',
      62,
      d.generated_idempotency_key,
      v_trigger_reason,
      jsonb_build_object(
        'source', 'sync_scheduler',
        'sync_frequency', d.normalized_frequency,
        'enqueued_at', now()
      ),
      CASE WHEN v_role = 'service_role' THEN NULL ELSE auth.uid() END,
      now()
    FROM due_connections d
    ON CONFLICT (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
    DO UPDATE SET
      payload = public.connector_jobs.payload || EXCLUDED.payload,
      priority = GREATEST(public.connector_jobs.priority, EXCLUDED.priority),
      updated_at = now()
    RETURNING
      public.connector_jobs.id,
      public.connector_jobs.tenant_id,
      public.connector_jobs.connection_id,
      public.connector_jobs.queue,
      public.connector_jobs.scheduled_at
  ),
  updated_connections AS (
    UPDATE public.api_connections c
    SET
      status = CASE WHEN c.status = 'error' THEN 'pending' ELSE c.status END,
      analysis_started_at = COALESCE(c.analysis_started_at, now()),
      next_sync_at = public.compute_next_sync_at(c.sync_frequency, now()),
      updated_at = now()
    FROM due_connections d
    WHERE c.id = d.id
      AND c.tenant_id = d.tenant_id
    RETURNING c.id
  )
  SELECT
    j.id AS job_id,
    j.tenant_id,
    j.connection_id,
    d.normalized_frequency AS sync_frequency,
    j.queue,
    j.scheduled_at
  FROM inserted_jobs j
  JOIN due_connections d
    ON d.id = j.connection_id
   AND d.tenant_id = j.tenant_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.enqueue_due_connector_sync_jobs(integer, text) TO authenticated, service_role;
