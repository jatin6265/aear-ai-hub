CREATE OR REPLACE FUNCTION public.raci_action_candidates(p_action text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY(
    SELECT DISTINCT candidate
    FROM unnest(
      ARRAY[
        NULLIF(lower(trim(COALESCE(p_action, ''))), ''),
        NULLIF(regexp_replace(lower(trim(COALESCE(p_action, ''))), '^.*[\.:/_-]', ''), ''),
        'execute'
      ]
    ) AS candidate
    WHERE candidate IS NOT NULL
      AND candidate <> ''
  );
$$;

CREATE OR REPLACE FUNCTION public.get_effective_role_names(
  p_tenant_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ctx AS (
    SELECT
      COALESCE(p_tenant_id, public.get_user_tenant_id()) AS tenant_id,
      COALESCE(p_user_id, auth.uid()) AS user_id
  ),
  roles AS (
    SELECT lower(trim(COALESCE(p.role, 'member'))) AS role_name
    FROM ctx
    JOIN public.profiles p
      ON p.id = ctx.user_id
     AND p.tenant_id = ctx.tenant_id
     AND COALESCE(p.status, 'active') = 'active'
    UNION
    SELECT lower(trim(rr.name)) AS role_name
    FROM ctx
    JOIN public.raci_role_members rrm
      ON rrm.tenant_id = ctx.tenant_id
     AND rrm.profile_id = ctx.user_id
    JOIN public.raci_roles rr
      ON rr.id = rrm.role_id
     AND rr.tenant_id = ctx.tenant_id
  )
  SELECT COALESCE(
    ARRAY(
      SELECT DISTINCT r.role_name
      FROM roles r
      WHERE r.role_name <> ''
    ),
    ARRAY['member'::text]
  );
$$;

CREATE OR REPLACE FUNCTION public.resolve_user_raci_context(
  p_resource text,
  p_action text,
  p_tenant_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE (
  profile_role text,
  effective_roles text[],
  matched_raci_type text,
  can_execute boolean,
  can_approve boolean,
  is_consulted boolean,
  matched_roles text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := COALESCE(p_tenant_id, public.get_user_tenant_id());
  v_user_id uuid := COALESCE(p_user_id, auth.uid());
  v_profile_role text := 'member';
  v_effective_roles text[] := ARRAY['member'::text];
  v_action_candidates text[] := public.raci_action_candidates(p_action);
  v_matched_raci_type text := NULL;
  v_matched_roles text[] := ARRAY[]::text[];
BEGIN
  IF auth.uid() IS NULL AND current_setting('request.jwt.claim.role', true) <> 'service_role' THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context available';
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No user context available';
  END IF;

  SELECT lower(COALESCE(p.role, 'member'))
  INTO v_profile_role
  FROM public.profiles p
  WHERE p.id = v_user_id
    AND p.tenant_id = v_tenant_id
    AND COALESCE(p.status, 'active') = 'active'
  LIMIT 1;

  v_effective_roles := public.get_effective_role_names(v_tenant_id, v_user_id);
  IF COALESCE(array_length(v_effective_roles, 1), 0) = 0 THEN
    v_effective_roles := ARRAY[COALESCE(v_profile_role, 'member')];
  END IF;

  WITH matched AS (
    SELECT
      upper(COALESCE(rm.raci_type, '')) AS raci_type,
      lower(trim(COALESCE(rm.role_name, ''))) AS role_name
    FROM public.raci_matrix rm
    WHERE rm.tenant_id = v_tenant_id
      AND lower(trim(COALESCE(rm.resource, ''))) = lower(trim(COALESCE(p_resource, '')))
      AND lower(trim(COALESCE(rm.action, 'execute'))) = ANY(v_action_candidates)
      AND lower(trim(COALESCE(rm.role_name, ''))) = ANY(v_effective_roles)
      AND upper(COALESCE(rm.raci_type, '')) IN ('R', 'A', 'C', 'I')
  ),
  selected AS (
    SELECT m.raci_type
    FROM matched m
    ORDER BY CASE m.raci_type
      WHEN 'A' THEN 1
      WHEN 'R' THEN 2
      WHEN 'C' THEN 3
      WHEN 'I' THEN 4
      ELSE 5
    END
    LIMIT 1
  )
  SELECT
    s.raci_type,
    COALESCE((
      SELECT ARRAY_AGG(DISTINCT m.role_name)
      FROM matched m
      WHERE m.raci_type = s.raci_type
    ), ARRAY[]::text[])
  INTO v_matched_raci_type, v_matched_roles
  FROM selected s;

  profile_role := COALESCE(v_profile_role, 'member');
  effective_roles := v_effective_roles;
  matched_raci_type := v_matched_raci_type;
  can_execute := COALESCE(v_matched_raci_type IN ('R', 'A'), false);
  can_approve := COALESCE(v_matched_raci_type = 'A', false);
  is_consulted := COALESCE(v_matched_raci_type IN ('C', 'I'), true);
  matched_roles := v_matched_roles;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_approval_reviewer_for_action(
  p_tenant_id uuid,
  p_resource text,
  p_action text DEFAULT 'execute',
  p_exclude_user_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  full_name text,
  role_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_tenant_id uuid := COALESCE(p_tenant_id, public.get_user_tenant_id());
  v_action_candidates text[] := public.raci_action_candidates(p_action);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    COALESCE(NULLIF(trim(p.full_name), ''), split_part(COALESCE(u.email, ''), '@', 1), 'Approver') AS full_name,
    lower(trim(rr.name)) AS role_name
  FROM public.profiles p
  LEFT JOIN auth.users u
    ON u.id = p.id
  JOIN public.raci_role_members rrm
    ON rrm.tenant_id = v_tenant_id
   AND rrm.profile_id = p.id
  JOIN public.raci_roles rr
    ON rr.id = rrm.role_id
   AND rr.tenant_id = v_tenant_id
  JOIN public.raci_matrix rm
    ON rm.tenant_id = v_tenant_id
   AND lower(trim(COALESCE(rm.role_name, ''))) = lower(trim(COALESCE(rr.name, '')))
   AND lower(trim(COALESCE(rm.resource, ''))) = lower(trim(COALESCE(p_resource, '')))
   AND lower(trim(COALESCE(rm.action, 'execute'))) = ANY(v_action_candidates)
   AND upper(COALESCE(rm.raci_type, '')) = 'A'
  WHERE p.tenant_id = v_tenant_id
    AND COALESCE(p.status, 'active') = 'active'
    AND (p_exclude_user_id IS NULL OR p.id <> p_exclude_user_id)
  ORDER BY p.created_at ASC
  LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.evaluate_action_policy(
  p_resource text,
  p_action text,
  p_risk_level text DEFAULT 'low',
  p_requires_write boolean DEFAULT false
)
RETURNS TABLE (
  allow boolean,
  approval_required boolean,
  reason text,
  matched_rule jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_risk text := lower(trim(COALESCE(p_risk_level, 'low')));
  v_blocked_by_guardrail boolean := false;
  v_ctx record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  SELECT *
  INTO v_ctx
  FROM public.resolve_user_raci_context(
    p_resource => COALESCE(NULLIF(trim(p_resource), ''), 'chat_sql_execution'),
    p_action => COALESCE(NULLIF(trim(p_action), ''), 'execute'),
    p_tenant_id => v_tenant_id,
    p_user_id => auth.uid()
  )
  LIMIT 1;

  SELECT EXISTS (
    SELECT 1
    FROM public.guardrails g
    WHERE g.tenant_id = v_tenant_id
      AND g.enabled = true
      AND (
        lower(g.risk_level) = 'critical'
        OR (lower(g.risk_level) = 'high' AND v_risk IN ('high', 'critical'))
      )
      AND (
        COALESCE((g.config -> 'blocked_actions') ? lower(trim(COALESCE(p_action, ''))), false)
        OR COALESCE((g.config -> 'blocked_resources') ? lower(trim(COALESCE(p_resource, ''))), false)
      )
  ) INTO v_blocked_by_guardrail;

  approval_required := p_requires_write OR v_risk IN ('high', 'critical');

  IF v_blocked_by_guardrail THEN
    allow := false;
    reason := 'Blocked by guardrail policy';
  ELSIF COALESCE(v_ctx.can_execute, false) THEN
    allow := true;
    reason := 'Allowed by effective RACI assignment';
  ELSIF NOT p_requires_write AND v_risk IN ('low', 'medium') THEN
    allow := true;
    reason := 'Read-safe action allowed';
  ELSE
    allow := false;
    reason := 'No matching effective RACI assignment';
  END IF;

  matched_rule := jsonb_build_object(
    'profile_role', COALESCE(v_ctx.profile_role, 'member'),
    'effective_roles', COALESCE(to_jsonb(v_ctx.effective_roles), '[]'::jsonb),
    'matched_roles', COALESCE(to_jsonb(v_ctx.matched_roles), '[]'::jsonb),
    'matched_raci_type', COALESCE(v_ctx.matched_raci_type, 'none'),
    'can_execute', COALESCE(v_ctx.can_execute, false),
    'can_approve', COALESCE(v_ctx.can_approve, false),
    'resource', lower(trim(COALESCE(p_resource, ''))),
    'action', lower(trim(COALESCE(p_action, ''))),
    'risk', v_risk,
    'guardrail_block', v_blocked_by_guardrail
  );

  RETURN NEXT;
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
  v_profile_role text := 'member';
  v_effective_roles text[] := ARRAY['member'::text];
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
  INTO v_profile_role
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.tenant_id = v_tenant_id
    AND COALESCE(p.status, 'active') = 'active';

  v_effective_roles := public.get_effective_role_names(v_tenant_id, auth.uid());

  v_is_accountable := EXISTS (
    SELECT 1
    FROM public.raci_matrix rm
    WHERE rm.tenant_id = v_tenant_id
      AND lower(COALESCE(rm.role_name, '')) = ANY(v_effective_roles)
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
          AND EXISTS (
            SELECT 1
            FROM public.raci_matrix rm
            WHERE rm.tenant_id = v_tenant_id
              AND lower(COALESCE(rm.resource, '')) = lower(COALESCE(ar.resource, ''))
              AND lower(COALESCE(rm.action, 'execute')) = ANY(public.raci_action_candidates(ar.action))
              AND lower(COALESCE(rm.role_name, '')) = ANY(v_effective_roles)
              AND upper(COALESCE(rm.raci_type, '')) = 'A'
          )
        ) AS can_review,
        (
          EXISTS (
            SELECT 1
            FROM public.raci_matrix rm
            WHERE rm.tenant_id = v_tenant_id
              AND lower(COALESCE(rm.resource, '')) = lower(COALESCE(ar.resource, ''))
              AND lower(COALESCE(rm.action, 'execute')) = ANY(public.raci_action_candidates(ar.action))
              AND lower(COALESCE(rm.role_name, '')) = ANY(v_effective_roles)
              AND upper(COALESCE(rm.raci_type, '')) IN ('R', 'A')
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
      'profileRole', v_profile_role,
      'effectiveRoles', COALESCE(to_jsonb(v_effective_roles), '[]'::jsonb),
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
  v_effective_roles text[] := ARRAY['member'::text];
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

  v_effective_roles := public.get_effective_role_names(v_tenant_id, auth.uid());

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

  v_can_review := EXISTS (
    SELECT 1
    FROM public.raci_matrix rm
    WHERE rm.tenant_id = v_tenant_id
      AND lower(COALESCE(rm.resource, '')) = lower(COALESCE(v_request.resource, ''))
      AND lower(COALESCE(rm.action, 'execute')) = ANY(public.raci_action_candidates(v_request.action))
      AND lower(COALESCE(rm.role_name, '')) = ANY(v_effective_roles)
      AND upper(COALESCE(rm.raci_type, '')) = 'A'
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
      'action', v_request.action,
      'effective_roles', v_effective_roles
    )
  );

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.decide_approval_request(
  p_request_id uuid,
  p_decision text
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
  v_new_status text;
  v_request public.approval_requests%ROWTYPE;
  v_effective_roles text[] := ARRAY['member'::text];
  v_can_review boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  v_new_status := lower(trim(COALESCE(p_decision, '')));
  IF v_new_status = 'denied' THEN
    v_new_status := 'rejected';
  END IF;
  IF v_new_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Decision must be approved or rejected';
  END IF;

  SELECT *
  INTO v_request
  FROM public.approval_requests ar
  WHERE ar.id = p_request_id
    AND ar.tenant_id = v_tenant_id
    AND public.normalize_approval_status(ar.status) = 'pending'
  FOR UPDATE;

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'Approval request not found or already decided';
  END IF;

  v_effective_roles := public.get_effective_role_names(v_tenant_id, auth.uid());
  v_can_review := EXISTS (
    SELECT 1
    FROM public.raci_matrix rm
    WHERE rm.tenant_id = v_tenant_id
      AND lower(COALESCE(rm.resource, '')) = lower(COALESCE(v_request.resource, ''))
      AND lower(COALESCE(rm.action, 'execute')) = ANY(public.raci_action_candidates(v_request.action))
      AND lower(COALESCE(rm.role_name, '')) = ANY(v_effective_roles)
      AND upper(COALESCE(rm.raci_type, '')) = 'A'
  );

  IF NOT v_can_review THEN
    RAISE EXCEPTION 'Only accountable users can decide this approval';
  END IF;

  UPDATE public.approval_requests ar
  SET
    status = v_new_status,
    decided_by = auth.uid(),
    decided_at = now()
  WHERE ar.id = p_request_id
    AND ar.tenant_id = v_tenant_id
  RETURNING ar.status, ar.decided_at
  INTO status, decided_at;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'approval.decide',
    COALESCE(v_request.resource, 'approval_requests'),
    status,
    jsonb_build_object(
      'request_id', p_request_id,
      'effective_roles', v_effective_roles
    )
  );

  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.raci_action_candidates(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_effective_role_names(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_user_raci_context(text, text, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_approval_reviewer_for_action(uuid, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.evaluate_action_policy(text, text, text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_approvals_queue_payload(text, text, text, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decide_approval_request_queue(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decide_approval_request(uuid, text) TO authenticated, service_role;
