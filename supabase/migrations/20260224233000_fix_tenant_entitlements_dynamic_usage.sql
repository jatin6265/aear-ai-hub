-- Ensure entitlement checks use live usage for core capabilities.
CREATE OR REPLACE FUNCTION public.tenant_entitlements_check(
  p_capability text,
  p_requested integer DEFAULT 1,
  p_tenant_id uuid DEFAULT NULL
)
RETURNS TABLE (
  capability text,
  allowed boolean,
  reason text,
  hard_limit integer,
  soft_limit integer,
  current_usage integer,
  requested integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := COALESCE(p_tenant_id, public.get_user_tenant_id());
  v_plan text := 'starter';
  v_capability text := lower(trim(COALESCE(p_capability, '')));
  v_requested integer := GREATEST(1, COALESCE(p_requested, 1));
  v_hard integer;
  v_soft integer;
  v_usage integer := 0;
  v_recorded_usage integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  SELECT COALESCE(t.plan, 'starter')
  INTO v_plan
  FROM public.tenants t
  WHERE t.id = v_tenant_id;

  SELECT te.hard_limit, te.soft_limit, COALESCE(te.current_usage, 0)
  INTO v_hard, v_soft, v_recorded_usage
  FROM public.tenant_entitlements te
  WHERE te.tenant_id = v_tenant_id
    AND te.capability = v_capability;

  IF v_hard IS NULL THEN
    v_hard := CASE v_capability
      WHEN 'connections' THEN CASE v_plan WHEN 'starter' THEN 1 WHEN 'pro' THEN 5 WHEN 'business' THEN 25 ELSE -1 END
      WHEN 'users' THEN CASE v_plan WHEN 'starter' THEN 5 WHEN 'pro' THEN 25 WHEN 'business' THEN 100 ELSE -1 END
      WHEN 'agents' THEN CASE v_plan WHEN 'starter' THEN 3 WHEN 'pro' THEN 10 WHEN 'business' THEN 25 ELSE -1 END
      WHEN 'tokens_monthly' THEN CASE v_plan WHEN 'starter' THEN 500000 WHEN 'pro' THEN 5000000 WHEN 'business' THEN 25000000 ELSE -1 END
      WHEN 'storage_gb' THEN CASE v_plan WHEN 'starter' THEN 1 WHEN 'pro' THEN 10 WHEN 'business' THEN 50 ELSE -1 END
      ELSE -1
    END;
  END IF;

  v_usage := CASE v_capability
    WHEN 'connections' THEN (
      SELECT COUNT(*)::integer
      FROM public.api_connections c
      WHERE c.tenant_id = v_tenant_id
        AND c.is_archived = false
    )
    WHEN 'users' THEN (
      SELECT COUNT(*)::integer
      FROM public.profiles p
      WHERE p.tenant_id = v_tenant_id
    )
    WHEN 'agents' THEN (
      SELECT COUNT(*)::integer
      FROM public.ai_agents a
      WHERE a.tenant_id = v_tenant_id
        AND a.status <> 'disabled'
    )
    WHEN 'tokens_monthly' THEN (
      SELECT COALESCE(SUM(u.quantity), 0)::integer
      FROM public.usage_events u
      WHERE u.tenant_id = v_tenant_id
        AND u.metric_type = 'tokens'
        AND u.recorded_at >= date_trunc('month', now())
    )
    ELSE COALESCE(v_recorded_usage, 0)
  END;

  capability := v_capability;
  hard_limit := v_hard;
  soft_limit := v_soft;
  current_usage := COALESCE(v_usage, 0);
  requested := v_requested;

  IF v_hard = -1 OR v_hard IS NULL THEN
    allowed := true;
    reason := 'Unlimited by plan';
  ELSIF (v_usage + v_requested) <= v_hard THEN
    allowed := true;
    reason := 'Within plan limit';
  ELSE
    allowed := false;
    reason := format('Plan limit exceeded for %s', v_capability);
  END IF;

  RETURN NEXT;
END;
$$;
