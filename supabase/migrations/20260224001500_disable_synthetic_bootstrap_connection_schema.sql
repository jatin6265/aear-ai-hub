CREATE OR REPLACE FUNCTION public.bootstrap_connection_schema(p_connection_id uuid)
RETURNS TABLE (
  entities_count integer,
  columns_count integer,
  relationships_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_connection_name text;
  v_job_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT c.name
  INTO v_connection_name
  FROM public.api_connections c
  WHERE c.id = p_connection_id
    AND c.tenant_id = v_tenant_id
    AND c.is_archived = false;

  IF v_connection_name IS NULL THEN
    RAISE EXCEPTION 'Connection not found for tenant';
  END IF;

  SELECT q.job_id
  INTO v_job_id
  FROM public.enqueue_connector_sync(
    p_connection_id,
    'schema_discovery',
    'bootstrap_rpc',
    80,
    format('%s:bootstrap_rpc:%s', p_connection_id::text, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint),
    jsonb_build_object('source', 'bootstrap_connection_schema')
  ) AS q
  LIMIT 1;

  UPDATE public.api_connections
  SET
    status = 'syncing',
    analysis_started_at = now(),
    last_error = NULL
  WHERE id = p_connection_id
    AND tenant_id = v_tenant_id;

  IF NOT EXISTS (
    SELECT 1
    FROM public.connection_sync_runs sr
    WHERE sr.tenant_id = v_tenant_id
      AND sr.connection_id = p_connection_id
      AND sr.status = 'running'
  ) THEN
    INSERT INTO public.connection_sync_runs (
      tenant_id,
      connection_id,
      triggered_by,
      status,
      started_at,
      details
    )
    VALUES (
      v_tenant_id,
      p_connection_id,
      auth.uid(),
      'running',
      now(),
      jsonb_build_object('stage', 'schema_discovery_queued', 'job_id', v_job_id, 'source', 'bootstrap_connection_schema')
    );
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'connection.schema.discovery.queued',
    v_connection_name,
    'success',
    jsonb_build_object('job_id', v_job_id, 'source', 'bootstrap_connection_schema')
  );

  entities_count := 0;
  columns_count := 0;
  relationships_count := 0;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.bootstrap_connection_schema(uuid) TO authenticated;
