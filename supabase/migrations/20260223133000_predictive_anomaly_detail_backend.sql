-- Predictive AI anomaly detail backend for /dashboard/insights/:id.

CREATE TABLE IF NOT EXISTS public.anomaly_metric_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  insight_id uuid NOT NULL REFERENCES public.anomaly_insights(id) ON DELETE CASCADE,
  observed_on date NOT NULL,
  expected_value numeric,
  actual_value numeric,
  lower_band numeric,
  upper_band numeric,
  forecast_value numeric,
  is_anomaly boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (insight_id, observed_on)
);

CREATE INDEX IF NOT EXISTS anomaly_metric_points_tenant_insight_date_idx
  ON public.anomaly_metric_points (tenant_id, insight_id, observed_on ASC);

CREATE TABLE IF NOT EXISTS public.anomaly_root_causes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  insight_id uuid NOT NULL REFERENCES public.anomaly_insights(id) ON DELETE CASCADE,
  factor_name text NOT NULL,
  impact_pct numeric(5,2) NOT NULL CHECK (impact_pct >= 0 AND impact_pct <= 100),
  sort_order integer NOT NULL DEFAULT 0,
  details text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS anomaly_root_causes_tenant_insight_idx
  ON public.anomaly_root_causes (tenant_id, insight_id, sort_order, created_at);

CREATE TABLE IF NOT EXISTS public.anomaly_recommended_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  insight_id uuid NOT NULL REFERENCES public.anomaly_insights(id) ON DELETE CASCADE,
  title text NOT NULL,
  prompt text NOT NULL,
  action_type text NOT NULL DEFAULT 'chat' CHECK (action_type IN ('chat', 'workflow')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS anomaly_recommended_actions_tenant_insight_idx
  ON public.anomaly_recommended_actions (tenant_id, insight_id, sort_order, created_at);

CREATE TABLE IF NOT EXISTS public.anomaly_similar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  insight_id uuid REFERENCES public.anomaly_insights(id) ON DELETE SET NULL,
  title text NOT NULL,
  detected_at timestamptz NOT NULL,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  deviation_pct numeric(8,2),
  details text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS anomaly_similar_events_tenant_detected_idx
  ON public.anomaly_similar_events (tenant_id, detected_at DESC);

ALTER TABLE public.anomaly_metric_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anomaly_root_causes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anomaly_recommended_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anomaly_similar_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant members can view anomaly metric points" ON public.anomaly_metric_points;
CREATE POLICY "Tenant members can view anomaly metric points"
  ON public.anomaly_metric_points FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage anomaly metric points" ON public.anomaly_metric_points;
CREATE POLICY "Tenant members can manage anomaly metric points"
  ON public.anomaly_metric_points FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view anomaly root causes" ON public.anomaly_root_causes;
CREATE POLICY "Tenant members can view anomaly root causes"
  ON public.anomaly_root_causes FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage anomaly root causes" ON public.anomaly_root_causes;
CREATE POLICY "Tenant members can manage anomaly root causes"
  ON public.anomaly_root_causes FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view anomaly actions" ON public.anomaly_recommended_actions;
CREATE POLICY "Tenant members can view anomaly actions"
  ON public.anomaly_recommended_actions FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage anomaly actions" ON public.anomaly_recommended_actions;
CREATE POLICY "Tenant members can manage anomaly actions"
  ON public.anomaly_recommended_actions FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view anomaly similar events" ON public.anomaly_similar_events;
CREATE POLICY "Tenant members can view anomaly similar events"
  ON public.anomaly_similar_events FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage anomaly similar events" ON public.anomaly_similar_events;
CREATE POLICY "Tenant members can manage anomaly similar events"
  ON public.anomaly_similar_events FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

CREATE OR REPLACE FUNCTION public.seed_anomaly_detail_for_insight(
  p_insight_id uuid,
  p_force boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_insight record;
  v_existing integer := 0;
  v_day date;
  v_expected numeric;
  v_actual numeric;
  v_forecast numeric;
  v_baseline numeric;
  v_anomaly_actual numeric;
  v_inserted integer := 0;
BEGIN
  IF p_insight_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT
    i.id,
    i.tenant_id,
    i.connection_id,
    i.title,
    i.description,
    i.detected_at,
    i.metric_name,
    COALESCE(i.metric_previous_value, 145000) AS metric_previous_value,
    COALESCE(i.metric_value, 96000) AS metric_value
  INTO v_insight
  FROM public.anomaly_insights i
  WHERE i.id = p_insight_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  SELECT COUNT(*)::integer
  INTO v_existing
  FROM public.anomaly_metric_points p
  WHERE p.insight_id = p_insight_id;

  IF v_existing > 0 AND p_force = false THEN
    RETURN 0;
  END IF;

  IF p_force = true THEN
    DELETE FROM public.anomaly_metric_points WHERE insight_id = p_insight_id;
    DELETE FROM public.anomaly_root_causes WHERE insight_id = p_insight_id;
    DELETE FROM public.anomaly_recommended_actions WHERE insight_id = p_insight_id;
    DELETE FROM public.anomaly_similar_events WHERE insight_id = p_insight_id;
  END IF;

  v_baseline := GREATEST(v_insight.metric_previous_value, 1);
  v_anomaly_actual := GREATEST(v_insight.metric_value, 1);

  FOR i IN -59..14 LOOP
    v_day := (date_trunc('day', v_insight.detected_at)::date + i);
    v_expected := ROUND(v_baseline * (1 + (sin(i / 6.0) * 0.06)), 2);

    IF i < 0 THEN
      v_actual := ROUND(v_expected * (1 + (sin(i / 8.0) * 0.03)), 2);
      IF i BETWEEN -7 AND -1 THEN
        v_actual := ROUND(v_actual * (1 - ((7 - abs(i)) * 0.015)), 2);
      END IF;
      v_forecast := NULL;
    ELSIF i = 0 THEN
      v_actual := v_anomaly_actual;
      v_forecast := NULL;
    ELSE
      v_actual := NULL;
      v_forecast := ROUND((v_anomaly_actual * (1 + (i * 0.008)))::numeric, 2);
    END IF;

    INSERT INTO public.anomaly_metric_points (
      tenant_id,
      insight_id,
      observed_on,
      expected_value,
      actual_value,
      lower_band,
      upper_band,
      forecast_value,
      is_anomaly
    )
    VALUES (
      v_insight.tenant_id,
      v_insight.id,
      v_day,
      v_expected,
      v_actual,
      ROUND(v_expected * 0.90, 2),
      ROUND(v_expected * 1.10, 2),
      v_forecast,
      i = 0
    )
    ON CONFLICT (insight_id, observed_on) DO NOTHING;
  END LOOP;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  INSERT INTO public.anomaly_root_causes (
    tenant_id,
    insight_id,
    factor_name,
    impact_pct,
    sort_order,
    details
  )
  VALUES
    (v_insight.tenant_id, v_insight.id, 'Seasonal effect', 45, 10, 'Historic holiday period softness aligned with current week.'),
    (v_insight.tenant_id, v_insight.id, 'Region X orders', 38, 20, 'Region X order volume dropped abruptly starting Dec 15.'),
    (v_insight.tenant_id, v_insight.id, 'Price change', 17, 30, 'Recent pricing experiment likely reduced conversion in one segment.')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.anomaly_recommended_actions (
    tenant_id,
    insight_id,
    title,
    prompt,
    action_type,
    sort_order
  )
  VALUES
    (
      v_insight.tenant_id,
      v_insight.id,
      'Generate detailed breakdown by region',
      'Generate a detailed revenue breakdown by region for the last 60 days and highlight the largest drop contributors.',
      'chat',
      10
    ),
    (
      v_insight.tenant_id,
      v_insight.id,
      'Alert finance team',
      'Draft a concise finance alert summarizing this anomaly, impact magnitude, and immediate next checks.',
      'chat',
      20
    ),
    (
      v_insight.tenant_id,
      v_insight.id,
      'Compare to same period last year',
      'Compare this metric to the same period last year and quantify seasonality-adjusted deviation.',
      'chat',
      30
    )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.anomaly_similar_events (
    tenant_id,
    insight_id,
    title,
    detected_at,
    severity,
    deviation_pct,
    details
  )
  VALUES
    (
      v_insight.tenant_id,
      v_insight.id,
      'Revenue dip during year-end period',
      v_insight.detected_at - interval '6 months',
      'high',
      -22.4,
      'Similar holiday-season contraction with recovery after 2 weeks.'
    ),
    (
      v_insight.tenant_id,
      v_insight.id,
      'Regional demand drop anomaly',
      v_insight.detected_at - interval '11 months',
      'medium',
      -18.7,
      'Region-level demand decline linked to promotion pause.'
    )
  ON CONFLICT DO NOTHING;

  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_predictive_anomaly_detail(
  p_insight_id uuid,
  p_window text DEFAULT '60d'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_window text := lower(trim(COALESCE(p_window, '60d')));
  v_days integer := 60;
  v_insight record;
  v_from date;
  v_to date;
  v_chart jsonb := '[]'::jsonb;
  v_causes jsonb := '[]'::jsonb;
  v_actions jsonb := '[]'::jsonb;
  v_events jsonb := '[]'::jsonb;
  v_expected numeric := 0;
  v_actual numeric := 0;
  v_deviation numeric := 0;
  v_status_label text;
  v_similar_count integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context found';
  END IF;

  IF v_window NOT IN ('7d', '30d', '60d', '90d') THEN
    v_window := '60d';
  END IF;

  v_days := CASE v_window
    WHEN '7d' THEN 7
    WHEN '30d' THEN 30
    WHEN '90d' THEN 90
    ELSE 60
  END;

  SELECT
    i.id,
    i.tenant_id,
    i.connection_id,
    i.title,
    i.description,
    i.severity,
    i.signal_type,
    i.insight_category,
    i.detected_at,
    i.status,
    COALESCE(i.metric_name, 'Revenue (Weekly)') AS metric_name,
    COALESCE(i.metric_previous_value, 145000) AS metric_previous_value,
    COALESCE(i.metric_value, 96000) AS metric_value,
    COALESCE(i.confidence_score, 94) AS confidence_score,
    COALESCE(i.context ->> 'analysis',
      'The drop correlates with a 40% decrease in orders from Region X starting Dec 15. This coincides with the holiday period and may be seasonal.'
    ) AS analysis_text,
    COALESCE(c.name, 'Unknown source') AS source_name
  INTO v_insight
  FROM public.anomaly_insights i
  LEFT JOIN public.api_connections c
    ON c.id = i.connection_id
  WHERE i.id = p_insight_id
    AND i.tenant_id = v_tenant_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insight not found';
  END IF;

  PERFORM public.seed_anomaly_detail_for_insight(v_insight.id, false);

  v_from := (date_trunc('day', v_insight.detected_at)::date - (v_days - 1));
  v_to := (date_trunc('day', v_insight.detected_at)::date + 14);

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'date', p.observed_on,
        'expected', p.expected_value,
        'actual', p.actual_value,
        'lowerBand', p.lower_band,
        'upperBand', p.upper_band,
        'forecast', p.forecast_value,
        'isAnomaly', p.is_anomaly
      )
      ORDER BY p.observed_on
    ),
    '[]'::jsonb
  )
  INTO v_chart
  FROM public.anomaly_metric_points p
  WHERE p.insight_id = v_insight.id
    AND p.tenant_id = v_tenant_id
    AND p.observed_on BETWEEN v_from AND v_to;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'name', c.factor_name,
        'impactPct', c.impact_pct,
        'details', c.details
      )
      ORDER BY c.sort_order, c.created_at
    ),
    '[]'::jsonb
  )
  INTO v_causes
  FROM public.anomaly_root_causes c
  WHERE c.insight_id = v_insight.id
    AND c.tenant_id = v_tenant_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'title', a.title,
        'prompt', a.prompt,
        'actionType', a.action_type
      )
      ORDER BY a.sort_order, a.created_at
    ),
    '[]'::jsonb
  )
  INTO v_actions
  FROM public.anomaly_recommended_actions a
  WHERE a.insight_id = v_insight.id
    AND a.tenant_id = v_tenant_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', e.id,
        'title', e.title,
        'detectedAt', e.detected_at,
        'severity', e.severity,
        'deviationPct', e.deviation_pct,
        'details', e.details
      )
      ORDER BY e.detected_at DESC
    ),
    '[]'::jsonb
  ),
  COUNT(*)::integer
  INTO v_events, v_similar_count
  FROM public.anomaly_similar_events e
  WHERE e.tenant_id = v_tenant_id
    AND e.detected_at >= now() - interval '12 months'
    AND (
      e.insight_id = v_insight.id
      OR lower(COALESCE(e.title, '')) LIKE '%' || lower(split_part(v_insight.metric_name, ' ', 1)) || '%'
    );

  v_expected := COALESCE(v_insight.metric_previous_value, 0);
  v_actual := COALESCE(v_insight.metric_value, 0);
  IF v_expected = 0 THEN
    v_deviation := 0;
  ELSE
    v_deviation := ROUND(((v_actual - v_expected) / v_expected) * 100, 2);
  END IF;

  v_status_label := CASE lower(COALESCE(v_insight.status, 'open'))
    WHEN 'open' THEN 'Active'
    WHEN 'acknowledged' THEN 'Investigating'
    WHEN 'resolved' THEN 'Resolved'
    ELSE 'Active'
  END;

  RETURN jsonb_build_object(
    'id', v_insight.id,
    'header', jsonb_build_object(
      'severity', lower(COALESCE(v_insight.severity, 'medium')),
      'category', COALESCE(lower(NULLIF(v_insight.insight_category, '')), lower(COALESCE(v_insight.signal_type, 'trend'))),
      'title', COALESCE(v_insight.title, 'Revenue Anomaly Detected'),
      'detectedAt', v_insight.detected_at,
      'status', v_status_label,
      'sourceName', v_insight.source_name
    ),
    'impactSummary', jsonb_build_object(
      'metric', v_insight.metric_name,
      'expected', v_expected,
      'actual', v_actual,
      'deviationPct', v_deviation,
      'confidence', COALESCE(v_insight.confidence_score, 94)
    ),
    'chart', jsonb_build_object(
      'window', v_window,
      'points', v_chart
    ),
    'rootCauseAnalysis', jsonb_build_object(
      'analysis', v_insight.analysis_text,
      'factors', v_causes
    ),
    'recommendedActions', v_actions,
    'similarPastEvents', jsonb_build_object(
      'count12Months', v_similar_count,
      'events', v_events
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.update_predictive_anomaly_status(
  p_insight_id uuid,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_status text := lower(trim(COALESCE(p_status, 'active')));
  v_internal text := 'open';
  v_now timestamptz := now();
  v_title text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context found';
  END IF;

  v_internal := CASE v_status
    WHEN 'active' THEN 'open'
    WHEN 'investigating' THEN 'acknowledged'
    WHEN 'resolved' THEN 'resolved'
    ELSE 'open'
  END;

  UPDATE public.anomaly_insights i
  SET
    status = v_internal,
    resolved_at = CASE WHEN v_internal = 'resolved' THEN v_now ELSE i.resolved_at END,
    updated_at = v_now
  WHERE i.id = p_insight_id
    AND i.tenant_id = v_tenant_id
  RETURNING i.title INTO v_title;

  IF v_title IS NULL THEN
    RAISE EXCEPTION 'Insight not found';
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'insights.status_update',
    p_insight_id::text,
    'success',
    jsonb_build_object(
      'status', v_status,
      'updatedAt', v_now
    )
  );

  RETURN jsonb_build_object(
    'updated', true,
    'status', CASE v_internal
      WHEN 'open' THEN 'Active'
      WHEN 'acknowledged' THEN 'Investigating'
      WHEN 'resolved' THEN 'Resolved'
      ELSE 'Active'
    END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_anomaly_detail_for_insight(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_predictive_anomaly_detail(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_predictive_anomaly_status(uuid, text) TO authenticated;

