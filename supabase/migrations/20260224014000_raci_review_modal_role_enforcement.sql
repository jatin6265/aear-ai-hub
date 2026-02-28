CREATE OR REPLACE FUNCTION public.get_approval_review_payload(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_profile_role text := 'member';
  v_effective_roles text[] := ARRAY['member'::text];
  v_request public.approval_requests%ROWTYPE;
  v_requested_name text;
  v_requested_role text;
  v_requested_avatar text;
  v_requested_email text;
  v_is_accountable boolean := false;
  v_can_review boolean := false;
  v_raci_confirmation text := '';
  v_request_explanation text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'approvalId is required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  UPDATE public.approval_requests ar
  SET status = 'expired'
  WHERE ar.tenant_id = v_tenant_id
    AND public.normalize_approval_status(ar.status) = 'pending'
    AND ar.expires_at <= now();

  SELECT *
  INTO v_request
  FROM public.approval_requests ar
  WHERE ar.id = p_request_id
    AND ar.tenant_id = v_tenant_id;

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'Approval request not found';
  END IF;

  SELECT lower(COALESCE(p.role, 'member'))
  INTO v_profile_role
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.tenant_id = v_tenant_id
    AND COALESCE(p.status, 'active') = 'active';

  v_effective_roles := public.get_effective_role_names(v_tenant_id, auth.uid());

  SELECT
    COALESCE(NULLIF(trim(p.full_name), ''), split_part(COALESCE(u.email, ''), '@', 1), 'Unknown user'),
    COALESCE(p.role, 'member'),
    p.avatar_url,
    COALESCE(u.email, '')
  INTO v_requested_name, v_requested_role, v_requested_avatar, v_requested_email
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE p.id = v_request.requested_by;

  v_is_accountable := EXISTS (
    SELECT 1
    FROM public.raci_matrix rm
    WHERE rm.tenant_id = v_tenant_id
      AND lower(COALESCE(rm.resource, '')) = lower(COALESCE(v_request.resource, ''))
      AND lower(COALESCE(rm.action, 'execute')) = ANY(public.raci_action_candidates(v_request.action))
      AND lower(COALESCE(rm.role_name, '')) = ANY(v_effective_roles)
      AND upper(COALESCE(rm.raci_type, '')) = 'A'
  );

  v_can_review := (
    public.normalize_approval_status(v_request.status) = 'pending'
    AND v_is_accountable
  );

  IF v_is_accountable THEN
    v_raci_confirmation := format('You are Accountable for %s → %s', v_request.resource, v_request.action);
  ELSE
    v_raci_confirmation := format(
      'Your effective roles (%s) are not Accountable for %s → %s',
      array_to_string(v_effective_roles, ', '),
      v_request.resource,
      v_request.action
    );
  END IF;

  v_request_explanation := COALESCE(
    NULLIF(v_request.params ->> 'request_explanation', ''),
    NULLIF(v_request.params ->> 'reason', ''),
    NULLIF(v_request.params ->> 'request_reason', ''),
    NULLIF(v_request.params ->> 'explanation', ''),
    NULLIF(v_request.params ->> 'decision_note', '')
  );

  RETURN jsonb_build_object(
    'id', v_request.id,
    'type', public.classify_approval_type(v_request.action, v_request.resource),
    'status', public.normalize_approval_status(v_request.status),
    'riskLevel', lower(COALESCE(v_request.risk_level, 'medium')),
    'actionSummary', COALESCE(NULLIF(v_request.action_summary, ''), NULLIF(v_request.params ->> 'summary', ''), v_request.action),
    'action', v_request.action,
    'resource', v_request.resource,
    'targetIdentifier', COALESCE(
      NULLIF(v_request.params ->> 'target', ''),
      NULLIF(v_request.params ->> 'target_id', ''),
      NULLIF(v_request.params ->> 'record_id', ''),
      NULLIF(v_request.params ->> 'entity_id', ''),
      NULLIF(v_request.params ->> 'id', ''),
      'N/A'
    ),
    'requestedAt', v_request.created_at,
    'expiresAt', v_request.expires_at,
    'expiresInSeconds', CASE
      WHEN public.normalize_approval_status(v_request.status) = 'pending'
        THEN GREATEST(EXTRACT(EPOCH FROM (v_request.expires_at - now()))::integer, 0)
      ELSE NULL
    END,
    'requestedBy', jsonb_build_object(
      'id', v_request.requested_by,
      'name', v_requested_name,
      'role', lower(COALESCE(v_requested_role, 'member')),
      'avatarUrl', v_requested_avatar,
      'email', v_requested_email
    ),
    'decidedBy', CASE
      WHEN v_request.decided_by IS NULL THEN NULL
      ELSE (
        SELECT jsonb_build_object(
          'id', v_request.decided_by,
          'name', COALESCE(NULLIF(trim(dp.full_name), ''), split_part(COALESCE(du.email, ''), '@', 1), 'Unknown user')
        )
        FROM public.profiles dp
        LEFT JOIN auth.users du ON du.id = dp.id
        WHERE dp.id = v_request.decided_by
      )
    END,
    'decidedAt', v_request.decided_at,
    'canReview', v_can_review,
    'isAccountable', v_is_accountable,
    'profileRole', v_profile_role,
    'effectiveRoles', COALESCE(to_jsonb(v_effective_roles), '[]'::jsonb),
    'raciConfirmation', v_raci_confirmation,
    'requestExplanation', v_request_explanation,
    'simulationPreview', COALESCE(v_request.simulation_preview, '{}'::jsonb),
    'executionHistory', (
      SELECT jsonb_build_object(
        'count', COUNT(*)::integer,
        'recent', COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', x.id,
              'status', x.status,
              'riskLevel', x.risk_level,
              'createdAt', x.created_at,
              'actorName', x.actor_name
            )
            ORDER BY x.created_at DESC
          ),
          '[]'::jsonb
        )
      )
      FROM (
        SELECT
          al.id,
          lower(COALESCE(al.status, 'unknown')) AS status,
          lower(COALESCE(al.risk_level, 'medium')) AS risk_level,
          al.created_at,
          COALESCE(NULLIF(trim(p.full_name), ''), split_part(COALESCE(u.email, ''), '@', 1), 'Unknown user') AS actor_name
        FROM public.audit_logs al
        LEFT JOIN public.profiles p ON p.id = al.user_id
        LEFT JOIN auth.users u ON u.id = al.user_id
        WHERE al.tenant_id = v_tenant_id
          AND lower(COALESCE(al.action, '')) = lower(COALESCE(v_request.action, ''))
          AND lower(COALESCE(al.resource, '')) = lower(COALESCE(v_request.resource, ''))
        ORDER BY al.created_at DESC
        LIMIT 3
      ) x
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_approval_review_decision(
  p_request_id uuid,
  p_decision text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_effective_roles text[] := ARRAY['member'::text];
  v_request public.approval_requests%ROWTYPE;
  v_decision text := lower(trim(COALESCE(p_decision, '')));
  v_reason text := NULLIF(trim(COALESCE(p_reason, '')), '');
  v_can_review boolean := false;
  v_plain_token text;
  v_prefix text;
  v_hash text;
  v_token_expires timestamptz;
  v_token_id uuid;
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

  IF v_decision NOT IN ('approved', 'rejected', 'more_info') THEN
    RAISE EXCEPTION 'decision must be approved, rejected, or more_info';
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

  IF v_decision = 'rejected' AND (v_reason IS NULL OR length(v_reason) < 3) THEN
    RAISE EXCEPTION 'Rejection reason is required';
  END IF;

  IF v_decision = 'more_info' AND (v_reason IS NULL OR length(v_reason) < 3) THEN
    RAISE EXCEPTION 'Please include a message when requesting more info';
  END IF;

  IF v_decision = 'more_info' THEN
    UPDATE public.approval_requests ar
    SET
      params = COALESCE(ar.params, '{}'::jsonb) || jsonb_build_object(
        'more_info_requested', true,
        'more_info_message', v_reason,
        'more_info_requested_by', auth.uid(),
        'more_info_requested_at', now()
      )
    WHERE ar.id = p_request_id
      AND ar.tenant_id = v_tenant_id;

    INSERT INTO public.notifications (tenant_id, user_id, title, body, kind, metadata)
    VALUES (
      v_tenant_id,
      v_request.requested_by,
      'More info requested for approval',
      COALESCE(v_reason, 'Please provide additional context for this request.'),
      'info',
      jsonb_build_object('approval_id', p_request_id, 'decision', 'more_info')
    );

    INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, risk_level, status, details)
    VALUES (
      v_tenant_id,
      auth.uid(),
      'approval.request_more_info',
      COALESCE(v_request.resource, 'approval_requests'),
      COALESCE(v_request.risk_level, 'medium'),
      'pending',
      jsonb_build_object('request_id', p_request_id, 'message', v_reason, 'effective_roles', v_effective_roles)
    );

    RETURN jsonb_build_object(
      'status', 'pending',
      'decidedAt', null,
      'token', null,
      'tokenExpiresAt', null,
      'message', 'More info requested from requestor'
    );
  END IF;

  IF v_decision = 'approved' THEN
    UPDATE public.approval_execution_tokens
    SET revoked_at = now()
    WHERE approval_request_id = p_request_id
      AND tenant_id = v_tenant_id
      AND used_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > now();

    v_plain_token := 'opsai_exec_' || encode(gen_random_bytes(24), 'hex');
    v_prefix := left(v_plain_token, 16);
    v_hash := encode(digest(v_plain_token, 'sha256'), 'hex');
    v_token_expires := now() + interval '15 minutes';

    INSERT INTO public.approval_execution_tokens (
      tenant_id,
      approval_request_id,
      issued_by,
      token_prefix,
      token_hash,
      expires_at,
      metadata
    )
    VALUES (
      v_tenant_id,
      p_request_id,
      auth.uid(),
      v_prefix,
      v_hash,
      v_token_expires,
      jsonb_build_object('source', 'approval_review_modal')
    )
    RETURNING id INTO v_token_id;
  END IF;

  UPDATE public.approval_requests ar
  SET
    status = v_decision,
    decided_by = auth.uid(),
    decided_at = now(),
    params = COALESCE(ar.params, '{}'::jsonb) || jsonb_build_object(
      'decision_note', v_reason,
      'decision_source', 'approval_review_modal',
      'execution_token_id', v_token_id
    )
  WHERE ar.id = p_request_id
    AND ar.tenant_id = v_tenant_id;

  INSERT INTO public.notifications (tenant_id, user_id, title, body, kind, metadata)
  VALUES (
    v_tenant_id,
    v_request.requested_by,
    CASE WHEN v_decision = 'approved' THEN 'Approval approved' ELSE 'Approval rejected' END,
    CASE
      WHEN v_decision = 'approved'
        THEN 'Your requested action was approved and a short-lived execution token was issued.'
      ELSE COALESCE(v_reason, 'Your requested action was rejected by the accountable reviewer.')
    END,
    CASE WHEN v_decision = 'approved' THEN 'success' ELSE 'warning' END,
    jsonb_build_object('approval_id', p_request_id, 'decision', v_decision)
  );

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, risk_level, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'approval.review.decide',
    COALESCE(v_request.resource, 'approval_requests'),
    COALESCE(v_request.risk_level, 'medium'),
    v_decision,
    jsonb_build_object(
      'request_id', p_request_id,
      'decision', v_decision,
      'reason', v_reason,
      'execution_token_id', v_token_id,
      'execution_token_expires_at', v_token_expires,
      'effective_roles', v_effective_roles
    )
  );

  RETURN jsonb_build_object(
    'status', v_decision,
    'decidedAt', now(),
    'token', v_plain_token,
    'tokenPrefix', v_prefix,
    'tokenExpiresAt', v_token_expires,
    'message', CASE
      WHEN v_decision = 'approved' THEN 'Approval granted and execution token issued'
      ELSE 'Approval rejected'
    END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_approval_review_payload(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_approval_review_decision(uuid, text, text) TO authenticated, service_role;
