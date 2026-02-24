-- Multi-approval quorum enforcement for high/critical actions.
-- This migration adds a per-reviewer decision ledger and centralized
-- RPCs so action execution can only proceed once quorum is satisfied.

ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS required_approvals integer;

UPDATE public.approval_requests
SET required_approvals = CASE
  WHEN lower(COALESCE(risk_level, '')) = 'critical' THEN 2
  ELSE 1
END
WHERE required_approvals IS NULL;

ALTER TABLE public.approval_requests
  ALTER COLUMN required_approvals SET DEFAULT 1,
  ALTER COLUMN required_approvals SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'approval_requests_required_approvals_chk'
      AND conrelid = 'public.approval_requests'::regclass
  ) THEN
    ALTER TABLE public.approval_requests
      ADD CONSTRAINT approval_requests_required_approvals_chk
      CHECK (required_approvals BETWEEN 1 AND 10);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'approval_execution_tokens'
      AND policyname = 'Tenant members can view approval execution tokens'
  ) THEN
    CREATE POLICY "Tenant members can view approval execution tokens"
      ON public.approval_execution_tokens
      FOR SELECT TO authenticated
      USING (tenant_id = public.get_user_tenant_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'approval_execution_tokens'
      AND policyname = 'Tenant members can manage approval execution tokens'
  ) THEN
    CREATE POLICY "Tenant members can manage approval execution tokens"
      ON public.approval_execution_tokens
      FOR ALL TO authenticated
      USING (tenant_id = public.get_user_tenant_id())
      WITH CHECK (tenant_id = public.get_user_tenant_id());
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.approval_request_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  approval_request_id uuid NOT NULL REFERENCES public.approval_requests(id) ON DELETE CASCADE,
  reviewer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'more_info')),
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  decided_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (approval_request_id, reviewer_user_id)
);

ALTER TABLE public.approval_request_decisions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.approval_execution_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  approval_request_id uuid NOT NULL REFERENCES public.approval_requests(id) ON DELETE CASCADE,
  issued_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  token_prefix text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.approval_execution_tokens ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS approval_request_decisions_request_idx
  ON public.approval_request_decisions (approval_request_id, decided_at DESC);

CREATE INDEX IF NOT EXISTS approval_request_decisions_tenant_reviewer_idx
  ON public.approval_request_decisions (tenant_id, reviewer_user_id, decided_at DESC);

CREATE INDEX IF NOT EXISTS approval_execution_tokens_tenant_expires_idx
  ON public.approval_execution_tokens (tenant_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS approval_execution_tokens_request_idx
  ON public.approval_execution_tokens (approval_request_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'approval_request_decisions'
      AND policyname = 'Tenant members can view approval decisions'
  ) THEN
    CREATE POLICY "Tenant members can view approval decisions"
      ON public.approval_request_decisions
      FOR SELECT TO authenticated
      USING (tenant_id = public.get_user_tenant_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'approval_request_decisions'
      AND policyname = 'Reviewers can write own approval decisions'
  ) THEN
    CREATE POLICY "Reviewers can write own approval decisions"
      ON public.approval_request_decisions
      FOR INSERT TO authenticated
      WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        AND reviewer_user_id = auth.uid()
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'approval_request_decisions'
      AND policyname = 'Reviewers can update own approval decisions'
  ) THEN
    CREATE POLICY "Reviewers can update own approval decisions"
      ON public.approval_request_decisions
      FOR UPDATE TO authenticated
      USING (
        tenant_id = public.get_user_tenant_id()
        AND reviewer_user_id = auth.uid()
      )
      WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        AND reviewer_user_id = auth.uid()
      );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_approval_reviewers_for_action(
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
  IF auth.uid() IS NULL AND current_setting('request.jwt.claim.role', true) <> 'service_role' THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found';
  END IF;

  RETURN QUERY
  SELECT DISTINCT
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
  ORDER BY full_name ASC;
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
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT r.id, r.full_name, r.role_name
  FROM public.get_approval_reviewers_for_action(p_tenant_id, p_resource, p_action, p_exclude_user_id) r
  ORDER BY r.full_name ASC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.compute_required_approvals(
  p_tenant_id uuid,
  p_resource text,
  p_action text DEFAULT 'execute',
  p_risk_level text DEFAULT 'medium',
  p_params jsonb DEFAULT '{}'::jsonb
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_required integer := 1;
  v_risk text := lower(trim(COALESCE(p_risk_level, 'medium')));
  v_is_financial boolean := public.classify_approval_type(p_action, p_resource) = 'financial';
  v_dual_enabled boolean := false;
  v_override integer := NULL;
BEGIN
  IF v_risk = 'critical' THEN
    v_required := 2;
  END IF;

  SELECT
    COALESCE(g.enabled, false)
    AND COALESCE((g.config ->> 'dualApproval')::boolean, false)
  INTO v_dual_enabled
  FROM public.guardrails g
  WHERE g.tenant_id = p_tenant_id
    AND g.code = 'cfg_financial_mutation_limit'
  LIMIT 1;

  IF v_dual_enabled AND (v_is_financial OR v_risk IN ('high', 'critical')) THEN
    v_required := GREATEST(v_required, 2);
  END IF;

  IF COALESCE(p_params ->> 'requiredApprovals', '') ~ '^[0-9]+$' THEN
    v_override := (p_params ->> 'requiredApprovals')::integer;
  ELSIF COALESCE(p_params ->> 'required_approvals', '') ~ '^[0-9]+$' THEN
    v_override := (p_params ->> 'required_approvals')::integer;
  END IF;

  IF v_override IS NOT NULL THEN
    v_required := GREATEST(v_required, LEAST(GREATEST(v_override, 1), 10));
  END IF;

  RETURN LEAST(GREATEST(v_required, 1), 10);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_approval_request_quorum_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.required_approvals IS NULL THEN
    NEW.required_approvals := public.compute_required_approvals(
      NEW.tenant_id,
      NEW.resource,
      NEW.action,
      NEW.risk_level,
      COALESCE(NEW.params, '{}'::jsonb)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_approval_request_quorum_defaults ON public.approval_requests;
CREATE TRIGGER set_approval_request_quorum_defaults
BEFORE INSERT ON public.approval_requests
FOR EACH ROW
EXECUTE FUNCTION public.set_approval_request_quorum_defaults();

CREATE OR REPLACE FUNCTION public.create_approval_request(
  p_action text,
  p_resource text,
  p_risk_level text DEFAULT 'medium',
  p_params jsonb DEFAULT '{}'::jsonb,
  p_simulation_preview jsonb DEFAULT '{}'::jsonb,
  p_action_summary text DEFAULT NULL,
  p_requested_by uuid DEFAULT NULL,
  p_tenant_id uuid DEFAULT NULL,
  p_expires_minutes integer DEFAULT 1440
)
RETURNS TABLE (
  id uuid,
  status text,
  required_approvals integer,
  approved_count integer,
  rejected_count integer,
  pending_approvals integer,
  approvers jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_tenant_id uuid := COALESCE(p_tenant_id, public.get_user_tenant_id());
  v_requester uuid := COALESCE(p_requested_by, auth.uid());
  v_role text := lower(COALESCE(current_setting('request.jwt.claim.role', true), ''));
  v_required integer := 1;
  v_approvers jsonb := '[]'::jsonb;
  v_approver_count integer := 0;
  v_expires_minutes integer := COALESCE(p_expires_minutes, 1440);
  v_request_id uuid;
BEGIN
  IF auth.uid() IS NULL AND v_role <> 'service_role' THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found';
  END IF;

  IF v_requester IS NULL THEN
    RAISE EXCEPTION 'Requested by user is required';
  END IF;

  IF auth.uid() IS NOT NULL AND v_role <> 'service_role' AND v_requester <> auth.uid() THEN
    RAISE EXCEPTION 'Cannot create approval request for another user';
  END IF;

  v_required := public.compute_required_approvals(
    v_tenant_id,
    p_resource,
    p_action,
    p_risk_level,
    COALESCE(p_params, '{}'::jsonb)
  );

  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object('id', r.id, 'name', r.full_name, 'role', r.role_name)
        ORDER BY r.full_name
      ),
      '[]'::jsonb
    ),
    COUNT(*)::integer
  INTO v_approvers, v_approver_count
  FROM public.get_approval_reviewers_for_action(v_tenant_id, p_resource, p_action, v_requester) r;

  IF v_approver_count < v_required THEN
    RAISE EXCEPTION 'Not enough Accountable reviewers configured (required %, available %)', v_required, v_approver_count;
  END IF;

  v_expires_minutes := LEAST(GREATEST(v_expires_minutes, 15), 10080);

  INSERT INTO public.approval_requests (
    tenant_id,
    requested_by,
    action,
    resource,
    action_summary,
    params,
    simulation_preview,
    risk_level,
    status,
    required_approvals,
    expires_at
  )
  VALUES (
    v_tenant_id,
    v_requester,
    p_action,
    p_resource,
    COALESCE(NULLIF(trim(COALESCE(p_action_summary, '')), ''), NULLIF(trim(COALESCE(p_params ->> 'summary', '')), ''), p_action),
    COALESCE(p_params, '{}'::jsonb) || jsonb_build_object(
      'approval',
      jsonb_build_object(
        'requiredApprovals', v_required,
        'approvers', v_approvers
      )
    ),
    COALESCE(p_simulation_preview, '{}'::jsonb),
    lower(COALESCE(p_risk_level, 'medium')),
    'pending',
    v_required,
    now() + make_interval(mins => v_expires_minutes)
  )
  RETURNING approval_requests.id
  INTO v_request_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, risk_level, status, details)
  VALUES (
    v_tenant_id,
    v_requester,
    'approval.request.create',
    COALESCE(p_resource, 'approval_requests'),
    lower(COALESCE(p_risk_level, 'medium')),
    'pending',
    jsonb_build_object(
      'request_id', v_request_id,
      'required_approvals', v_required,
      'approver_count', v_approver_count,
      'action', p_action
    )
  );

  id := v_request_id;
  status := 'pending';
  required_approvals := v_required;
  approved_count := 0;
  rejected_count := 0;
  pending_approvals := v_required;
  approvers := v_approvers;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_approval_request_state(
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_request public.approval_requests%ROWTYPE;
  v_tenant_id uuid := NULL;
  v_role text := lower(COALESCE(current_setting('request.jwt.claim.role', true), ''));
  v_approved integer := 0;
  v_rejected integer := 0;
  v_pending integer := 0;
  v_my_decision text := NULL;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'approvalId is required';
  END IF;

  IF auth.uid() IS NULL AND v_role <> 'service_role' THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    v_tenant_id := public.get_user_tenant_id();
  END IF;

  SELECT *
  INTO v_request
  FROM public.approval_requests ar
  WHERE ar.id = p_request_id
    AND (v_tenant_id IS NULL OR ar.tenant_id = v_tenant_id);

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'Approval request not found';
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE d.decision = 'approved')::integer,
    COUNT(*) FILTER (WHERE d.decision = 'rejected')::integer
  INTO v_approved, v_rejected
  FROM public.approval_request_decisions d
  WHERE d.tenant_id = v_request.tenant_id
    AND d.approval_request_id = v_request.id;

  IF auth.uid() IS NOT NULL THEN
    SELECT d.decision
    INTO v_my_decision
    FROM public.approval_request_decisions d
    WHERE d.tenant_id = v_request.tenant_id
      AND d.approval_request_id = v_request.id
      AND d.reviewer_user_id = auth.uid();
  END IF;

  v_pending := GREATEST(COALESCE(v_request.required_approvals, 1) - v_approved, 0);

  RETURN jsonb_build_object(
    'id', v_request.id,
    'status', public.normalize_approval_status(v_request.status),
    'requiredApprovals', COALESCE(v_request.required_approvals, 1),
    'approvedCount', v_approved,
    'rejectedCount', v_rejected,
    'pendingApprovals', CASE
      WHEN public.normalize_approval_status(v_request.status) = 'rejected' THEN 0
      ELSE v_pending
    END,
    'myDecision', v_my_decision,
    'decidedBy', v_request.decided_by,
    'decidedAt', v_request.decided_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_approval_decision(
  p_request_id uuid,
  p_decision text,
  p_reason text DEFAULT NULL,
  p_source text DEFAULT 'approval_api'
)
RETURNS TABLE (
  request_id uuid,
  status text,
  decided_at timestamptz,
  required_approvals integer,
  approved_count integer,
  rejected_count integer,
  pending_approvals integer,
  reviewer_decision text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_effective_roles text[] := ARRAY['member'::text];
  v_request public.approval_requests%ROWTYPE;
  v_decision text := lower(trim(COALESCE(p_decision, '')));
  v_reason text := NULLIF(trim(COALESCE(p_reason, '')), '');
  v_can_review boolean := false;
  v_required integer := 1;
  v_approved integer := 0;
  v_rejected integer := 0;
  v_pending integer := 0;
  v_final_status text := 'pending';
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
    RAISE EXCEPTION 'Decision must be approved, rejected, or more_info';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

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

  IF v_decision IN ('rejected', 'more_info') AND (v_reason IS NULL OR length(v_reason) < 3) THEN
    RAISE EXCEPTION 'A reason of at least 3 characters is required';
  END IF;

  v_required := GREATEST(
    COALESCE(v_request.required_approvals, 1),
    public.compute_required_approvals(
      v_tenant_id,
      v_request.resource,
      v_request.action,
      v_request.risk_level,
      COALESCE(v_request.params, '{}'::jsonb)
    )
  );

  UPDATE public.approval_requests
  SET required_approvals = v_required
  WHERE id = v_request.id
    AND tenant_id = v_tenant_id
    AND required_approvals <> v_required;

  INSERT INTO public.approval_request_decisions (
    tenant_id,
    approval_request_id,
    reviewer_user_id,
    decision,
    reason,
    metadata,
    decided_at
  )
  VALUES (
    v_tenant_id,
    v_request.id,
    auth.uid(),
    v_decision,
    v_reason,
    jsonb_build_object('source', p_source),
    now()
  )
  ON CONFLICT (approval_request_id, reviewer_user_id)
  DO UPDATE SET
    decision = EXCLUDED.decision,
    reason = EXCLUDED.reason,
    metadata = EXCLUDED.metadata,
    decided_at = EXCLUDED.decided_at;

  SELECT
    COUNT(*) FILTER (WHERE d.decision = 'approved')::integer,
    COUNT(*) FILTER (WHERE d.decision = 'rejected')::integer
  INTO v_approved, v_rejected
  FROM public.approval_request_decisions d
  WHERE d.tenant_id = v_tenant_id
    AND d.approval_request_id = v_request.id;

  IF v_rejected > 0 THEN
    v_final_status := 'rejected';
  ELSIF v_approved >= v_required THEN
    v_final_status := 'approved';
  ELSE
    v_final_status := 'pending';
  END IF;

  v_pending := CASE
    WHEN v_final_status = 'rejected' THEN 0
    ELSE GREATEST(v_required - v_approved, 0)
  END;

  UPDATE public.approval_requests ar
  SET
    status = v_final_status,
    decided_by = CASE WHEN v_final_status IN ('approved', 'rejected') THEN auth.uid() ELSE NULL END,
    decided_at = CASE WHEN v_final_status IN ('approved', 'rejected') THEN now() ELSE NULL END,
    params = COALESCE(ar.params, '{}'::jsonb) || jsonb_build_object(
      'approvalProgress',
      jsonb_build_object(
        'requiredApprovals', v_required,
        'approvedCount', v_approved,
        'rejectedCount', v_rejected,
        'pendingApprovals', v_pending,
        'lastDecisionBy', auth.uid(),
        'lastDecision', v_decision,
        'lastDecisionAt', now(),
        'decisionSource', p_source
      ),
      'decision_note', v_reason,
      'decision_source', p_source
    )
  WHERE ar.id = v_request.id
    AND ar.tenant_id = v_tenant_id
  RETURNING ar.decided_at INTO decided_at;

  IF v_decision = 'more_info' THEN
    INSERT INTO public.notifications (tenant_id, user_id, title, body, kind, metadata)
    VALUES (
      v_tenant_id,
      v_request.requested_by,
      'More info requested for approval',
      COALESCE(v_reason, 'Please provide additional context for this request.'),
      'info',
      jsonb_build_object('approval_id', v_request.id, 'decision', 'more_info')
    );
  ELSIF v_final_status IN ('approved', 'rejected') THEN
    INSERT INTO public.notifications (tenant_id, user_id, title, body, kind, metadata)
    VALUES (
      v_tenant_id,
      v_request.requested_by,
      CASE WHEN v_final_status = 'approved' THEN 'Approval approved' ELSE 'Approval rejected' END,
      CASE
        WHEN v_final_status = 'approved'
          THEN 'Your requested action has reached required approvals and is now approved.'
        ELSE COALESCE(v_reason, 'Your requested action was rejected by an accountable reviewer.')
      END,
      CASE WHEN v_final_status = 'approved' THEN 'success' ELSE 'warning' END,
      jsonb_build_object(
        'approval_id', v_request.id,
        'decision', v_final_status,
        'requiredApprovals', v_required,
        'approvedCount', v_approved,
        'rejectedCount', v_rejected
      )
    );
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, risk_level, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'approval.review.decision',
    COALESCE(v_request.resource, 'approval_requests'),
    COALESCE(v_request.risk_level, 'medium'),
    v_final_status,
    jsonb_build_object(
      'request_id', v_request.id,
      'reviewer_decision', v_decision,
      'reason', v_reason,
      'source', p_source,
      'required_approvals', v_required,
      'approved_count', v_approved,
      'rejected_count', v_rejected,
      'pending_approvals', v_pending
    )
  );

  request_id := v_request.id;
  status := v_final_status;
  required_approvals := v_required;
  approved_count := v_approved;
  rejected_count := v_rejected;
  pending_approvals := v_pending;
  reviewer_decision := v_decision;
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
  v_row record;
BEGIN
  SELECT *
  INTO v_row
  FROM public.record_approval_decision(
    p_request_id => p_request_id,
    p_decision => p_decision,
    p_reason => NULL,
    p_source => 'decide_approval_request'
  )
  LIMIT 1;

  status := v_row.status;
  decided_at := v_row.decided_at;
  RETURN NEXT;
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
  v_row record;
BEGIN
  SELECT *
  INTO v_row
  FROM public.record_approval_decision(
    p_request_id => p_request_id,
    p_decision => p_decision,
    p_reason => p_note,
    p_source => 'approvals_queue'
  )
  LIMIT 1;

  status := v_row.status;
  decided_at := v_row.decided_at;
  RETURN NEXT;
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
  v_result record;
  v_plain_token text := NULL;
  v_prefix text := NULL;
  v_hash text := NULL;
  v_token_expires timestamptz := NULL;
  v_token_id uuid := NULL;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  SELECT *
  INTO v_result
  FROM public.record_approval_decision(
    p_request_id => p_request_id,
    p_decision => p_decision,
    p_reason => p_reason,
    p_source => 'approval_review_modal'
  )
  LIMIT 1;

  IF v_result.status = 'approved' THEN
    UPDATE public.approval_execution_tokens
    SET revoked_at = now()
    WHERE approval_request_id = p_request_id
      AND tenant_id = v_tenant_id
      AND used_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > now();

    v_plain_token := 'aear_exec_' || encode(gen_random_bytes(24), 'hex');
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
      jsonb_build_object(
        'source', 'approval_review_modal',
        'requiredApprovals', v_result.required_approvals,
        'approvedCount', v_result.approved_count
      )
    )
    RETURNING id INTO v_token_id;

    UPDATE public.approval_requests ar
    SET params = COALESCE(ar.params, '{}'::jsonb) || jsonb_build_object('execution_token_id', v_token_id)
    WHERE ar.id = p_request_id
      AND ar.tenant_id = v_tenant_id;
  END IF;

  RETURN jsonb_build_object(
    'status', v_result.status,
    'decidedAt', v_result.decided_at,
    'token', v_plain_token,
    'tokenPrefix', v_prefix,
    'tokenExpiresAt', v_token_expires,
    'requiredApprovals', v_result.required_approvals,
    'approvedCount', v_result.approved_count,
    'rejectedCount', v_result.rejected_count,
    'pendingApprovals', v_result.pending_approvals,
    'reviewerDecision', v_result.reviewer_decision,
    'message', CASE
      WHEN v_result.status = 'approved' THEN 'Approval quorum reached. Execution token issued.'
      WHEN v_result.status = 'rejected' THEN 'Approval rejected.'
      WHEN v_result.reviewer_decision = 'more_info' THEN 'More info requested from requestor.'
      ELSE format(
        'Decision recorded. Waiting for %s more approval%s.',
        v_result.pending_approvals,
        CASE WHEN v_result.pending_approvals = 1 THEN '' ELSE 's' END
      )
    END
  );
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
    WITH decision_stats AS (
      SELECT
        d.approval_request_id,
        COUNT(*) FILTER (WHERE d.decision = 'approved')::integer AS approved_count,
        COUNT(*) FILTER (WHERE d.decision = 'rejected')::integer AS rejected_count
      FROM public.approval_request_decisions d
      WHERE d.tenant_id = v_tenant_id
      GROUP BY d.approval_request_id
    ),
    my_decisions AS (
      SELECT
        d.approval_request_id,
        d.decision AS my_decision
      FROM public.approval_request_decisions d
      WHERE d.tenant_id = v_tenant_id
        AND d.reviewer_user_id = auth.uid()
    ),
    base AS (
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
        COALESCE(ar.required_approvals, 1) AS required_approvals,
        COALESCE(ds.approved_count, 0) AS approved_count,
        COALESCE(ds.rejected_count, 0) AS rejected_count,
        CASE
          WHEN public.normalize_approval_status(ar.status) = 'rejected' THEN 0
          ELSE GREATEST(COALESCE(ar.required_approvals, 1) - COALESCE(ds.approved_count, 0), 0)
        END AS pending_approvals,
        md.my_decision,
        COALESCE(NULLIF(trim(req_profile.full_name), ''), split_part(COALESCE(req_user.email, ''), '@', 1), 'Unknown user') AS requested_by_name,
        COALESCE(req_profile.role, 'member') AS requested_by_role,
        COALESCE(NULLIF(trim(dec_profile.full_name), ''), split_part(COALESCE(dec_user.email, ''), '@', 1), NULL) AS decided_by_name,
        (
          public.normalize_approval_status(ar.status) = 'pending'
          AND (md.my_decision IS NULL OR md.my_decision = 'more_info')
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
      LEFT JOIN decision_stats ds
        ON ds.approval_request_id = ar.id
      LEFT JOIN my_decisions md
        ON md.approval_request_id = ar.id
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
      WHERE v_status_filter = 'all' OR status = v_status_filter
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
              'simulationPreview', f.simulation_preview,
              'requiredApprovals', f.required_approvals,
              'approvedCount', f.approved_count,
              'rejectedCount', f.rejected_count,
              'pendingApprovals', f.pending_approvals,
              'myDecision', f.my_decision
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

GRANT EXECUTE ON FUNCTION public.get_approval_reviewers_for_action(uuid, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.compute_required_approvals(uuid, text, text, text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_approval_request(text, text, text, jsonb, jsonb, text, uuid, uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_approval_request_state(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_approval_decision(uuid, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decide_approval_request(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decide_approval_request_queue(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_approval_review_decision(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_approvals_queue_payload(text, text, text, date, date) TO authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'approval_request_decisions'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.approval_request_decisions';
  END IF;
END;
$$;
