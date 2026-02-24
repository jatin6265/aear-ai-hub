-- Tenant Admin analytics dashboard backend for /dashboard/admin/analytics.

CREATE TABLE IF NOT EXISTS public.tenant_admin_report_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  weekly_email_report_enabled boolean NOT NULL DEFAULT false,
  report_timezone text NOT NULL DEFAULT 'UTC',
  report_day_of_week integer NOT NULL DEFAULT 1 CHECK (report_day_of_week BETWEEN 0 AND 6),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tenant_admin_report_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tenant_admin_report_settings'
      AND policyname = 'Tenant members can view admin report settings'
  ) THEN
    CREATE POLICY "Tenant members can view admin report settings"
      ON public.tenant_admin_report_settings
      FOR SELECT TO authenticated
      USING (tenant_id = public.get_user_tenant_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tenant_admin_report_settings'
      AND policyname = 'Tenant members can manage admin report settings'
  ) THEN
    CREATE POLICY "Tenant members can manage admin report settings"
      ON public.tenant_admin_report_settings
      FOR ALL TO authenticated
      USING (tenant_id = public.get_user_tenant_id())
      WITH CHECK (tenant_id = public.get_user_tenant_id());
  END IF;
END;
$$;

DO $$
BEGIN
  IF to_regproc('public.set_updated_at_timestamp') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS tenant_admin_report_settings_set_updated_at ON public.tenant_admin_report_settings;
    CREATE TRIGGER tenant_admin_report_settings_set_updated_at
      BEFORE UPDATE ON public.tenant_admin_report_settings
      FOR EACH ROW
      EXECUTE FUNCTION public.set_updated_at_timestamp();
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_tenant_admin_analytics_payload(
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role text := 'member';

  v_from_date date := COALESCE(p_date_from, (now()::date - 6));
  v_to_date date := COALESCE(p_date_to, now()::date);

  v_from_ts timestamptz;
  v_to_ts timestamptz;

  v_days integer := 7;
  v_prev_from date;
  v_prev_to date;
  v_prev_from_ts timestamptz;
  v_prev_to_ts timestamptz;

  v_total_ai_queries integer := 0;
  v_actions_executed integer := 0;
  v_avg_response_time numeric := 0;
  v_approval_rate numeric := 0;
  v_data_sources_queried integer := 0;

  v_queries_per_day jsonb := '[]'::jsonb;
  v_agent_keys jsonb := '[]'::jsonb;
  v_response_distribution jsonb := '[]'::jsonb;
  v_most_active_users jsonb := '[]'::jsonb;
  v_queried_resources jsonb := '[]'::jsonb;
  v_action_breakdown jsonb := '[]'::jsonb;
  v_agent_performance jsonb := '[]'::jsonb;

  v_input_tokens bigint := 0;
  v_output_tokens bigint := 0;
  v_total_tokens bigint := 0;
  v_prev_total_tokens bigint := 0;
  v_estimated_cost numeric := 0;
  v_plan text := 'starter';
  v_discount numeric := 1.0;
  v_token_trend_pct numeric := 0;

  v_weekly_email_enabled boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  IF v_from_date > v_to_date THEN
    RAISE EXCEPTION 'dateFrom must be before or equal to dateTo';
  END IF;

  SELECT lower(COALESCE(p.role, 'member'))
  INTO v_role
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.tenant_id = v_tenant_id
    AND COALESCE(p.status, 'active') = 'active';

  IF v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  v_days := GREATEST((v_to_date - v_from_date + 1), 1);

  v_prev_from := (v_from_date - v_days);
  v_prev_to := (v_from_date - 1);

  v_from_ts := v_from_date::timestamptz;
  v_to_ts := (v_to_date + 1)::timestamptz;

  v_prev_from_ts := v_prev_from::timestamptz;
  v_prev_to_ts := (v_prev_to + 1)::timestamptz;

  INSERT INTO public.tenant_admin_report_settings (tenant_id)
  VALUES (v_tenant_id)
  ON CONFLICT (tenant_id) DO NOTHING;

  SELECT COALESCE(tars.weekly_email_report_enabled, false)
  INTO v_weekly_email_enabled
  FROM public.tenant_admin_report_settings tars
  WHERE tars.tenant_id = v_tenant_id;

  -- Top metrics
  SELECT COUNT(*)::integer
  INTO v_total_ai_queries
  FROM public.chat_messages m
  JOIN public.chat_sessions s
    ON s.id = m.session_id
  WHERE s.tenant_id = v_tenant_id
    AND lower(COALESCE(m.role, '')) = 'user'
    AND m.created_at >= v_from_ts
    AND m.created_at < v_to_ts;

  SELECT COUNT(*)::integer
  INTO v_actions_executed
  FROM public.agent_action_runs aar
  WHERE aar.tenant_id = v_tenant_id
    AND aar.created_at >= v_from_ts
    AND aar.created_at < v_to_ts;

  WITH latency_samples AS (
    SELECT csr.execution_ms::numeric AS latency
    FROM public.chat_sql_runs csr
    WHERE csr.tenant_id = v_tenant_id
      AND csr.created_at >= v_from_ts
      AND csr.created_at < v_to_ts

    UNION ALL

    SELECT atr.latency_ms::numeric AS latency
    FROM public.agent_tool_runs atr
    WHERE atr.tenant_id = v_tenant_id
      AND atr.created_at >= v_from_ts
      AND atr.created_at < v_to_ts
      AND atr.latency_ms IS NOT NULL
      AND atr.latency_ms > 0
  )
  SELECT COALESCE(ROUND(AVG(ls.latency), 2), 0)
  INTO v_avg_response_time
  FROM latency_samples ls;

  WITH approval_stats AS (
    SELECT
      COUNT(*)::numeric AS total_count,
      COUNT(*) FILTER (WHERE lower(COALESCE(ar.status, '')) = 'approved')::numeric AS approved_count
    FROM public.approval_requests ar
    WHERE ar.tenant_id = v_tenant_id
      AND ar.created_at >= v_from_ts
      AND ar.created_at < v_to_ts
  )
  SELECT COALESCE(
    ROUND((approved_count / NULLIF(total_count, 0)) * 100, 2),
    0
  )
  INTO v_approval_rate
  FROM approval_stats;

  SELECT COUNT(DISTINCT csr.connection_id)::integer
  INTO v_data_sources_queried
  FROM public.chat_sql_runs csr
  WHERE csr.tenant_id = v_tenant_id
    AND csr.created_at >= v_from_ts
    AND csr.created_at < v_to_ts
    AND csr.connection_id IS NOT NULL;

  -- Queries per day stacked by agent type.
  WITH daily_agent AS (
    SELECT
      to_char(date_trunc('day', csr.created_at), 'YYYY-MM-DD') AS day,
      COALESCE(NULLIF(trim(csr.agent), ''), 'AEAR Core') AS agent,
      COUNT(*)::integer AS queries
    FROM public.chat_sql_runs csr
    WHERE csr.tenant_id = v_tenant_id
      AND csr.created_at >= v_from_ts
      AND csr.created_at < v_to_ts
    GROUP BY 1, 2
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'date', da.day,
        'agent', da.agent,
        'queries', da.queries
      )
      ORDER BY da.day, da.agent
    ),
    '[]'::jsonb
  )
  INTO v_queries_per_day
  FROM daily_agent da;

  WITH agents AS (
    SELECT DISTINCT COALESCE(NULLIF(trim(csr.agent), ''), 'AEAR Core') AS agent
    FROM public.chat_sql_runs csr
    WHERE csr.tenant_id = v_tenant_id
      AND csr.created_at >= v_from_ts
      AND csr.created_at < v_to_ts
  )
  SELECT COALESCE(jsonb_agg(a.agent ORDER BY a.agent), '[]'::jsonb)
  INTO v_agent_keys
  FROM agents a;

  -- Response time distribution per day (P50/P95/P99).
  WITH latency AS (
    SELECT
      date_trunc('day', csr.created_at)::date AS day,
      csr.execution_ms::numeric AS latency_ms
    FROM public.chat_sql_runs csr
    WHERE csr.tenant_id = v_tenant_id
      AND csr.created_at >= v_from_ts
      AND csr.created_at < v_to_ts

    UNION ALL

    SELECT
      date_trunc('day', atr.created_at)::date AS day,
      atr.latency_ms::numeric AS latency_ms
    FROM public.agent_tool_runs atr
    WHERE atr.tenant_id = v_tenant_id
      AND atr.created_at >= v_from_ts
      AND atr.created_at < v_to_ts
      AND atr.latency_ms IS NOT NULL
      AND atr.latency_ms > 0
  ),
  day_percentiles AS (
    SELECT
      l.day,
      percentile_cont(0.50) WITHIN GROUP (ORDER BY l.latency_ms) AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms) AS p95,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY l.latency_ms) AS p99
    FROM latency l
    GROUP BY l.day
    ORDER BY l.day
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'date', to_char(dp.day, 'YYYY-MM-DD'),
        'p50', ROUND(dp.p50, 2),
        'p95', ROUND(dp.p95, 2),
        'p99', ROUND(dp.p99, 2)
      )
      ORDER BY dp.day
    ),
    '[]'::jsonb
  )
  INTO v_response_distribution
  FROM day_percentiles dp;

  -- Most active users (top 10, anonymized).
  WITH user_counts AS (
    SELECT
      s.user_id,
      COUNT(*)::integer AS queries
    FROM public.chat_messages m
    JOIN public.chat_sessions s
      ON s.id = m.session_id
    WHERE s.tenant_id = v_tenant_id
      AND lower(COALESCE(m.role, '')) = 'user'
      AND m.created_at >= v_from_ts
      AND m.created_at < v_to_ts
    GROUP BY s.user_id
    ORDER BY queries DESC
    LIMIT 10
  ),
  ranked AS (
    SELECT
      uc.user_id,
      uc.queries,
      row_number() OVER (ORDER BY uc.queries DESC, uc.user_id) AS rank_idx
    FROM user_counts uc
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'user', format('User %s', r.rank_idx),
        'queries', r.queries
      )
      ORDER BY r.queries DESC, r.rank_idx
    ),
    '[]'::jsonb
  )
  INTO v_most_active_users
  FROM ranked r;

  -- Most queried resources (treemap).
  WITH resources AS (
    SELECT NULLIF(trim(aar.resource), '') AS resource
    FROM public.agent_action_runs aar
    WHERE aar.tenant_id = v_tenant_id
      AND aar.created_at >= v_from_ts
      AND aar.created_at < v_to_ts

    UNION ALL

    SELECT
      NULLIF(
        replace(
          COALESCE((regexp_match(lower(csr.sql_query), E'\\bfrom\\s+([a-zA-Z0-9_\\.\"]+)'))[1], ''),
          '"',
          ''
        ),
        ''
      ) AS resource
    FROM public.chat_sql_runs csr
    WHERE csr.tenant_id = v_tenant_id
      AND csr.created_at >= v_from_ts
      AND csr.created_at < v_to_ts
  ),
  grouped AS (
    SELECT lower(resource) AS resource, COUNT(*)::integer AS cnt
    FROM resources
    WHERE resource IS NOT NULL
    GROUP BY lower(resource)
    ORDER BY cnt DESC
    LIMIT 15
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'name', g.resource,
        'value', g.cnt
      )
      ORDER BY g.cnt DESC, g.resource
    ),
    '[]'::jsonb
  )
  INTO v_queried_resources
  FROM grouped g;

  -- Action execution breakdown.
  WITH status_counts AS (
    SELECT
      CASE
        WHEN lower(COALESCE(aar.status, '')) IN ('executed', 'success', 'completed', 'approved') THEN 'success'
        WHEN lower(COALESCE(aar.status, '')) IN ('failed', 'error', 'rejected', 'denied') THEN 'failed'
        WHEN lower(COALESCE(aar.status, '')) IN ('blocked', 'cancelled', 'canceled') THEN 'blocked'
        ELSE 'pending'
      END AS status,
      COUNT(*)::integer AS cnt
    FROM public.agent_action_runs aar
    WHERE aar.tenant_id = v_tenant_id
      AND aar.created_at >= v_from_ts
      AND aar.created_at < v_to_ts
    GROUP BY 1
  ),
  labels AS (
    SELECT unnest(ARRAY['success', 'failed', 'blocked', 'pending']) AS status
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'status', l.status,
        'count', COALESCE(sc.cnt, 0)
      )
      ORDER BY l.status
    ),
    '[]'::jsonb
  )
  INTO v_action_breakdown
  FROM labels l
  LEFT JOIN status_counts sc
    ON sc.status = l.status;

  -- Agent performance table.
  WITH base AS (
    SELECT
      COALESCE(NULLIF(trim(csr.agent), ''), 'AEAR Core') AS agent,
      csr.prompt,
      csr.success,
      csr.execution_ms,
      csr.created_at
    FROM public.chat_sql_runs csr
    WHERE csr.tenant_id = v_tenant_id
      AND csr.created_at >= v_from_ts
      AND csr.created_at < v_to_ts
  ),
  agg AS (
    SELECT
      b.agent,
      COUNT(*)::integer AS queries,
      ROUND(AVG(CASE WHEN b.success THEN 1 ELSE 0 END) * 100, 2) AS success_rate,
      ROUND(AVG(b.execution_ms)::numeric, 2) AS avg_time_ms
    FROM base b
    GROUP BY b.agent
  ),
  topq AS (
    SELECT
      b.agent,
      b.prompt,
      row_number() OVER (
        PARTITION BY b.agent
        ORDER BY COUNT(*) DESC, MAX(b.created_at) DESC
      ) AS rn
    FROM base b
    GROUP BY b.agent, b.prompt
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'agent', a.agent,
        'queries', a.queries,
        'successRate', a.success_rate,
        'avgTimeMs', a.avg_time_ms,
        'topQuery', COALESCE(t.prompt, 'N/A')
      )
      ORDER BY a.queries DESC, a.agent
    ),
    '[]'::jsonb
  )
  INTO v_agent_performance
  FROM agg a
  LEFT JOIN topq t
    ON t.agent = a.agent
   AND t.rn = 1;

  -- Token usage and cost estimate.
  SELECT
    COALESCE(SUM(ar.input_tokens), 0)::bigint,
    COALESCE(SUM(ar.output_tokens), 0)::bigint
  INTO v_input_tokens, v_output_tokens
  FROM public.agent_runs ar
  WHERE ar.tenant_id = v_tenant_id
    AND ar.created_at >= v_from_ts
    AND ar.created_at < v_to_ts;

  v_total_tokens := COALESCE(v_input_tokens, 0) + COALESCE(v_output_tokens, 0);

  SELECT
    COALESCE(SUM(ar.input_tokens + ar.output_tokens), 0)::bigint
  INTO v_prev_total_tokens
  FROM public.agent_runs ar
  WHERE ar.tenant_id = v_tenant_id
    AND ar.created_at >= v_prev_from_ts
    AND ar.created_at < v_prev_to_ts;

  SELECT lower(COALESCE(t.plan, 'starter'))
  INTO v_plan
  FROM public.tenants t
  WHERE t.id = v_tenant_id;

  IF v_plan = 'enterprise' THEN
    v_discount := 0.80;
  ELSIF v_plan = 'pro' THEN
    v_discount := 0.90;
  ELSE
    v_discount := 1.00;
  END IF;

  v_estimated_cost := (
    ((COALESCE(v_input_tokens, 0)::numeric / 1000000.0) * 0.15) +
    ((COALESCE(v_output_tokens, 0)::numeric / 1000000.0) * 0.60)
  ) * v_discount;

  IF v_prev_total_tokens > 0 THEN
    v_token_trend_pct := ROUND(((v_total_tokens::numeric - v_prev_total_tokens::numeric) / v_prev_total_tokens::numeric) * 100, 2);
  ELSIF v_total_tokens > 0 THEN
    v_token_trend_pct := 100;
  ELSE
    v_token_trend_pct := 0;
  END IF;

  RETURN jsonb_build_object(
    'profileRole', v_role,
    'isAdmin', true,
    'range', jsonb_build_object(
      'from', v_from_date,
      'to', v_to_date,
      'previousFrom', v_prev_from,
      'previousTo', v_prev_to,
      'days', v_days
    ),
    'topMetrics', jsonb_build_object(
      'totalAiQueries', v_total_ai_queries,
      'actionsExecuted', v_actions_executed,
      'avgResponseTimeMs', v_avg_response_time,
      'approvalRatePct', v_approval_rate,
      'dataSourcesQueried', v_data_sources_queried
    ),
    'usageCharts', jsonb_build_object(
      'queriesPerDay', v_queries_per_day,
      'agentKeys', v_agent_keys,
      'responseTimeDistribution', v_response_distribution,
      'mostActiveUsers', v_most_active_users,
      'mostQueriedResources', v_queried_resources,
      'actionExecutionBreakdown', v_action_breakdown
    ),
    'agentPerformance', v_agent_performance,
    'tokenUsage', jsonb_build_object(
      'totalTokens', v_total_tokens,
      'inputTokens', v_input_tokens,
      'outputTokens', v_output_tokens,
      'estimatedCostUsd', ROUND(v_estimated_cost, 4),
      'trendPctVsPrevious', v_token_trend_pct,
      'previousTotalTokens', v_prev_total_tokens
    ),
    'settings', jsonb_build_object(
      'weeklyEmailReportEnabled', v_weekly_email_enabled
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_tenant_admin_weekly_report_enabled(p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role text := 'member';
  v_enabled boolean := COALESCE(p_enabled, false);
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

  IF v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only owner/admin can update weekly report settings';
  END IF;

  INSERT INTO public.tenant_admin_report_settings (tenant_id, weekly_email_report_enabled)
  VALUES (v_tenant_id, v_enabled)
  ON CONFLICT (tenant_id)
  DO UPDATE SET
    weekly_email_report_enabled = EXCLUDED.weekly_email_report_enabled,
    updated_at = now();

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'admin.analytics.weekly_report_toggle',
    'tenant_admin_report_settings',
    'success',
    jsonb_build_object('weeklyEmailReportEnabled', v_enabled)
  );

  RETURN jsonb_build_object(
    'weeklyEmailReportEnabled', v_enabled
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_admin_analytics_payload(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_tenant_admin_weekly_report_enabled(boolean) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'tenant_admin_report_settings'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.tenant_admin_report_settings';
  END IF;
END;
$$;
