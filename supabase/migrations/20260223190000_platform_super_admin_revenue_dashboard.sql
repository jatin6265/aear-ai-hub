-- Platform Super Admin revenue dashboard backend for /platform-admin/revenue.

CREATE OR REPLACE FUNCTION public.plan_mrr_usd(
  p_plan text,
  p_billing_cycle text DEFAULT 'monthly'
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan text := lower(trim(COALESCE(p_plan, 'starter')));
  v_cycle text := lower(trim(COALESCE(p_billing_cycle, 'monthly')));
  v_price_cents integer := NULL;
  v_mrr numeric := 0;
BEGIN
  IF to_regproc('public.plan_price_cents') IS NOT NULL THEN
    v_price_cents := public.plan_price_cents(v_plan, v_cycle);
  END IF;

  IF v_price_cents IS NULL THEN
    v_price_cents := CASE v_plan
      WHEN 'pro' THEN CASE WHEN v_cycle = 'annual' THEN (29900 * 12 - 60000) ELSE 29900 END
      WHEN 'business' THEN CASE WHEN v_cycle = 'annual' THEN (99900 * 12 - 180000) ELSE 99900 END
      WHEN 'enterprise' THEN 0
      ELSE CASE WHEN v_cycle = 'annual' THEN (4900 * 12 - 12000) ELSE 4900 END
    END;
  END IF;

  IF v_cycle = 'annual' THEN
    v_mrr := (COALESCE(v_price_cents, 0)::numeric / 100.0) / 12.0;
  ELSE
    v_mrr := COALESCE(v_price_cents, 0)::numeric / 100.0;
  END IF;

  RETURN ROUND(v_mrr, 2);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_platform_super_admin_revenue_dashboard(
  p_months integer DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_months integer := GREATEST(6, LEAST(COALESCE(p_months, 12), 24));
  v_start_month timestamptz := date_trunc('month', v_now) - make_interval(months => GREATEST(0, v_months - 1));
  v_this_month_start timestamptz := date_trunc('month', v_now);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Forbidden: platform admin access required';
  END IF;

  RETURN (
    WITH month_series AS (
      SELECT
        (v_start_month + make_interval(months => gs.i))::timestamptz AS month_start
      FROM generate_series(0, v_months - 1) AS gs(i)
    ),
    tenant_base AS (
      SELECT
        t.id,
        t.name,
        t.created_at,
        COALESCE(t.updated_at, t.created_at) AS updated_at,
        lower(COALESCE(s.plan, t.plan, 'starter')) AS plan,
        lower(COALESCE(s.status, t.status, 'trial')) AS status,
        lower(COALESCE(s.billing_cycle, 'monthly')) AS billing_cycle,
        COALESCE(s.trial_ends_at, t.created_at + interval '14 days') AS trial_ends_at,
        public.plan_mrr_usd(
          lower(COALESCE(s.plan, t.plan, 'starter')),
          lower(COALESCE(s.billing_cycle, 'monthly'))
        ) AS mrr
      FROM public.tenants t
      LEFT JOIN public.subscriptions s
        ON s.tenant_id = t.id
    ),
    monthly_revenue AS (
      SELECT
        ms.month_start,
        COALESCE(
          SUM(
            CASE
              WHEN tb.created_at < ms.month_start + interval '1 month'
                AND NOT (tb.status = 'cancelled' AND tb.updated_at < ms.month_start)
              THEN tb.mrr
              ELSE 0
            END
          ),
          0
        )::numeric(12,2) AS mrr,
        COALESCE(
          SUM(
            CASE
              WHEN tb.plan = 'starter'
                AND tb.created_at < ms.month_start + interval '1 month'
                AND NOT (tb.status = 'cancelled' AND tb.updated_at < ms.month_start)
              THEN tb.mrr
              ELSE 0
            END
          ),
          0
        )::numeric(12,2) AS starter_mrr,
        COALESCE(
          SUM(
            CASE
              WHEN tb.plan = 'pro'
                AND tb.created_at < ms.month_start + interval '1 month'
                AND NOT (tb.status = 'cancelled' AND tb.updated_at < ms.month_start)
              THEN tb.mrr
              ELSE 0
            END
          ),
          0
        )::numeric(12,2) AS pro_mrr,
        COALESCE(
          SUM(
            CASE
              WHEN tb.plan = 'business'
                AND tb.created_at < ms.month_start + interval '1 month'
                AND NOT (tb.status = 'cancelled' AND tb.updated_at < ms.month_start)
              THEN tb.mrr
              ELSE 0
            END
          ),
          0
        )::numeric(12,2) AS business_mrr,
        COALESCE(
          SUM(
            CASE
              WHEN tb.plan = 'enterprise'
                AND tb.created_at < ms.month_start + interval '1 month'
                AND NOT (tb.status = 'cancelled' AND tb.updated_at < ms.month_start)
              THEN tb.mrr
              ELSE 0
            END
          ),
          0
        )::numeric(12,2) AS enterprise_mrr
      FROM month_series ms
      CROSS JOIN tenant_base tb
      GROUP BY ms.month_start
      ORDER BY ms.month_start
    ),
    new_vs_churned AS (
      SELECT
        ms.month_start,
        COUNT(*) FILTER (
          WHERE t.created_at >= ms.month_start
            AND t.created_at < ms.month_start + interval '1 month'
        )::integer AS new_tenants,
        COUNT(*) FILTER (
          WHERE lower(COALESCE(s.status, t.status, 'trial')) = 'cancelled'
            AND COALESCE(t.updated_at, t.created_at) >= ms.month_start
            AND COALESCE(t.updated_at, t.created_at) < ms.month_start + interval '1 month'
        )::integer AS churned_tenants
      FROM month_series ms
      LEFT JOIN public.tenants t ON true
      LEFT JOIN public.subscriptions s
        ON s.tenant_id = t.id
      GROUP BY ms.month_start
      ORDER BY ms.month_start
    ),
    engagement AS (
      SELECT
        tb.id AS tenant_id,
        COALESCE(
          (
            SELECT SUM(COALESCE(u.quantity, 0))
            FROM public.usage_events u
            WHERE u.tenant_id = tb.id
              AND u.recorded_at >= v_now - interval '14 days'
          ),
          0
        )::numeric AS usage_recent,
        COALESCE(
          (
            SELECT SUM(COALESCE(u.quantity, 0))
            FROM public.usage_events u
            WHERE u.tenant_id = tb.id
              AND u.recorded_at >= v_now - interval '28 days'
              AND u.recorded_at < v_now - interval '14 days'
          ),
          0
        )::numeric AS usage_prev,
        COALESCE(
          (
            SELECT MAX(COALESCE(p.last_active_at, p.updated_at, p.created_at))
            FROM public.profiles p
            WHERE p.tenant_id = tb.id
              AND COALESCE(p.status, 'active') <> 'removed'
          ),
          tb.created_at
        ) AS last_active_at
      FROM tenant_base tb
    ),
    churn_risk AS (
      SELECT
        tb.id,
        tb.name,
        tb.plan,
        tb.status,
        tb.mrr,
        tb.created_at,
        tb.trial_ends_at,
        eg.usage_recent,
        eg.usage_prev,
        eg.last_active_at,
        CASE
          WHEN eg.usage_prev <= 0 AND eg.usage_recent <= 0 THEN 40
          WHEN eg.usage_prev <= 0 THEN 0
          ELSE GREATEST(0, LEAST(100, ROUND(((eg.usage_prev - eg.usage_recent) / eg.usage_prev) * 100)))
        END::integer AS usage_drop_pct,
        GREATEST(0, FLOOR(EXTRACT(epoch FROM (v_now - eg.last_active_at)) / 86400.0))::integer AS inactive_days,
        CASE
          WHEN tb.trial_ends_at IS NULL THEN NULL
          ELSE CEIL(EXTRACT(epoch FROM (tb.trial_ends_at - v_now)) / 86400.0)::integer
        END AS trial_days_remaining,
        LEAST(
          99,
          GREATEST(
            0,
            (
              CASE
                WHEN (
                  CASE
                    WHEN eg.usage_prev <= 0 AND eg.usage_recent <= 0 THEN 40
                    WHEN eg.usage_prev <= 0 THEN 0
                    ELSE GREATEST(0, LEAST(100, ROUND(((eg.usage_prev - eg.usage_recent) / eg.usage_prev) * 100)))
                  END
                ) >= 60 THEN 45
                WHEN (
                  CASE
                    WHEN eg.usage_prev <= 0 AND eg.usage_recent <= 0 THEN 40
                    WHEN eg.usage_prev <= 0 THEN 0
                    ELSE GREATEST(0, LEAST(100, ROUND(((eg.usage_prev - eg.usage_recent) / eg.usage_prev) * 100)))
                  END
                ) >= 35 THEN 28
                WHEN (
                  CASE
                    WHEN eg.usage_prev <= 0 AND eg.usage_recent <= 0 THEN 40
                    WHEN eg.usage_prev <= 0 THEN 0
                    ELSE GREATEST(0, LEAST(100, ROUND(((eg.usage_prev - eg.usage_recent) / eg.usage_prev) * 100)))
                  END
                ) >= 20 THEN 12
                ELSE 0
              END
              + CASE
                  WHEN FLOOR(EXTRACT(epoch FROM (v_now - eg.last_active_at)) / 86400.0) >= 14 THEN 35
                  WHEN FLOOR(EXTRACT(epoch FROM (v_now - eg.last_active_at)) / 86400.0) >= 7 THEN 20
                  WHEN FLOOR(EXTRACT(epoch FROM (v_now - eg.last_active_at)) / 86400.0) >= 3 THEN 10
                  ELSE 0
                END
              + CASE
                  WHEN tb.status = 'trial'
                    AND tb.trial_ends_at IS NOT NULL
                    AND tb.trial_ends_at >= v_now
                    AND tb.trial_ends_at <= v_now + interval '3 days' THEN 20
                  WHEN tb.status = 'trial'
                    AND tb.trial_ends_at IS NOT NULL
                    AND tb.trial_ends_at > v_now + interval '3 days'
                    AND tb.trial_ends_at <= v_now + interval '7 days' THEN 10
                  ELSE 0
                END
            )
          )
        )::integer AS churn_risk_pct
      FROM tenant_base tb
      LEFT JOIN engagement eg
        ON eg.tenant_id = tb.id
    ),
    top_tenants AS (
      SELECT
        cr.id AS tenant_id,
        cr.name AS company,
        cr.plan,
        cr.mrr,
        cr.created_at AS since,
        ROUND(cr.mrr * GREATEST(1, CEIL(EXTRACT(epoch FROM (v_now - cr.created_at)) / (86400.0 * 30.0))), 2) AS ltv,
        cr.churn_risk_pct
      FROM churn_risk cr
      ORDER BY cr.mrr DESC, cr.created_at ASC
      LIMIT 20
    ),
    churn_signals AS (
      SELECT
        cr.id AS tenant_id,
        cr.name AS company,
        cr.churn_risk_pct,
        trim(both ', ' FROM concat_ws(', ',
          CASE WHEN cr.usage_drop_pct >= 20 THEN format('usage dropped %s%%', cr.usage_drop_pct) END,
          CASE WHEN cr.inactive_days >= 3 THEN format('no login in %s days', cr.inactive_days) END,
          CASE WHEN cr.status = 'trial' AND cr.trial_days_remaining IS NOT NULL AND cr.trial_days_remaining >= 0 AND cr.trial_days_remaining <= 7
            THEN format('trial ending in %s days', cr.trial_days_remaining)
          END
        )) AS reasons
      FROM churn_risk cr
      WHERE cr.churn_risk_pct >= 35
      ORDER BY cr.churn_risk_pct DESC, cr.mrr DESC
      LIMIT 12
    ),
    current_prev AS (
      SELECT
        (SELECT mr.mrr FROM monthly_revenue mr ORDER BY mr.month_start DESC LIMIT 1) AS current_mrr,
        (SELECT mr.mrr FROM monthly_revenue mr ORDER BY mr.month_start DESC OFFSET 1 LIMIT 1) AS prev_mrr
    ),
    month_kpis AS (
      SELECT
        COALESCE(
          SUM(tb.mrr) FILTER (
            WHERE tb.created_at >= v_this_month_start
              AND tb.created_at < v_this_month_start + interval '1 month'
          ),
          0
        )::numeric(12,2) AS new_mrr_this_month,
        COUNT(*) FILTER (
          WHERE tb.created_at < v_this_month_start
            AND NOT (tb.status = 'cancelled' AND tb.updated_at < v_this_month_start)
        )::integer AS active_at_month_start,
        COUNT(*) FILTER (
          WHERE tb.status = 'cancelled'
            AND tb.updated_at >= v_this_month_start
            AND tb.updated_at < v_this_month_start + interval '1 month'
        )::integer AS churned_this_month,
        COUNT(*) FILTER (
          WHERE tb.created_at >= v_now - interval '90 days'
        )::integer AS signed_up_90d,
        COUNT(*) FILTER (
          WHERE tb.created_at >= v_now - interval '90 days'
            AND EXISTS (
              SELECT 1
              FROM public.api_connections c
              WHERE c.tenant_id = tb.id
                AND COALESCE(c.is_archived, false) = false
            )
        )::integer AS activated_90d,
        COUNT(*) FILTER (
          WHERE tb.created_at >= v_now - interval '90 days'
            AND tb.status = 'trial'
        )::integer AS trial_90d,
        COUNT(*) FILTER (
          WHERE tb.created_at >= v_now - interval '90 days'
            AND tb.status = 'active'
        )::integer AS paid_90d
      FROM tenant_base tb
    ),
    expansion AS (
      SELECT
        COALESCE(
          SUM(
            GREATEST(
              0,
              public.plan_mrr_usd(e.to_plan, e.billing_cycle)
              - public.plan_mrr_usd(e.from_plan, e.billing_cycle)
            )
          ),
          0
        )::numeric(12,2) AS expansion_mrr
      FROM public.billing_plan_change_events e
      WHERE lower(COALESCE(e.change_type, '')) = 'upgrade'
        AND lower(COALESCE(e.status, '')) IN ('applied', 'pending')
        AND e.created_at >= v_this_month_start
        AND e.created_at < v_this_month_start + interval '1 month'
    )
    SELECT jsonb_build_object(
      'generatedAt', v_now,
      'months', v_months,
      'metrics', jsonb_build_object(
        'mrr', COALESCE(cp.current_mrr, 0),
        'mrrMoMChangePct', CASE
          WHEN COALESCE(cp.prev_mrr, 0) <= 0 THEN NULL
          ELSE ROUND(((COALESCE(cp.current_mrr, 0) - cp.prev_mrr) / cp.prev_mrr) * 100, 2)
        END,
        'arr', ROUND(COALESCE(cp.current_mrr, 0) * 12, 2),
        'churnRatePct', CASE
          WHEN mk.active_at_month_start <= 0 THEN 0
          ELSE ROUND((mk.churned_this_month::numeric / mk.active_at_month_start::numeric) * 100, 2)
        END,
        'newMrrThisMonth', mk.new_mrr_this_month,
        'expansionMrr', ex.expansion_mrr,
        'trialConversionRatePct', CASE
          WHEN mk.trial_90d + mk.paid_90d <= 0 THEN 0
          ELSE ROUND((mk.paid_90d::numeric / (mk.trial_90d + mk.paid_90d)::numeric) * 100, 2)
        END
      ),
      'charts', jsonb_build_object(
        'mrrGrowth', (
          SELECT COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'month', to_char(mr.month_start, 'YYYY-MM'),
                'label', to_char(mr.month_start, 'Mon YY'),
                'mrr', mr.mrr
              )
              ORDER BY mr.month_start
            ),
            '[]'::jsonb
          )
          FROM monthly_revenue mr
        ),
        'revenueByPlan', (
          SELECT COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'month', to_char(mr.month_start, 'YYYY-MM'),
                'label', to_char(mr.month_start, 'Mon YY'),
                'starter', mr.starter_mrr,
                'pro', mr.pro_mrr,
                'business', mr.business_mrr,
                'enterprise', mr.enterprise_mrr,
                'total', mr.mrr
              )
              ORDER BY mr.month_start
            ),
            '[]'::jsonb
          )
          FROM monthly_revenue mr
        ),
        'newVsChurned', (
          SELECT COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'month', to_char(nc.month_start, 'YYYY-MM'),
                'label', to_char(nc.month_start, 'Mon YY'),
                'newTenants', nc.new_tenants,
                'churnedTenants', nc.churned_tenants
              )
              ORDER BY nc.month_start
            ),
            '[]'::jsonb
          )
          FROM new_vs_churned nc
        ),
        'trialConversionFunnel', jsonb_build_array(
          jsonb_build_object('stage', 'Signed Up', 'count', mk.signed_up_90d),
          jsonb_build_object('stage', 'Activated', 'count', mk.activated_90d),
          jsonb_build_object('stage', 'Trial', 'count', mk.trial_90d),
          jsonb_build_object('stage', 'Paid', 'count', mk.paid_90d)
        )
      ),
      'topTenantsByMrr', (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'tenantId', tt.tenant_id,
              'company', tt.company,
              'plan', tt.plan,
              'mrr', tt.mrr,
              'since', tt.since,
              'ltv', tt.ltv,
              'churnRiskPct', tt.churn_risk_pct
            )
            ORDER BY tt.mrr DESC
          ),
          '[]'::jsonb
        )
        FROM top_tenants tt
      ),
      'churnRiskSignals', (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'tenantId', cs.tenant_id,
              'company', cs.company,
              'churnRiskPct', cs.churn_risk_pct,
              'reason', NULLIF(cs.reasons, ''),
              'suggestedAction', 'Send retention email'
            )
            ORDER BY cs.churn_risk_pct DESC
          ),
          '[]'::jsonb
        )
        FROM churn_signals cs
      )
    )
    FROM current_prev cp
    CROSS JOIN month_kpis mk
    CROSS JOIN expansion ex
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_admin_send_retention_email(
  p_tenant_id uuid,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Forbidden: platform admin access required';
  END IF;

  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant id is required';
  END IF;

  SELECT t.name
  INTO v_tenant_name
  FROM public.tenants t
  WHERE t.id = p_tenant_id
  LIMIT 1;

  IF v_tenant_name IS NULL THEN
    RAISE EXCEPTION 'Tenant not found';
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    p_tenant_id,
    auth.uid(),
    'platform_admin.retention_email',
    'tenant',
    'success',
    jsonb_build_object(
      'note', NULLIF(trim(COALESCE(p_note, '')), ''),
      'source', 'platform_admin_revenue_dashboard',
      'delivery', 'mock'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'tenantId', p_tenant_id,
    'tenantName', v_tenant_name,
    'status', 'queued',
    'mode', 'mock',
    'message', 'Retention email workflow queued.'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.plan_mrr_usd(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_platform_super_admin_revenue_dashboard(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_admin_send_retention_email(uuid, text) TO authenticated;
