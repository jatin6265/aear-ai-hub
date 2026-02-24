-- Billing plan upgrade/downgrade backend for /dashboard/billing/upgrade.

CREATE TABLE IF NOT EXISTS public.billing_plan_change_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  change_type text NOT NULL DEFAULT 'upgrade'
    CHECK (change_type IN ('upgrade', 'downgrade')),
  from_plan text NOT NULL,
  to_plan text NOT NULL,
  billing_cycle text NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly', 'annual')),
  proration_credit_cents integer NOT NULL DEFAULT 0,
  due_today_cents integer NOT NULL DEFAULT 0,
  next_renewal_amount_cents integer,
  effective_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'applied'
    CHECK (status IN ('pending', 'applied', 'failed', 'cancelled')),
  payment_reference text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_plan_change_events_tenant_created_idx
  ON public.billing_plan_change_events (tenant_id, created_at DESC);

ALTER TABLE public.billing_plan_change_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant members can view plan change events" ON public.billing_plan_change_events;
CREATE POLICY "Tenant members can view plan change events"
  ON public.billing_plan_change_events FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant admins can manage plan change events" ON public.billing_plan_change_events;
CREATE POLICY "Tenant admins can manage plan change events"
  ON public.billing_plan_change_events FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

CREATE OR REPLACE FUNCTION public.plan_price_cents(
  p_plan text,
  p_billing_cycle text DEFAULT 'monthly'
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_plan text := lower(trim(COALESCE(p_plan, 'starter')));
  v_cycle text := lower(trim(COALESCE(p_billing_cycle, 'monthly')));
  v_price integer;
BEGIN
  IF v_cycle NOT IN ('monthly', 'annual') THEN
    v_cycle := 'monthly';
  END IF;

  SELECT
    CASE
      WHEN v_cycle = 'annual' THEN p.annual_price_cents
      ELSE p.monthly_price_cents
    END
  INTO v_price
  FROM public.pricing_plans p
  WHERE p.code = v_plan
  LIMIT 1;

  IF v_price IS NULL THEN
    v_price := CASE v_plan
      WHEN 'pro' THEN CASE WHEN v_cycle = 'annual' THEN 29900 * 12 - 60000 ELSE 29900 END
      WHEN 'business' THEN CASE WHEN v_cycle = 'annual' THEN 99900 * 12 - 180000 ELSE 99900 END
      WHEN 'enterprise' THEN NULL
      ELSE CASE WHEN v_cycle = 'annual' THEN 4900 * 12 - 12000 ELSE 4900 END
    END;
  END IF;

  RETURN v_price;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_billing_upgrade_options()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_current_plan text := 'starter';
  v_current_cycle text := 'monthly';
  v_plans jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context found';
  END IF;

  IF to_regproc('public.seed_public_pricing_catalog') IS NOT NULL THEN
    PERFORM public.seed_public_pricing_catalog();
  END IF;

  SELECT
    lower(COALESCE(s.plan, t.plan, 'starter')),
    lower(COALESCE(s.billing_cycle, 'monthly'))
  INTO v_current_plan, v_current_cycle
  FROM public.tenants t
  LEFT JOIN public.subscriptions s
    ON s.tenant_id = t.id
  WHERE t.id = v_tenant_id
  LIMIT 1;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'code', p.code,
        'name', p.name,
        'description', p.description,
        'badge', p.badge,
        'monthlyPriceCents', p.monthly_price_cents,
        'annualPriceCents', p.annual_price_cents,
        'current', p.code = v_current_plan,
        'selectable', p.code <> 'enterprise',
        'features', COALESCE((
          SELECT jsonb_agg(ppf.feature_text ORDER BY ppf.sort_order)
          FROM public.pricing_plan_features ppf
          WHERE ppf.plan_code = p.code
        ), '[]'::jsonb)
      )
      ORDER BY p.sort_order
    ),
    '[]'::jsonb
  )
  INTO v_plans
  FROM public.pricing_plans p;

  RETURN jsonb_build_object(
    'currentPlan', v_current_plan,
    'currentBillingCycle', v_current_cycle,
    'plans', v_plans,
    'annualDiscountCallout', 'Save $600/year with annual billing'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.preview_plan_change(
  p_target_plan text,
  p_billing_cycle text DEFAULT 'monthly'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_now timestamptz := now();
  v_target_plan text := lower(trim(COALESCE(p_target_plan, '')));
  v_cycle text := lower(trim(COALESCE(p_billing_cycle, 'monthly')));
  v_current_plan text := 'starter';
  v_current_cycle text := 'monthly';
  v_period_start timestamptz := date_trunc('month', now());
  v_period_end timestamptz := date_trunc('month', now()) + interval '1 month';
  v_current_price integer := 4900;
  v_target_price integer := 4900;
  v_total_seconds numeric := 0;
  v_remaining_seconds numeric := 0;
  v_remaining_fraction numeric := 0;
  v_proration_credit integer := 0;
  v_due_today integer := 0;
  v_next_renewal_date timestamptz;
  v_gained_features text[] := ARRAY[]::text[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context found';
  END IF;

  IF v_target_plan NOT IN ('starter', 'pro', 'business', 'enterprise') THEN
    RAISE EXCEPTION 'Invalid target plan';
  END IF;

  IF v_cycle NOT IN ('monthly', 'annual') THEN
    v_cycle := 'monthly';
  END IF;

  SELECT
    lower(COALESCE(s.plan, t.plan, 'starter')),
    lower(COALESCE(s.billing_cycle, 'monthly')),
    COALESCE(s.current_period_start, date_trunc('month', v_now)),
    COALESCE(s.current_period_end, date_trunc('month', v_now) + interval '1 month')
  INTO
    v_current_plan,
    v_current_cycle,
    v_period_start,
    v_period_end
  FROM public.tenants t
  LEFT JOIN public.subscriptions s
    ON s.tenant_id = t.id
  WHERE t.id = v_tenant_id
  LIMIT 1;

  v_current_price := public.plan_price_cents(v_current_plan, v_current_cycle);
  v_target_price := public.plan_price_cents(v_target_plan, v_cycle);

  IF v_target_plan = 'enterprise' OR v_target_price IS NULL THEN
    RETURN jsonb_build_object(
      'requiresSales', true,
      'message', 'Enterprise plan requires sales assistance.'
    );
  END IF;

  v_total_seconds := GREATEST(EXTRACT(epoch FROM (v_period_end - v_period_start)), 0);
  v_remaining_seconds := GREATEST(EXTRACT(epoch FROM (v_period_end - v_now)), 0);
  v_remaining_fraction := CASE
    WHEN v_total_seconds <= 0 THEN 0
    ELSE LEAST(1, v_remaining_seconds / v_total_seconds)
  END;

  v_proration_credit := ROUND(COALESCE(v_current_price, 0) * v_remaining_fraction);
  v_due_today := GREATEST(COALESCE(v_target_price, 0) - v_proration_credit, 0);
  v_next_renewal_date := CASE
    WHEN v_cycle = 'annual' THEN v_now + interval '1 year'
    ELSE v_now + interval '1 month'
  END;

  SELECT COALESCE(array_agg(f ORDER BY f), ARRAY[]::text[])
  INTO v_gained_features
  FROM (
    SELECT ppf.feature_text AS f
    FROM public.pricing_plan_features ppf
    WHERE ppf.plan_code = v_target_plan
      AND NOT EXISTS (
        SELECT 1
        FROM public.pricing_plan_features cur
        WHERE cur.plan_code = v_current_plan
          AND cur.feature_text = ppf.feature_text
      )
    LIMIT 12
  ) gained;

  RETURN jsonb_build_object(
    'requiresSales', false,
    'currentPlan', v_current_plan,
    'targetPlan', v_target_plan,
    'billingCycle', v_cycle,
    'newPlanPriceCents', v_target_price,
    'prorationCreditCents', v_proration_credit,
    'dueTodayCents', v_due_today,
    'nextRenewalAmountCents', v_target_price,
    'nextRenewalDate', v_next_renewal_date,
    'gainedFeatures', to_jsonb(v_gained_features)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_plan_downgrade_impact(
  p_target_plan text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_target_plan text := lower(trim(COALESCE(p_target_plan, 'starter')));
  v_current_plan text := 'starter';
  v_lost_features text[] := ARRAY[]::text[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context found';
  END IF;

  IF v_target_plan NOT IN ('starter', 'pro', 'business') THEN
    RAISE EXCEPTION 'Invalid downgrade target plan';
  END IF;

  SELECT lower(COALESCE(s.plan, t.plan, 'starter'))
  INTO v_current_plan
  FROM public.tenants t
  LEFT JOIN public.subscriptions s
    ON s.tenant_id = t.id
  WHERE t.id = v_tenant_id
  LIMIT 1;

  SELECT COALESCE(array_agg(f ORDER BY f), ARRAY[]::text[])
  INTO v_lost_features
  FROM (
    SELECT cur.feature_text AS f
    FROM public.pricing_plan_features cur
    WHERE cur.plan_code = v_current_plan
      AND NOT EXISTS (
        SELECT 1
        FROM public.pricing_plan_features target
        WHERE target.plan_code = v_target_plan
          AND target.feature_text = cur.feature_text
      )
    LIMIT 12
  ) lost;

  RETURN jsonb_build_object(
    'fromPlan', v_current_plan,
    'toPlan', v_target_plan,
    'lostFeatures', to_jsonb(v_lost_features),
    'retentionInfo', 'Your data is safe. Some features will be disabled.'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_plan_change(
  p_target_plan text,
  p_billing_cycle text DEFAULT 'monthly',
  p_payment_reference text DEFAULT NULL,
  p_change_type text DEFAULT 'upgrade'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_now timestamptz := now();
  v_target_plan text := lower(trim(COALESCE(p_target_plan, '')));
  v_cycle text := lower(trim(COALESCE(p_billing_cycle, 'monthly')));
  v_change_type text := lower(trim(COALESCE(p_change_type, 'upgrade')));
  v_current_plan text := 'starter';
  v_preview jsonb;
  v_proration_credit integer := 0;
  v_due_today integer := 0;
  v_next_renewal_amount integer;
  v_next_renewal_date timestamptz;
  v_unlocked jsonb := '[]'::jsonb;
  v_event_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context found';
  END IF;

  IF v_target_plan NOT IN ('starter', 'pro', 'business', 'enterprise') THEN
    RAISE EXCEPTION 'Invalid target plan';
  END IF;

  IF v_cycle NOT IN ('monthly', 'annual') THEN
    v_cycle := 'monthly';
  END IF;

  IF v_change_type NOT IN ('upgrade', 'downgrade') THEN
    v_change_type := 'upgrade';
  END IF;

  SELECT lower(COALESCE(s.plan, t.plan, 'starter'))
  INTO v_current_plan
  FROM public.tenants t
  LEFT JOIN public.subscriptions s
    ON s.tenant_id = t.id
  WHERE t.id = v_tenant_id
  LIMIT 1;

  v_preview := public.preview_plan_change(v_target_plan, v_cycle);

  IF COALESCE((v_preview ->> 'requiresSales')::boolean, false) THEN
    RAISE EXCEPTION 'Selected plan requires sales assistance';
  END IF;

  v_proration_credit := COALESCE((v_preview ->> 'prorationCreditCents')::integer, 0);
  v_due_today := COALESCE((v_preview ->> 'dueTodayCents')::integer, 0);
  v_next_renewal_amount := COALESCE((v_preview ->> 'nextRenewalAmountCents')::integer, 0);
  v_next_renewal_date := COALESCE((v_preview ->> 'nextRenewalDate')::timestamptz, v_now + interval '1 month');
  v_unlocked := COALESCE(v_preview -> 'gainedFeatures', '[]'::jsonb);

  INSERT INTO public.subscriptions (
    tenant_id,
    plan,
    status,
    billing_cycle,
    current_period_start,
    current_period_end,
    trial_ends_at
  )
  VALUES (
    v_tenant_id,
    v_target_plan,
    'active',
    v_cycle,
    v_now,
    CASE WHEN v_cycle = 'annual' THEN v_now + interval '1 year' ELSE v_now + interval '1 month' END,
    NULL
  )
  ON CONFLICT (tenant_id)
  DO UPDATE SET
    plan = EXCLUDED.plan,
    status = EXCLUDED.status,
    billing_cycle = EXCLUDED.billing_cycle,
    current_period_start = EXCLUDED.current_period_start,
    current_period_end = EXCLUDED.current_period_end,
    trial_ends_at = EXCLUDED.trial_ends_at;

  PERFORM public.reconcile_billing_state(v_tenant_id);

  INSERT INTO public.billing_plan_change_events (
    tenant_id,
    requested_by,
    change_type,
    from_plan,
    to_plan,
    billing_cycle,
    proration_credit_cents,
    due_today_cents,
    next_renewal_amount_cents,
    effective_at,
    status,
    payment_reference,
    metadata
  )
  VALUES (
    v_tenant_id,
    auth.uid(),
    v_change_type,
    v_current_plan,
    v_target_plan,
    v_cycle,
    v_proration_credit,
    v_due_today,
    v_next_renewal_amount,
    v_now,
    'applied',
    NULLIF(trim(COALESCE(p_payment_reference, '')), ''),
    jsonb_build_object(
      'preview', v_preview,
      'appliedAt', v_now
    )
  )
  RETURNING id INTO v_event_id;

  INSERT INTO public.billing_events (
    tenant_id,
    provider,
    provider_event_id,
    event_type,
    payload,
    status,
    processed_at
  )
  VALUES (
    v_tenant_id,
    'internal',
    'plan_change_' || v_event_id::text,
    'subscription.plan_changed',
    jsonb_build_object(
      'fromPlan', v_current_plan,
      'toPlan', v_target_plan,
      'billingCycle', v_cycle,
      'changeType', v_change_type,
      'dueTodayCents', v_due_today,
      'prorationCreditCents', v_proration_credit
    ),
    'processed',
    v_now
  )
  ON CONFLICT (provider, provider_event_id) DO NOTHING;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'billing.plan_change',
    'subscription',
    'success',
    jsonb_build_object(
      'fromPlan', v_current_plan,
      'toPlan', v_target_plan,
      'billingCycle', v_cycle,
      'changeType', v_change_type,
      'eventId', v_event_id,
      'dueTodayCents', v_due_today
    )
  );

  RETURN jsonb_build_object(
    'eventId', v_event_id,
    'fromPlan', v_current_plan,
    'toPlan', v_target_plan,
    'billingCycle', v_cycle,
    'changeType', v_change_type,
    'dueTodayCents', v_due_today,
    'prorationCreditCents', v_proration_credit,
    'nextRenewalAmountCents', v_next_renewal_amount,
    'nextRenewalDate', v_next_renewal_date,
    'newlyUnlockedFeatures', v_unlocked
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.plan_price_cents(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_billing_upgrade_options() TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_plan_change(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_plan_downgrade_impact(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_plan_change(text, text, text, text) TO authenticated;

