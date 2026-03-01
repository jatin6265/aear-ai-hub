-- Approval resume mechanism.
--
-- PROBLEM: When a high-risk tool call triggers ApprovalRequiredError, the agent run
-- is set to status='waiting_approval'. When an approver grants approval via the UI,
-- submit_approval_review_decision() generates an execution token — but nobody
-- re-enqueues the paused run. It stays stuck in waiting_approval forever.
--
-- FIX (two parts):
-- 1. resume_approved_agent_runs(): resets the agent_run_jobs back to 'queued'
--    so the worker picks it up again. Called from approvals-queue edge function.
-- 2. consume_approval_token_for_resource(): atomically checks if a valid, unused
--    execution token exists for a tenant+resource+action and marks it used.
--    Called from the governance wrapper before policy evaluation, so the re-run
--    of the same high-risk tool does NOT create a second approval request.

-- ─── 1. Resume approved agent runs ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.resume_approved_agent_runs(
  p_approval_request_id uuid
)
RETURNS TABLE (resumed_run_id uuid, reset_job_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH to_resume AS (
    -- Lock only the specific waiting runs tied to this approval.
    SELECT ar.id AS run_id, arj.id AS job_id
    FROM public.agent_runs ar
    JOIN public.agent_run_jobs arj ON arj.run_id = ar.id
    WHERE ar.pending_approval_id = p_approval_request_id
      AND ar.status = 'waiting_approval'
    FOR UPDATE OF ar, arj SKIP LOCKED
  ),
  updated_runs AS (
    UPDATE public.agent_runs
    SET
      status             = 'queued',
      pending_approval_id = NULL,
      updated_at         = now()
    FROM to_resume tr
    WHERE agent_runs.id = tr.run_id
    RETURNING agent_runs.id AS run_id
  ),
  reset_jobs AS (
    UPDATE public.agent_run_jobs
    SET
      status        = 'queued',
      worker_id     = NULL,
      started_at    = NULL,
      finished_at   = NULL,
      last_error    = NULL,
      result        = '{}'::jsonb,
      scheduled_at  = now(),
      attempt_count = attempt_count + 1,
      updated_at    = now()
    FROM to_resume tr
    WHERE agent_run_jobs.id = tr.job_id
    RETURNING agent_run_jobs.id AS job_id, agent_run_jobs.run_id
  )
  SELECT rj.run_id, rj.job_id FROM reset_jobs rj;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resume_approved_agent_runs(uuid) TO service_role;


-- ─── 2. Atomically consume an execution token ─────────────────────────────────

-- Returns TRUE if a valid pre-approved token was found and consumed for this
-- tenant+resource+action. The governance wrapper calls this before the standard
-- policy check. If it returns true, the wrapper skips the approval_required path,
-- executes the tool, and inserts a 'success_via_approval_token' audit log entry.

CREATE OR REPLACE FUNCTION public.consume_approval_token_for_resource(
  p_tenant_id uuid,
  p_resource   text,
  p_action     text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token_id uuid;
BEGIN
  SELECT aet.id
  INTO v_token_id
  FROM public.approval_execution_tokens aet
  JOIN public.approval_requests ar ON ar.id = aet.approval_request_id
  WHERE aet.tenant_id        = p_tenant_id
    AND aet.used_at          IS NULL
    AND aet.revoked_at       IS NULL
    AND aet.expires_at       > now()
    AND ar.status            = 'approved'
    AND lower(trim(ar.resource)) = lower(trim(COALESCE(p_resource, '')))
    AND lower(trim(ar.action))   = lower(trim(COALESCE(p_action, '')))
  ORDER BY aet.created_at DESC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_token_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.approval_execution_tokens
  SET used_at = now()
  WHERE id = v_token_id;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.consume_approval_token_for_resource(uuid, text, text) TO service_role;
