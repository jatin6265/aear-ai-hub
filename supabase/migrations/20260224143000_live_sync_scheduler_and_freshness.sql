-- Live sync scheduler + frequency normalization + next sync tracking

ALTER TABLE public.api_connections
  ADD COLUMN IF NOT EXISTS next_sync_at timestamptz;

CREATE OR REPLACE FUNCTION public.normalize_sync_frequency(p_frequency text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_frequency text := lower(trim(COALESCE(p_frequency, 'hourly')));
BEGIN
  IF v_frequency IN ('5m', '5min', '5minute', '5minutes') THEN
    RETURN '5min';
  END IF;

  IF v_frequency IN ('realtime', 'real-time', 'real_time') THEN
    RETURN 'realtime';
  END IF;

  IF v_frequency IN ('daily', 'day') THEN
    RETURN 'daily';
  END IF;

  IF v_frequency IN ('hourly', 'hour') THEN
    RETURN 'hourly';
  END IF;

  RETURN 'hourly';
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_frequency_interval(p_frequency text)
RETURNS interval
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_frequency text := public.normalize_sync_frequency(p_frequency);
BEGIN
  IF v_frequency = 'realtime' THEN
    RETURN interval '1 minute';
  END IF;

  IF v_frequency = '5min' THEN
    RETURN interval '5 minutes';
  END IF;

  IF v_frequency = 'daily' THEN
    RETURN interval '1 day';
  END IF;

  RETURN interval '1 hour';
END;
$$;

CREATE OR REPLACE FUNCTION public.compute_next_sync_at(
  p_sync_frequency text DEFAULT 'hourly',
  p_base_at timestamptz DEFAULT now()
)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(p_base_at, now()) + public.sync_frequency_interval(p_sync_frequency);
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'api_connections_sync_frequency_check'
      AND conrelid = 'public.api_connections'::regclass
  ) THEN
    ALTER TABLE public.api_connections
      DROP CONSTRAINT api_connections_sync_frequency_check;
  END IF;
END;
$$;

UPDATE public.api_connections
SET sync_frequency = public.normalize_sync_frequency(sync_frequency)
WHERE sync_frequency IS DISTINCT FROM public.normalize_sync_frequency(sync_frequency);

ALTER TABLE public.api_connections
  ADD CONSTRAINT api_connections_sync_frequency_check
  CHECK (sync_frequency IN ('realtime', '5min', '5m', 'hourly', 'daily'));

CREATE OR REPLACE FUNCTION public.api_connections_apply_sync_defaults()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.sync_frequency := public.normalize_sync_frequency(NEW.sync_frequency);

  IF TG_OP = 'INSERT' THEN
    IF NEW.next_sync_at IS NULL THEN
      NEW.next_sync_at := public.compute_next_sync_at(
        NEW.sync_frequency,
        COALESCE(NEW.last_synced_at, NEW.analysis_completed_at, NEW.analysis_started_at, NEW.created_at, now())
      );
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.sync_frequency IS DISTINCT FROM OLD.sync_frequency THEN
    NEW.next_sync_at := public.compute_next_sync_at(NEW.sync_frequency, now());
  ELSIF NEW.last_synced_at IS DISTINCT FROM OLD.last_synced_at THEN
    NEW.next_sync_at := public.compute_next_sync_at(NEW.sync_frequency, COALESCE(NEW.last_synced_at, now()));
    NEW.sync_lag_seconds := 0;
  ELSIF NEW.next_sync_at IS NULL THEN
    NEW.next_sync_at := public.compute_next_sync_at(NEW.sync_frequency, now());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS api_connections_apply_sync_defaults ON public.api_connections;
CREATE TRIGGER api_connections_apply_sync_defaults
BEFORE INSERT OR UPDATE OF sync_frequency, last_synced_at, next_sync_at
ON public.api_connections
FOR EACH ROW
EXECUTE FUNCTION public.api_connections_apply_sync_defaults();

UPDATE public.api_connections
SET next_sync_at = public.compute_next_sync_at(
  sync_frequency,
  COALESCE(last_synced_at, analysis_completed_at, analysis_started_at, created_at, now())
)
WHERE next_sync_at IS NULL;

CREATE INDEX IF NOT EXISTS api_connections_tenant_next_sync_idx
  ON public.api_connections (tenant_id, next_sync_at)
  WHERE is_archived = false;

CREATE INDEX IF NOT EXISTS connector_jobs_connection_status_scheduled_idx
  ON public.connector_jobs (connection_id, status, scheduled_at DESC);

CREATE OR REPLACE FUNCTION public.set_connection_next_sync_at(
  p_connection_id uuid,
  p_base_at timestamptz DEFAULT now()
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := COALESCE(auth.role(), '');
  v_tenant_id uuid := public.get_user_tenant_id();
  v_next_sync timestamptz;
BEGIN
  IF v_role <> 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Authentication required';
    END IF;

    IF v_tenant_id IS NULL THEN
      RAISE EXCEPTION 'No tenant found for authenticated user';
    END IF;
  END IF;

  UPDATE public.api_connections c
  SET
    sync_frequency = public.normalize_sync_frequency(c.sync_frequency),
    next_sync_at = public.compute_next_sync_at(c.sync_frequency, COALESCE(p_base_at, now())),
    updated_at = now()
  WHERE c.id = p_connection_id
    AND (v_role = 'service_role' OR c.tenant_id = v_tenant_id)
  RETURNING c.next_sync_at
  INTO v_next_sync;

  IF v_next_sync IS NULL THEN
    RAISE EXCEPTION 'Connection not found';
  END IF;

  RETURN v_next_sync;
END;
$$;

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

GRANT EXECUTE ON FUNCTION public.normalize_sync_frequency(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sync_frequency_interval(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.compute_next_sync_at(text, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_connection_next_sync_at(uuid, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_due_connector_sync_jobs(integer, text) TO authenticated, service_role;
