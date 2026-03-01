-- expire_stale_waiting_approval_runs: called hourly by the connector worker.
--
-- When an approval_request reaches its expires_at deadline without a decision,
-- any agent_run that was paused waiting for that approval is permanently failed
-- with a clear error message. Without this, runs are silently stuck in
-- waiting_approval forever.
--
-- The agent_runs.output->>'approvalId' field is the FK to approval_requests.id
-- (stored as text/UUID by agentLoop.ts handleRunFailure).

CREATE OR REPLACE FUNCTION public.expire_stale_waiting_approval_runs(
  p_tenant_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired_approvals integer := 0;
  v_expired_runs      integer := 0;
  v_now               timestamptz := now();
BEGIN
  -- Step 1: Mark overdue pending approvals as expired.
  UPDATE public.approval_requests
  SET status = 'expired'
  WHERE lower(COALESCE(status, 'pending')) = 'pending'
    AND expires_at IS NOT NULL
    AND expires_at <= v_now
    AND (p_tenant_id IS NULL OR tenant_id = p_tenant_id);

  GET DIAGNOSTICS v_expired_approvals = ROW_COUNT;

  -- Step 2: Fail agent_runs whose linked approval is now expired.
  -- The link is: agent_runs.output->>'approvalId' = approval_requests.id::text
  WITH expired_runs AS (
    UPDATE public.agent_runs ar
    SET
      status       = 'failed',
      error        = 'Approval expired without a decision. Re-submit the request to try again.',
      completed_at = v_now
    WHERE ar.status = 'waiting_approval'
      AND (p_tenant_id IS NULL OR ar.tenant_id = p_tenant_id)
      AND ar.output IS NOT NULL
      AND ar.output ->> 'approvalId' IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.approval_requests ap
        WHERE ap.id = (ar.output ->> 'approvalId')::uuid
          AND lower(COALESCE(ap.status, '')) = 'expired'
      )
    RETURNING ar.id, ar.tenant_id
  )
  SELECT COUNT(*)::integer INTO v_expired_runs FROM expired_runs;

  -- Step 3: Also catch runs stuck in waiting_approval with no linked approval record
  -- (defensive — handles orphaned runs older than 48h).
  WITH orphaned_runs AS (
    UPDATE public.agent_runs ar
    SET
      status       = 'failed',
      error        = 'Approval request not found or expired. The run was automatically cleaned up.',
      completed_at = v_now
    WHERE ar.status = 'waiting_approval'
      AND (p_tenant_id IS NULL OR ar.tenant_id = p_tenant_id)
      AND ar.created_at <= (v_now - interval '48 hours')
    RETURNING ar.id
  )
  SELECT v_expired_runs + COUNT(*)::integer INTO v_expired_runs FROM orphaned_runs;

  RETURN jsonb_build_object(
    'expiredApprovals', v_expired_approvals,
    'expiredRuns',      v_expired_runs,
    'processedAt',      v_now
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.expire_stale_waiting_approval_runs(uuid) TO service_role;
