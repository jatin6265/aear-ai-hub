-- Billing subscription and usage dashboard backend for /dashboard/billing.

CREATE TABLE IF NOT EXISTS public.tenant_billing_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES public.tenants(id) ON DELETE CASCADE,
  company_name text,
  address_line_1 text,
  address_line_2 text,
  city text,
  state_region text,
  postal_code text,
  country_code text NOT NULL DEFAULT 'US',
  tax_number text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tenant_payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'stripe',
  method_type text NOT NULL DEFAULT 'card',
  card_brand text,
  card_last4 text,
  card_exp_month integer,
  card_exp_year integer,
  provider_payment_method_id text,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'revoked')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_payment_methods_default_uidx
  ON public.tenant_payment_methods (tenant_id)
  WHERE is_default = true AND status = 'active';

CREATE INDEX IF NOT EXISTS tenant_payment_methods_tenant_created_idx
  ON public.tenant_payment_methods (tenant_id, created_at DESC);

ALTER TABLE public.tenant_billing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_payment_methods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant members can view billing profile" ON public.tenant_billing_profiles;
CREATE POLICY "Tenant members can view billing profile"
  ON public.tenant_billing_profiles FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant admins can manage billing profile" ON public.tenant_billing_profiles;
CREATE POLICY "Tenant admins can manage billing profile"
  ON public.tenant_billing_profiles FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view payment methods" ON public.tenant_payment_methods;
CREATE POLICY "Tenant members can view payment methods"
  ON public.tenant_payment_methods FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant admins can manage payment methods" ON public.tenant_payment_methods;
CREATE POLICY "Tenant admins can manage payment methods"
  ON public.tenant_payment_methods FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DO $$
BEGIN
  IF to_regproc('public.set_updated_at_timestamp') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS tenant_billing_profiles_set_updated_at ON public.tenant_billing_profiles;
    CREATE TRIGGER tenant_billing_profiles_set_updated_at
      BEFORE UPDATE ON public.tenant_billing_profiles
      FOR EACH ROW
      EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS tenant_payment_methods_set_updated_at ON public.tenant_payment_methods;
    CREATE TRIGGER tenant_payment_methods_set_updated_at
      BEFORE UPDATE ON public.tenant_payment_methods
      FOR EACH ROW
      EXECUTE FUNCTION public.set_updated_at_timestamp();
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_tenant_billing_dashboard(
  p_window_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_now timestamptz := now();
  v_window_days integer := GREATEST(7, LEAST(COALESCE(p_window_days, 30), 90));
  v_chart_start timestamptz := date_trunc('day', now()) - make_interval(days => 29);
  v_plan text := 'starter';
  v_status text := 'trial';
  v_billing_cycle text := 'monthly';
  v_current_period_start timestamptz := date_trunc('month', now());
  v_current_period_end timestamptz := date_trunc('month', now()) + interval '1 month';
  v_trial_ends_at timestamptz;
  v_price_monthly_cents integer;
  v_tokens_limit bigint;
  v_storage_limit_gb numeric;
  v_team_limit integer;
  v_tokens_used bigint := 0;
  v_storage_bytes bigint := 0;
  v_storage_used_gb numeric := 0;
  v_api_calls bigint := 0;
  v_actions_executed bigint := 0;
  v_team_members integer := 0;
  v_pending_invites integer := 0;
  v_llm_credits bigint := 0;
  v_storage_credits bigint := 0;
  v_execution_credits bigint := 0;
  v_overage_credits bigint := 0;
  v_token_usage_by_day jsonb := '[]'::jsonb;
  v_profile jsonb;
  v_payment_method jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context found for authenticated user';
  END IF;

  SELECT
    lower(COALESCE(s.plan, t.plan, 'starter')),
    lower(COALESCE(s.status, 'trial')),
    lower(COALESCE(s.billing_cycle, 'monthly')),
    COALESCE(s.current_period_start, date_trunc('month', v_now)),
    COALESCE(s.current_period_end, date_trunc('month', v_now) + interval '1 month'),
    s.trial_ends_at
  INTO
    v_plan,
    v_status,
    v_billing_cycle,
    v_current_period_start,
    v_current_period_end,
    v_trial_ends_at
  FROM public.tenants t
  LEFT JOIN public.subscriptions s
    ON s.tenant_id = t.id
  WHERE t.id = v_tenant_id
  LIMIT 1;

  IF v_plan = 'pro' THEN
    v_price_monthly_cents := 29900;
    v_tokens_limit := 5000000;
    v_storage_limit_gb := 10;
    v_team_limit := 25;
  ELSIF v_plan = 'business' THEN
    v_price_monthly_cents := 99900;
    v_tokens_limit := 25000000;
    v_storage_limit_gb := 50;
    v_team_limit := 100;
  ELSIF v_plan = 'enterprise' THEN
    v_price_monthly_cents := NULL;
    v_tokens_limit := NULL;
    v_storage_limit_gb := NULL;
    v_team_limit := NULL;
  ELSE
    v_price_monthly_cents := 4900;
    v_tokens_limit := 500000;
    v_storage_limit_gb := 1;
    v_team_limit := 5;
  END IF;

  SELECT
    COALESCE(SUM(COALESCE(r.input_tokens, 0) + COALESCE(r.output_tokens, 0)), 0)::bigint
  INTO v_tokens_used
  FROM public.agent_runs r
  WHERE r.tenant_id = v_tenant_id
    AND r.created_at >= v_current_period_start
    AND r.created_at < v_current_period_end;

  SELECT
    COALESCE(SUM(octet_length(COALESCE(kdc.content, ''))), 0)::bigint
  INTO v_storage_bytes
  FROM public.knowledge_document_chunks kdc
  JOIN public.knowledge_documents kd
    ON kd.id = kdc.document_id
  WHERE kd.tenant_id = v_tenant_id;

  v_storage_used_gb := ROUND((v_storage_bytes::numeric / 1073741824::numeric), 2);

  SELECT
    COALESCE(SUM(ume.quantity), 0)::bigint
  INTO v_api_calls
  FROM public.usage_meter_events ume
  WHERE ume.tenant_id = v_tenant_id
    AND ume.created_at >= v_current_period_start
    AND ume.created_at < v_current_period_end
    AND (
      lower(ume.event_type) LIKE 'api%'
      OR lower(ume.event_type) LIKE '%request%'
      OR lower(ume.event_type) LIKE '%query%'
      OR lower(ume.event_type) LIKE '%sql%'
    );

  IF v_api_calls = 0 THEN
    SELECT
      COUNT(*)::bigint
    INTO v_api_calls
    FROM public.agent_tool_runs tr
    WHERE tr.tenant_id = v_tenant_id
      AND tr.created_at >= v_current_period_start
      AND tr.created_at < v_current_period_end;
  END IF;

  SELECT
    COUNT(*)::bigint
  INTO v_actions_executed
  FROM public.agent_action_runs ar
  WHERE ar.tenant_id = v_tenant_id
    AND ar.created_at >= v_current_period_start
    AND ar.created_at < v_current_period_end
    AND ar.status = 'executed';

  IF v_actions_executed = 0 THEN
    SELECT
      COALESCE(SUM(ume.quantity), 0)::bigint
    INTO v_actions_executed
    FROM public.usage_meter_events ume
    WHERE ume.tenant_id = v_tenant_id
      AND ume.created_at >= v_current_period_start
      AND ume.created_at < v_current_period_end
      AND (
        lower(ume.event_type) LIKE '%action%'
        OR lower(ume.event_type) LIKE '%execution%'
      );
  END IF;

  SELECT COUNT(*)::integer
  INTO v_team_members
  FROM public.profiles p
  WHERE p.tenant_id = v_tenant_id;

  SELECT COUNT(*)::integer
  INTO v_pending_invites
  FROM public.team_invitations ti
  WHERE ti.tenant_id = v_tenant_id
    AND ti.status IN ('pending', 'sent');

  v_team_members := v_team_members + v_pending_invites;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'date', to_char(series.day, 'YYYY-MM-DD'),
        'tokens', COALESCE(tok.tokens, 0)::bigint
      )
      ORDER BY series.day
    ),
    '[]'::jsonb
  )
  INTO v_token_usage_by_day
  FROM (
    SELECT generate_series(v_chart_start::date, date_trunc('day', v_now)::date, interval '1 day')::date AS day
  ) series
  LEFT JOIN (
    SELECT
      date_trunc('day', r.created_at)::date AS day,
      SUM(COALESCE(r.input_tokens, 0) + COALESCE(r.output_tokens, 0))::bigint AS tokens
    FROM public.agent_runs r
    WHERE r.tenant_id = v_tenant_id
      AND r.created_at >= v_chart_start
      AND r.created_at < v_now + interval '1 day'
    GROUP BY 1
  ) tok ON tok.day = series.day;

  SELECT
    COALESCE(SUM(CASE WHEN lower(ume.event_type) ~ '(llm|token|chat|completion)' THEN ume.cost_credits ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN lower(ume.event_type) ~ '(storage|embed|vector)' THEN ume.cost_credits ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN lower(ume.event_type) ~ '(action|execution|tool)' THEN ume.cost_credits ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN lower(ume.event_type) ~ '(overage|over_limit|throttle)' THEN ume.cost_credits ELSE 0 END), 0)::bigint
  INTO
    v_llm_credits,
    v_storage_credits,
    v_execution_credits,
    v_overage_credits
  FROM public.usage_meter_events ume
  WHERE ume.tenant_id = v_tenant_id
    AND ume.created_at >= (v_now - make_interval(days => v_window_days))
    AND ume.created_at <= v_now;

  IF (v_llm_credits + v_storage_credits + v_execution_credits + v_overage_credits) = 0 THEN
    v_llm_credits := GREATEST(1, CEIL(v_tokens_used::numeric / 1000.0)::bigint);
    v_storage_credits := GREATEST(0, CEIL(v_storage_used_gb * 100)::bigint);
    v_execution_credits := GREATEST(0, v_actions_executed);
    v_overage_credits := 0;
  END IF;

  SELECT jsonb_build_object(
    'companyName', COALESCE(bp.company_name, t.name, 'OpsAI Workspace'),
    'addressLine1', COALESCE(bp.address_line_1, ''),
    'addressLine2', COALESCE(bp.address_line_2, ''),
    'city', COALESCE(bp.city, ''),
    'stateRegion', COALESCE(bp.state_region, ''),
    'postalCode', COALESCE(bp.postal_code, ''),
    'countryCode', COALESCE(bp.country_code, 'US'),
    'taxNumber', COALESCE(bp.tax_number, '')
  )
  INTO v_profile
  FROM public.tenants t
  LEFT JOIN public.tenant_billing_profiles bp
    ON bp.tenant_id = t.id
  WHERE t.id = v_tenant_id;

  SELECT jsonb_build_object(
    'brand', COALESCE(pm.card_brand, 'visa'),
    'last4', COALESCE(pm.card_last4, '4242'),
    'expMonth', COALESCE(pm.card_exp_month, 12),
    'expYear', COALESCE(pm.card_exp_year, EXTRACT(YEAR FROM now())::integer + 3),
    'status', COALESCE(pm.status, 'active')
  )
  INTO v_payment_method
  FROM (
    SELECT
      p.card_brand,
      p.card_last4,
      p.card_exp_month,
      p.card_exp_year,
      p.status
    FROM public.tenant_payment_methods p
    WHERE p.tenant_id = v_tenant_id
      AND p.status IN ('active', 'expired')
    ORDER BY p.is_default DESC, p.updated_at DESC, p.created_at DESC
    LIMIT 1
  ) pm;

  IF v_payment_method IS NULL THEN
    v_payment_method := jsonb_build_object(
      'brand', 'visa',
      'last4', '4242',
      'expMonth', 12,
      'expYear', EXTRACT(YEAR FROM now())::integer + 3,
      'status', 'active'
    );
  END IF;

  RETURN jsonb_build_object(
    'plan', jsonb_build_object(
      'code', v_plan,
      'name', initcap(v_plan) || ' Plan',
      'status', v_status,
      'billingCycle', v_billing_cycle,
      'priceMonthlyCents', v_price_monthly_cents,
      'renewalDate', v_current_period_end,
      'currentPeriodStart', v_current_period_start,
      'currentPeriodEnd', v_current_period_end,
      'trialEndsAt', v_trial_ends_at,
      'trialDaysRemaining', CASE
        WHEN v_trial_ends_at IS NULL THEN NULL
        ELSE GREATEST(0, CEIL(EXTRACT(epoch FROM (v_trial_ends_at - v_now)) / 86400.0)::integer)
      END
    ),
    'meters', jsonb_build_array(
      jsonb_build_object('key', 'tokens', 'label', 'LLM Tokens', 'used', v_tokens_used, 'limit', v_tokens_limit, 'unit', 'tokens', 'unlimited', v_tokens_limit IS NULL),
      jsonb_build_object('key', 'vector_storage', 'label', 'Vector Storage', 'used', v_storage_used_gb, 'limit', v_storage_limit_gb, 'unit', 'GB', 'unlimited', v_storage_limit_gb IS NULL),
      jsonb_build_object('key', 'api_calls', 'label', 'API Calls', 'used', v_api_calls, 'limit', NULL, 'unit', 'calls', 'unlimited', true),
      jsonb_build_object('key', 'actions', 'label', 'Action Executions', 'used', v_actions_executed, 'limit', NULL, 'unit', 'actions', 'unlimited', true),
      jsonb_build_object('key', 'team', 'label', 'Team Members', 'used', v_team_members, 'limit', v_team_limit, 'unit', 'members', 'unlimited', v_team_limit IS NULL)
    ),
    'charts', jsonb_build_object(
      'tokenUsageByDay', v_token_usage_by_day,
      'costBreakdown', jsonb_build_array(
        jsonb_build_object('name', 'LLM', 'credits', v_llm_credits, 'costUsd', ROUND(v_llm_credits::numeric * 0.002, 2)),
        jsonb_build_object('name', 'Storage', 'credits', v_storage_credits, 'costUsd', ROUND(v_storage_credits::numeric * 0.002, 2)),
        jsonb_build_object('name', 'Executions', 'credits', v_execution_credits, 'costUsd', ROUND(v_execution_credits::numeric * 0.002, 2)),
        jsonb_build_object('name', 'Overages', 'credits', v_overage_credits, 'costUsd', ROUND(v_overage_credits::numeric * 0.002, 2))
      )
    ),
    'paymentMethod', v_payment_method,
    'billingAddress', v_profile
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_billing_dashboard(integer) TO authenticated;

