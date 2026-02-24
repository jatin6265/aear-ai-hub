-- Approvals queue completion: filters, expiry countdown, and governed decision workflow.

ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS action_summary text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

UPDATE public.approval_requests
SET action_summary = COALESCE(action_summary, NULLIF(params ->> 'summary', ''), action)
WHERE action_summary IS NULL;

UPDATE public.approval_requests
SET expires_at = COALESCE(expires_at, created_at + interval '24 hours')
WHERE expires_at IS NULL;

ALTER TABLE public.approval_requests
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '24 hours'),
  ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS approval_requests_tenant_status_created_idx
  ON public.approval_requests (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS approval_requests_tenant_expires_idx
  ON public.approval_requests (tenant_id, expires_at DESC);

CREATE OR REPLACE FUNCTION public.classify_approval_type(
  p_action text,
  p_resource text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN lower(COALESCE(p_action, '')) ~ '(delete|drop|remove|truncate|revoke|purge)'
      OR lower(COALESCE(p_resource, '')) ~ '(delete|drop|remove|truncate|revoke|purge)'
      THEN 'delete'
    WHEN lower(COALESCE(p_action, '')) ~ '(invoice|payment|finance|pricing|revenue|billing|refund|ledger)'
      OR lower(COALESCE(p_resource, '')) ~ '(invoice|payment|finance|pricing|revenue|billing|refund|ledger)'
      THEN 'financial'
    WHEN lower(COALESCE(p_action, '')) ~ '(report|export|analytics|insight|summary|query)'
      OR lower(COALESCE(p_resource, '')) ~ '(report|export|analytics|insight|summary|query)'
      THEN 'report'
    ELSE 'update'
  END;
$$;

CREATE OR REPLACE FUNCTION public.normalize_approval_status(p_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(COALESCE(p_status, 'pending'))
    WHEN 'denied' THEN 'rejected'
    WHEN 'rejected' THEN 'rejected'
    WHEN 'approved' THEN 'approved'
    WHEN 'expired' THEN 'expired'
    ELSE 'pending'
  END;
$$;

CREATE OR REPLACE FUNCTION public.get_approvals_queue_payload(
  p_status_filter text DEFAULT 'all',
  p_search text DEFAULT NULL,
  p_risk_filter text DEFAULT 'all',
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_user_role text := 'member';
  v_status_filter text := lower(trim(COALESCE(p_status_filter, 'all')));
  v_risk_filter text := lower(trim(COALESCE(p_risk_filter, 'all')));
  v_search text := NULLIF(trim(COALESCE(p_search, '')), '');
  v_is_accountable boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  SELECT lower(COALESCE(p.role, 'member'))
  INTO v_user_role
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.tenant_id = v_tenant_id;

  v_is_accountable := v_user_role IN ('owner', 'admin')
    OR EXISTS (
      SELECT 1
      FROM public.raci_matrix rm
      WHERE rm.tenant_id = v_tenant_id
        AND lower(COALESCE(rm.role_name, '')) = v_user_role
        AND upper(COALESCE(rm.raci_type, '')) = 'A'
    );

  IF v_status_filter NOT IN ('all', 'pending', 'approved', 'rejected', 'expired') THEN
    v_status_filter := 'all';
  END IF;

  IF v_risk_filter NOT IN ('all', 'low', 'medium', 'high', 'critical') THEN
    v_risk_filter := 'all';
  END IF;

  UPDATE public.approval_requests ar
  SET status = 'expired'
  WHERE ar.tenant_id = v_tenant_id
    AND public.normalize_approval_status(ar.status) = 'pending'
    AND ar.expires_at <= now();

  RETURN (
    WITH base AS (
      SELECT
        ar.id,
        public.classify_approval_type(ar.action, ar.resource) AS type,
        COALESCE(NULLIF(ar.action_summary, ''), NULLIF(ar.params ->> 'summary', ''), ar.action) AS action_summary,
        ar.action,
        ar.resource,
        lower(COALESCE(ar.risk_level, 'medium')) AS risk_level,
        public.normalize_approval_status(ar.status) AS status,
        ar.created_at,
        ar.expires_at,
        GREATEST(EXTRACT(EPOCH FROM (ar.expires_at - now()))::integer, 0) AS expires_in_seconds,
        ar.requested_by,
        ar.decided_by,
        ar.decided_at,
        ar.params,
        ar.simulation_preview,
        COALESCE(NULLIF(trim(req_profile.full_name), ''), split_part(COALESCE(req_user.email, ''), '@', 1), 'Unknown user') AS requested_by_name,
        COALESCE(req_profile.role, 'member') AS requested_by_role,
        COALESCE(NULLIF(trim(dec_profile.full_name), ''), split_part(COALESCE(dec_user.email, ''), '@', 1), NULL) AS decided_by_name,
        (
          public.normalize_approval_status(ar.status) = 'pending'
          AND (
            v_user_role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1
              FROM public.raci_matrix rm
              WHERE rm.tenant_id = v_tenant_id
                AND lower(COALESCE(rm.resource, '')) = lower(COALESCE(ar.resource, ''))
                AND lower(COALESCE(rm.action, '')) = lower(COALESCE(ar.action, ''))
                AND lower(COALESCE(rm.role_name, '')) = v_user_role
                AND upper(COALESCE(rm.raci_type, '')) = 'A'
            )
          )
        ) AS can_review,
        (
          EXISTS (
            SELECT 1
            FROM public.raci_matrix rm
            WHERE rm.tenant_id = v_tenant_id
              AND lower(COALESCE(rm.resource, '')) = lower(COALESCE(ar.resource, ''))
              AND lower(COALESCE(rm.action, '')) = lower(COALESCE(ar.action, ''))
              AND lower(COALESCE(rm.role_name, '')) = v_user_role
              AND upper(COALESCE(rm.raci_type, '')) = 'R'
          )
          OR ar.requested_by = auth.uid()
        ) AS is_responsible
      FROM public.approval_requests ar
      LEFT JOIN public.profiles req_profile ON req_profile.id = ar.requested_by
      LEFT JOIN auth.users req_user ON req_user.id = ar.requested_by
      LEFT JOIN public.profiles dec_profile ON dec_profile.id = ar.decided_by
      LEFT JOIN auth.users dec_user ON dec_user.id = ar.decided_by
      WHERE ar.tenant_id = v_tenant_id
    ),
    prefiltered AS (
      SELECT *
      FROM base
      WHERE
        (
          v_search IS NULL
          OR action_summary ILIKE ('%' || v_search || '%')
          OR action ILIKE ('%' || v_search || '%')
          OR resource ILIKE ('%' || v_search || '%')
          OR requested_by_name ILIKE ('%' || v_search || '%')
        )
        AND (
          v_risk_filter = 'all'
          OR risk_level = v_risk_filter
        )
        AND (
          p_date_from IS NULL
          OR created_at::date >= p_date_from
        )
        AND (
          p_date_to IS NULL
          OR created_at::date <= p_date_to
        )
    ),
    filtered AS (
      SELECT *
      FROM prefiltered
      WHERE
        v_status_filter = 'all'
        OR status = v_status_filter
    ),
    counts AS (
      SELECT
        COUNT(*)::integer AS all_count,
        COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending_count,
        COUNT(*) FILTER (WHERE status = 'approved')::integer AS approved_count,
        COUNT(*) FILTER (WHERE status = 'rejected')::integer AS rejected_count,
        COUNT(*) FILTER (WHERE status = 'expired')::integer AS expired_count,
        COUNT(*) FILTER (WHERE status = 'pending' AND can_review)::integer AS pending_needing_decision
      FROM prefiltered
    )
    SELECT jsonb_build_object(
      'profileRole', v_user_role,
      'isAccountable', v_is_accountable,
      'counts', jsonb_build_object(
        'all', counts.all_count,
        'pending', counts.pending_count,
        'approved', counts.approved_count,
        'rejected', counts.rejected_count,
        'expired', counts.expired_count
      ),
      'pendingNeedingDecision', counts.pending_needing_decision,
      'rows', COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', f.id,
              'type', f.type,
              'actionSummary', f.action_summary,
              'action', f.action,
              'resource', f.resource,
              'riskLevel', f.risk_level,
              'status', f.status,
              'requestedAt', f.created_at,
              'expiresAt', f.expires_at,
              'expiresInSeconds', CASE WHEN f.status = 'pending' THEN f.expires_in_seconds ELSE NULL END,
              'requestedById', f.requested_by,
              'requestedByName', f.requested_by_name,
              'requestedByRole', f.requested_by_role,
              'decidedById', f.decided_by,
              'decidedByName', f.decided_by_name,
              'decidedAt', f.decided_at,
              'canReview', f.can_review,
              'isResponsible', f.is_responsible,
              'params', f.params,
              'simulationPreview', f.simulation_preview
            )
            ORDER BY
              (CASE WHEN f.status = 'pending' THEN 0 ELSE 1 END) ASC,
              (CASE f.risk_level WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END) ASC,
              f.created_at DESC
          )
          FROM filtered f
        ),
        '[]'::jsonb
      )
    )
    FROM counts
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.decide_approval_request_queue(
  p_request_id uuid,
  p_decision text,
  p_note text DEFAULT NULL
)
RETURNS TABLE (
  status text,
  decided_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_user_role text := 'member';
  v_decision text := lower(trim(COALESCE(p_decision, '')));
  v_request public.approval_requests%ROWTYPE;
  v_can_review boolean := false;
  v_note text := NULLIF(trim(COALESCE(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'approvalId is required';
  END IF;

  IF v_decision = 'denied' THEN
    v_decision := 'rejected';
  END IF;

  IF v_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Decision must be approved or rejected';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  SELECT lower(COALESCE(p.role, 'member'))
  INTO v_user_role
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.tenant_id = v_tenant_id;

  SELECT *
  INTO v_request
  FROM public.approval_requests ar
  WHERE ar.id = p_request_id
    AND ar.tenant_id = v_tenant_id
  FOR UPDATE;

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'Approval request not found';
  END IF;

  IF public.normalize_approval_status(v_request.status) <> 'pending' THEN
    RAISE EXCEPTION 'Approval request is already decided';
  END IF;

  IF v_request.expires_at <= now() THEN
    UPDATE public.approval_requests
    SET status = 'expired'
    WHERE id = p_request_id
      AND tenant_id = v_tenant_id;

    RAISE EXCEPTION 'Approval request has expired';
  END IF;

  v_can_review := (
    v_user_role IN ('owner', 'admin')
    OR EXISTS (
      SELECT 1
      FROM public.raci_matrix rm
      WHERE rm.tenant_id = v_tenant_id
        AND lower(COALESCE(rm.resource, '')) = lower(COALESCE(v_request.resource, ''))
        AND lower(COALESCE(rm.action, '')) = lower(COALESCE(v_request.action, ''))
        AND lower(COALESCE(rm.role_name, '')) = v_user_role
        AND upper(COALESCE(rm.raci_type, '')) = 'A'
    )
  );

  IF NOT v_can_review THEN
    RAISE EXCEPTION 'Only accountable users can decide this approval';
  END IF;

  UPDATE public.approval_requests ar
  SET
    status = v_decision,
    decided_by = auth.uid(),
    decided_at = now(),
    params = COALESCE(ar.params, '{}'::jsonb) || jsonb_build_object(
      'decision_note', v_note,
      'decision_source', 'approvals_queue'
    )
  WHERE ar.id = p_request_id
    AND ar.tenant_id = v_tenant_id
  RETURNING ar.status, ar.decided_at
  INTO status, decided_at;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, risk_level, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'approval.queue.decide',
    COALESCE(v_request.resource, 'approval_requests'),
    COALESCE(v_request.risk_level, 'medium'),
    status,
    jsonb_build_object(
      'request_id', p_request_id,
      'decision', status,
      'note', v_note,
      'action', v_request.action
    )
  );

  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.classify_approval_type(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_approval_status(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_approvals_queue_payload(text, text, text, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_approval_request_queue(uuid, text, text) TO authenticated;
