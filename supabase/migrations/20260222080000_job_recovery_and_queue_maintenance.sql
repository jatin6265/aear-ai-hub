-- Queue maintenance helpers: recover stale running jobs and requeue with bounded retry.

CREATE OR REPLACE FUNCTION public.recover_stale_connector_jobs(
  p_stale_minutes integer DEFAULT 20,
  p_batch integer DEFAULT 50
)
RETURNS TABLE (
  requeued_count integer,
  dead_letter_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stale_minutes integer := GREATEST(5, LEAST(COALESCE(p_stale_minutes, 20), 240));
  v_batch integer := GREATEST(1, LEAST(COALESCE(p_batch, 50), 500));
  v_requeued integer := 0;
  v_dead integer := 0;
BEGIN
  WITH stale AS (
    SELECT j.id, j.attempt_count, j.max_attempts
    FROM public.connector_jobs j
    WHERE j.status = 'running'
      AND COALESCE(j.started_at, j.updated_at, j.created_at) <= now() - make_interval(mins => v_stale_minutes)
    ORDER BY COALESCE(j.started_at, j.updated_at, j.created_at) ASC
    FOR UPDATE SKIP LOCKED
    LIMIT v_batch
  ),
  moved_dead AS (
    UPDATE public.connector_jobs j
    SET
      status = 'dead_letter',
      attempt_count = COALESCE(j.attempt_count, 0) + 1,
      finished_at = now(),
      last_error = COALESCE(j.last_error, 'Recovered stale running job; max attempts reached'),
      updated_at = now()
    FROM stale s
    WHERE j.id = s.id
      AND COALESCE(s.attempt_count, 0) + 1 >= COALESCE(s.max_attempts, 5)
    RETURNING j.id
  ),
  moved_queued AS (
    UPDATE public.connector_jobs j
    SET
      status = 'queued',
      attempt_count = COALESCE(j.attempt_count, 0) + 1,
      scheduled_at = now() + make_interval(secs => LEAST(900, ROUND(30 * power(2::numeric, GREATEST(0, COALESCE(j.attempt_count, 0)))::numeric)::integer)),
      started_at = NULL,
      finished_at = NULL,
      worker_id = NULL,
      last_error = COALESCE(j.last_error, 'Recovered stale running job; retry queued'),
      updated_at = now()
    FROM stale s
    WHERE j.id = s.id
      AND COALESCE(s.attempt_count, 0) + 1 < COALESCE(s.max_attempts, 5)
    RETURNING j.id
  )
  SELECT
    (SELECT COUNT(*)::integer FROM moved_queued),
    (SELECT COUNT(*)::integer FROM moved_dead)
  INTO v_requeued, v_dead;

  requeued_count := COALESCE(v_requeued, 0);
  dead_letter_count := COALESCE(v_dead, 0);
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.recover_stale_embedding_jobs(
  p_stale_minutes integer DEFAULT 20,
  p_batch integer DEFAULT 100
)
RETURNS TABLE (
  requeued_count integer,
  dead_letter_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stale_minutes integer := GREATEST(5, LEAST(COALESCE(p_stale_minutes, 20), 240));
  v_batch integer := GREATEST(1, LEAST(COALESCE(p_batch, 100), 1000));
  v_requeued integer := 0;
  v_dead integer := 0;
BEGIN
  WITH stale AS (
    SELECT e.id, e.attempt_count, e.max_attempts
    FROM public.embedding_jobs e
    WHERE e.status = 'running'
      AND COALESCE(e.started_at, e.updated_at, e.created_at) <= now() - make_interval(mins => v_stale_minutes)
    ORDER BY COALESCE(e.started_at, e.updated_at, e.created_at) ASC
    FOR UPDATE SKIP LOCKED
    LIMIT v_batch
  ),
  moved_dead AS (
    UPDATE public.embedding_jobs e
    SET
      status = 'dead_letter',
      attempt_count = COALESCE(e.attempt_count, 0) + 1,
      finished_at = now(),
      last_error = COALESCE(e.last_error, 'Recovered stale running embedding job; max attempts reached'),
      updated_at = now()
    FROM stale s
    WHERE e.id = s.id
      AND COALESCE(s.attempt_count, 0) + 1 >= COALESCE(s.max_attempts, 5)
    RETURNING e.id
  ),
  moved_queued AS (
    UPDATE public.embedding_jobs e
    SET
      status = 'queued',
      attempt_count = COALESCE(e.attempt_count, 0) + 1,
      scheduled_at = now() + make_interval(secs => LEAST(900, ROUND(30 * power(2::numeric, GREATEST(0, COALESCE(e.attempt_count, 0)))::numeric)::integer)),
      started_at = NULL,
      finished_at = NULL,
      worker_id = NULL,
      last_error = COALESCE(e.last_error, 'Recovered stale running embedding job; retry queued'),
      updated_at = now()
    FROM stale s
    WHERE e.id = s.id
      AND COALESCE(s.attempt_count, 0) + 1 < COALESCE(s.max_attempts, 5)
    RETURNING e.id
  )
  SELECT
    (SELECT COUNT(*)::integer FROM moved_queued),
    (SELECT COUNT(*)::integer FROM moved_dead)
  INTO v_requeued, v_dead;

  requeued_count := COALESCE(v_requeued, 0);
  dead_letter_count := COALESCE(v_dead, 0);
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.recover_stale_connector_jobs(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_stale_embedding_jobs(integer, integer) TO service_role;
