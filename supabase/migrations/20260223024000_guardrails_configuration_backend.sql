-- Guardrails configuration backend for /dashboard/guardrails.

CREATE OR REPLACE FUNCTION public.seed_guardrails_configuration_defaults(p_tenant_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer := 0;
BEGIN
  IF p_tenant_id IS NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO public.guardrails (
    tenant_id,
    code,
    name,
    description,
    enabled,
    risk_level,
    config,
    created_by
  )
  VALUES
    (
      p_tenant_id,
      'hard_mass_delete_without_where',
      'Mass DELETE without WHERE clause',
      'Always blocked to prevent accidental destructive writes.',
      true,
      'critical',
      jsonb_build_object('section', 'hard', 'mandatory', true, 'immutable', true, 'cannotDisableLabel', 'Cannot be disabled'),
      auth.uid()
    ),
    (
      p_tenant_id,
      'hard_drop_or_truncate',
      'DROP TABLE / TRUNCATE',
      'Always blocked in governed execution environments.',
      true,
      'critical',
      jsonb_build_object('section', 'hard', 'mandatory', true, 'immutable', true, 'cannotDisableLabel', 'Cannot be disabled'),
      auth.uid()
    ),
    (
      p_tenant_id,
      'hard_financial_without_accountable',
      'Financial ledger manipulation without Accountable approval',
      'Always blocked unless accountable approvals are present.',
      true,
      'critical',
      jsonb_build_object('section', 'hard', 'mandatory', true, 'immutable', true, 'cannotDisableLabel', 'Cannot be disabled'),
      auth.uid()
    ),
    (
      p_tenant_id,
      'hard_prompt_injection_filter',
      'Prompt injection patterns',
      'Always filtered prior to tool execution.',
      true,
      'critical',
      jsonb_build_object('section', 'hard', 'mandatory', true, 'immutable', true, 'cannotDisableLabel', 'Cannot be disabled'),
      auth.uid()
    ),
    (
      p_tenant_id,
      'hard_unknown_tool_reject',
      'Unknown tool execution',
      'Always rejected by policy engine.',
      true,
      'critical',
      jsonb_build_object('section', 'hard', 'mandatory', true, 'immutable', true, 'cannotDisableLabel', 'Cannot be disabled'),
      auth.uid()
    ),
    (
      p_tenant_id,
      'cfg_bulk_update_limit',
      'Bulk Update Limit',
      'Block updates affecting more than N rows without approval.',
      true,
      'high',
      jsonb_build_object('section', 'configurable', 'threshold', 100, 'unlimited', false),
      auth.uid()
    ),
    (
      p_tenant_id,
      'cfg_simulation_mode',
      'Simulation Mode',
      'Always show simulation preview before executing WRITE actions.',
      true,
      'medium',
      jsonb_build_object('section', 'configurable', 'alwaysPreviewWrite', true, 'recommended', true),
      auth.uid()
    ),
    (
      p_tenant_id,
      'cfg_business_hours_lock',
      'Business Hours Lock',
      'Block CRITICAL actions outside business hours.',
      true,
      'high',
      jsonb_build_object('section', 'configurable', 'start', '09:00', 'end', '18:00', 'timezone', 'UTC'),
      auth.uid()
    ),
    (
      p_tenant_id,
      'cfg_financial_mutation_limit',
      'Financial Mutation Limit',
      'Require dual approval for financial changes above a threshold amount.',
      true,
      'critical',
      jsonb_build_object('section', 'configurable', 'amount', 10000, 'currency', 'USD', 'dualApproval', true),
      auth.uid()
    ),
    (
      p_tenant_id,
      'cfg_new_user_restriction',
      'New User Restriction',
      'Users added in last N days can only use READ_ONLY actions.',
      true,
      'medium',
      jsonb_build_object('section', 'configurable', 'days', 7, 'readOnlyOnly', true),
      auth.uid()
    )
  ON CONFLICT (tenant_id, code) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_guardrails_configuration_payload()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role text := 'member';
  v_is_admin boolean := false;
  v_hard_rules jsonb := '[]'::jsonb;

  v_bulk public.guardrails%ROWTYPE;
  v_simulation public.guardrails%ROWTYPE;
  v_business public.guardrails%ROWTYPE;
  v_financial public.guardrails%ROWTYPE;
  v_new_user public.guardrails%ROWTYPE;

  v_bulk_threshold integer := 100;
  v_bulk_unlimited boolean := false;

  v_business_start text := '09:00';
  v_business_end text := '18:00';
  v_business_timezone text := 'UTC';

  v_financial_amount numeric := 10000;
  v_financial_currency text := 'USD';

  v_new_user_days integer := 7;

  v_updated_at timestamptz := NULL;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  PERFORM public.seed_default_guardrails(v_tenant_id);
  PERFORM public.seed_guardrails_configuration_defaults(v_tenant_id);

  SELECT lower(COALESCE(p.role, 'member'))
  INTO v_role
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.tenant_id = v_tenant_id
    AND COALESCE(p.status, 'active') = 'active';

  v_is_admin := v_role IN ('owner', 'admin');

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'code', g.code,
        'title', g.name,
        'description', g.description,
        'enabled', true,
        'badge', COALESCE(g.config ->> 'cannotDisableLabel', 'Cannot be disabled')
      )
      ORDER BY g.created_at ASC
    ),
    '[]'::jsonb
  )
  INTO v_hard_rules
  FROM public.guardrails g
  WHERE g.tenant_id = v_tenant_id
    AND (g.code LIKE 'hard_%' OR COALESCE(g.config ->> 'section', '') = 'hard');

  SELECT * INTO v_bulk
  FROM public.guardrails
  WHERE tenant_id = v_tenant_id
    AND code = 'cfg_bulk_update_limit'
  LIMIT 1;

  SELECT * INTO v_simulation
  FROM public.guardrails
  WHERE tenant_id = v_tenant_id
    AND code = 'cfg_simulation_mode'
  LIMIT 1;

  SELECT * INTO v_business
  FROM public.guardrails
  WHERE tenant_id = v_tenant_id
    AND code = 'cfg_business_hours_lock'
  LIMIT 1;

  SELECT * INTO v_financial
  FROM public.guardrails
  WHERE tenant_id = v_tenant_id
    AND code = 'cfg_financial_mutation_limit'
  LIMIT 1;

  SELECT * INTO v_new_user
  FROM public.guardrails
  WHERE tenant_id = v_tenant_id
    AND code = 'cfg_new_user_restriction'
  LIMIT 1;

  IF v_bulk.id IS NOT NULL THEN
    IF COALESCE(v_bulk.config ->> 'threshold', '') ~ '^[0-9]+$' THEN
      v_bulk_threshold := (v_bulk.config ->> 'threshold')::integer;
    END IF;
    v_bulk_unlimited := COALESCE((v_bulk.config ->> 'unlimited')::boolean, NOT v_bulk.enabled);
  END IF;

  IF v_business.id IS NOT NULL THEN
    v_business_start := COALESCE(NULLIF(v_business.config ->> 'start', ''), '09:00');
    v_business_end := COALESCE(NULLIF(v_business.config ->> 'end', ''), '18:00');
    v_business_timezone := COALESCE(NULLIF(v_business.config ->> 'timezone', ''), 'UTC');
  END IF;

  IF v_financial.id IS NOT NULL THEN
    IF COALESCE(v_financial.config ->> 'amount', '') ~ '^[0-9]+(\.[0-9]+)?$' THEN
      v_financial_amount := (v_financial.config ->> 'amount')::numeric;
    END IF;
    v_financial_currency := COALESCE(NULLIF(v_financial.config ->> 'currency', ''), 'USD');
  END IF;

  IF v_new_user.id IS NOT NULL THEN
    IF COALESCE(v_new_user.config ->> 'days', '') ~ '^[0-9]+$' THEN
      v_new_user_days := (v_new_user.config ->> 'days')::integer;
    END IF;
  END IF;

  SELECT MAX(g.updated_at)
  INTO v_updated_at
  FROM public.guardrails g
  WHERE g.tenant_id = v_tenant_id
    AND (g.code LIKE 'cfg_%' OR g.code LIKE 'hard_%');

  RETURN jsonb_build_object(
    'profileRole', v_role,
    'isAdmin', v_is_admin,
    'hardGuardrails', v_hard_rules,
    'configuration', jsonb_build_object(
      'bulkUpdateLimit', jsonb_build_object(
        'enabled', COALESCE(v_bulk.enabled, true),
        'threshold', v_bulk_threshold,
        'unlimited', v_bulk_unlimited
      ),
      'simulationMode', jsonb_build_object(
        'enabled', COALESCE(v_simulation.enabled, true)
      ),
      'businessHoursLock', jsonb_build_object(
        'enabled', COALESCE(v_business.enabled, true),
        'start', v_business_start,
        'end', v_business_end,
        'timezone', v_business_timezone
      ),
      'financialMutationLimit', jsonb_build_object(
        'enabled', COALESCE(v_financial.enabled, true),
        'amount', v_financial_amount,
        'currency', v_financial_currency
      ),
      'newUserRestriction', jsonb_build_object(
        'enabled', COALESCE(v_new_user.enabled, true),
        'days', v_new_user_days
      )
    ),
    'updatedAt', v_updated_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_guardrails_configuration(
  p_bulk_update_limit text,
  p_simulation_mode_enabled boolean,
  p_business_hours_lock_enabled boolean,
  p_business_start text,
  p_business_end text,
  p_business_timezone text,
  p_financial_limit numeric,
  p_financial_currency text,
  p_new_user_days integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role text := 'member';

  v_bulk_raw text := lower(trim(COALESCE(p_bulk_update_limit, '100')));
  v_bulk_threshold integer := 100;
  v_bulk_unlimited boolean := false;

  v_timezone text := trim(COALESCE(p_business_timezone, 'UTC'));
  v_start text := trim(COALESCE(p_business_start, '09:00'));
  v_end text := trim(COALESCE(p_business_end, '18:00'));

  v_financial_limit numeric := COALESCE(p_financial_limit, 10000);
  v_currency text := upper(trim(COALESCE(p_financial_currency, 'USD')));

  v_new_user_days integer := COALESCE(p_new_user_days, 7);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  SELECT lower(COALESCE(p.role, 'member'))
  INTO v_role
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.tenant_id = v_tenant_id
    AND COALESCE(p.status, 'active') = 'active';

  IF v_role NOT IN ('owner', 'admin', 'manager') THEN
    RAISE EXCEPTION 'Only owner/admin/manager can update guardrails configuration';
  END IF;

  PERFORM public.seed_default_guardrails(v_tenant_id);
  PERFORM public.seed_guardrails_configuration_defaults(v_tenant_id);

  IF v_bulk_raw IN ('unlimited', 'none', 'off') THEN
    v_bulk_unlimited := true;
    v_bulk_threshold := 1000;
  ELSE
    IF v_bulk_raw !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'Bulk update limit must be one of: 10, 100, 500, 1000, Unlimited';
    END IF;

    v_bulk_threshold := v_bulk_raw::integer;

    IF v_bulk_threshold NOT IN (10, 100, 500, 1000) THEN
      RAISE EXCEPTION 'Bulk update limit must be one of: 10, 100, 500, 1000, Unlimited';
    END IF;
  END IF;

  IF v_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR v_end !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    RAISE EXCEPTION 'Business hours must be in HH:MM 24h format';
  END IF;

  IF length(v_timezone) = 0 OR length(v_timezone) > 80 THEN
    RAISE EXCEPTION 'Timezone is required and must be under 80 characters';
  END IF;

  IF v_financial_limit < 0 OR v_financial_limit > 1000000000 THEN
    RAISE EXCEPTION 'Financial mutation limit must be between 0 and 1,000,000,000';
  END IF;

  IF v_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Currency must be a valid 3-letter code';
  END IF;

  IF v_new_user_days < 0 OR v_new_user_days > 365 THEN
    RAISE EXCEPTION 'New user restriction days must be between 0 and 365';
  END IF;

  -- enforce hard guardrails remain enabled
  UPDATE public.guardrails
  SET
    enabled = true,
    config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('mandatory', true, 'immutable', true, 'cannotDisableLabel', 'Cannot be disabled')
  WHERE tenant_id = v_tenant_id
    AND code LIKE 'hard_%';

  UPDATE public.guardrails
  SET
    enabled = NOT v_bulk_unlimited,
    risk_level = 'high',
    config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('section', 'configurable', 'threshold', v_bulk_threshold, 'unlimited', v_bulk_unlimited)
  WHERE tenant_id = v_tenant_id
    AND code = 'cfg_bulk_update_limit';

  UPDATE public.guardrails
  SET
    enabled = COALESCE(p_simulation_mode_enabled, true),
    risk_level = 'medium',
    config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('section', 'configurable', 'alwaysPreviewWrite', COALESCE(p_simulation_mode_enabled, true), 'recommended', true)
  WHERE tenant_id = v_tenant_id
    AND code = 'cfg_simulation_mode';

  UPDATE public.guardrails
  SET
    enabled = COALESCE(p_business_hours_lock_enabled, true),
    risk_level = 'high',
    config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('section', 'configurable', 'start', v_start, 'end', v_end, 'timezone', v_timezone)
  WHERE tenant_id = v_tenant_id
    AND code = 'cfg_business_hours_lock';

  UPDATE public.guardrails
  SET
    enabled = v_financial_limit > 0,
    risk_level = 'critical',
    config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('section', 'configurable', 'amount', v_financial_limit, 'currency', v_currency, 'dualApproval', true)
  WHERE tenant_id = v_tenant_id
    AND code = 'cfg_financial_mutation_limit';

  UPDATE public.guardrails
  SET
    enabled = v_new_user_days > 0,
    risk_level = 'medium',
    config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('section', 'configurable', 'days', v_new_user_days, 'readOnlyOnly', true)
  WHERE tenant_id = v_tenant_id
    AND code = 'cfg_new_user_restriction';

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, risk_level, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'guardrails.configuration.update',
    'guardrails',
    'medium',
    'success',
    jsonb_build_object(
      'bulkUpdateLimit', CASE WHEN v_bulk_unlimited THEN 'unlimited' ELSE v_bulk_threshold::text END,
      'simulationModeEnabled', COALESCE(p_simulation_mode_enabled, true),
      'businessHoursLock', jsonb_build_object('enabled', COALESCE(p_business_hours_lock_enabled, true), 'start', v_start, 'end', v_end, 'timezone', v_timezone),
      'financialMutationLimit', jsonb_build_object('amount', v_financial_limit, 'currency', v_currency),
      'newUserRestrictionDays', v_new_user_days
    )
  );

  RETURN public.get_guardrails_configuration_payload();
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_guardrails_configuration_defaults(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_guardrails_configuration_payload() TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_guardrails_configuration(text, boolean, boolean, text, text, text, numeric, text, integer) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'guardrails'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.guardrails';
  END IF;
END;
$$;
