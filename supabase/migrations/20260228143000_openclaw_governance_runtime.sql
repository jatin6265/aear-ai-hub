-- OpenClaw integration hardening: service-role governance evaluation and approval-aware runtime states.

CREATE OR REPLACE FUNCTION public.evaluate_action_policy_service(
  p_tenant_id uuid,
  p_user_id uuid,
  p_resource text,
  p_action text,
  p_risk_level text DEFAULT 'low',
  p_requires_write boolean DEFAULT false
)
RETURNS TABLE (
  allow boolean,
  approval_required boolean,
  reason text,
  matched_rule jsonb,
  risk_level text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := p_tenant_id;
  v_user_id uuid := p_user_id;
  v_risk text := lower(trim(COALESCE(p_risk_level, 'low')));
  v_blocked_by_guardrail boolean := false;
  v_ctx record;
BEGIN
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id is required';
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = v_user_id
      AND p.tenant_id = v_tenant_id
  ) THEN
    RAISE EXCEPTION 'User does not belong to tenant';
  END IF;

  SELECT *
  INTO v_ctx
  FROM public.resolve_user_raci_context(
    p_resource => COALESCE(NULLIF(trim(p_resource), ''), 'agent_execution'),
    p_action => COALESCE(NULLIF(trim(p_action), ''), 'execute'),
    p_tenant_id => v_tenant_id,
    p_user_id => v_user_id
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

  risk_level := v_risk;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.evaluate_action_policy_service(uuid, uuid, text, text, text, boolean)
TO authenticated, service_role;

ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS pending_approval_id uuid REFERENCES public.approval_requests(id) ON DELETE SET NULL;

DO $$
DECLARE
  c record;
BEGIN
  -- Drop the known canonical constraint name first (safe if absent).
  ALTER TABLE public.agent_runs
    DROP CONSTRAINT IF EXISTS agent_runs_status_check;

  -- Drop any legacy status check constraints regardless of expression formatting.
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.agent_runs'::regclass
      AND contype = 'c'
      AND (
        lower(pg_get_constraintdef(oid)) LIKE '%status%'
        OR lower(conname) LIKE '%status%'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.agent_runs DROP CONSTRAINT IF EXISTS %I', c.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.agent_runs'::regclass
      AND conname = 'agent_runs_status_check'
  ) THEN
    BEGIN
      ALTER TABLE public.agent_runs
        ADD CONSTRAINT agent_runs_status_check
        CHECK (status IN ('queued', 'running', 'waiting_approval', 'success', 'failed', 'cancelled', 'dead_letter'));
    EXCEPTION
      WHEN duplicate_object THEN
        NULL;
    END;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS agent_runs_waiting_approval_idx
  ON public.agent_runs (tenant_id, status, created_at DESC)
  WHERE status = 'waiting_approval';
