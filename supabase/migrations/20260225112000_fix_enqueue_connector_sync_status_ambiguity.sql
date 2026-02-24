-- Fix ambiguous `status` reference in enqueue_connector_sync.
-- The function returns a column named `status`, which clashes with api_connections.status
-- unless the table column is fully qualified in the UPDATE statement.

CREATE OR REPLACE FUNCTION public.enqueue_connector_sync(
  p_connection_id uuid,
  p_job_type text DEFAULT 'schema_discovery',
  p_trigger_reason text DEFAULT 'manual',
  p_priority integer DEFAULT 50,
  p_idempotency_key text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  job_id uuid,
  status text,
  queue text,
  scheduled_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_job_type text := lower(trim(COALESCE(p_job_type, 'schema_discovery')));
  v_job_id uuid;
  v_queue text := CASE WHEN v_job_type = 'embedding_refresh' THEN 'embeddings' ELSE 'connector-sync' END;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.api_connections c
    WHERE c.id = p_connection_id
      AND c.tenant_id = v_tenant_id
      AND c.is_archived = false
  ) THEN
    RAISE EXCEPTION 'Connection not found for tenant';
  END IF;

  IF v_job_type NOT IN ('schema_discovery', 'incremental_sync', 'full_sync', 'embedding_refresh') THEN
    v_job_type := 'schema_discovery';
  END IF;

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
    triggered_by
  )
  VALUES (
    v_tenant_id,
    p_connection_id,
    v_job_type,
    v_queue,
    'queued',
    GREATEST(1, LEAST(COALESCE(p_priority, 50), 100)),
    NULLIF(trim(COALESCE(p_idempotency_key, '')), ''),
    trim(COALESCE(p_trigger_reason, 'manual')),
    COALESCE(p_payload, '{}'::jsonb),
    auth.uid()
  )
  ON CONFLICT (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL
  DO UPDATE SET
    payload = EXCLUDED.payload,
    updated_at = now(),
    priority = EXCLUDED.priority
  RETURNING id, connector_jobs.status, connector_jobs.queue, connector_jobs.scheduled_at
  INTO v_job_id, status, queue, scheduled_at;

  UPDATE public.api_connections c
  SET
    status = CASE WHEN c.status = 'error' THEN 'pending' ELSE c.status END,
    analysis_started_at = COALESCE(c.analysis_started_at, now())
  WHERE c.id = p_connection_id
    AND c.tenant_id = v_tenant_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'connector.sync.enqueued',
    p_connection_id::text,
    'success',
    jsonb_build_object('job_id', v_job_id, 'job_type', v_job_type, 'queue', queue)
  );

  job_id := v_job_id;
  RETURN NEXT;
END;
$$;
