-- Predictive AI insights feed backend for /dashboard/insights.

ALTER TABLE public.anomaly_insights
  ADD COLUMN IF NOT EXISTS insight_category text,
  ADD COLUMN IF NOT EXISTS confidence_score numeric(5,2),
  ADD COLUMN IF NOT EXISTS metric_name text,
  ADD COLUMN IF NOT EXISTS metric_value numeric,
  ADD COLUMN IF NOT EXISTS metric_previous_value numeric,
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dismissed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

DO $$
BEGIN
  ALTER TABLE public.anomaly_insights
    DROP CONSTRAINT IF EXISTS anomaly_insights_category_check;

  ALTER TABLE public.anomaly_insights
    ADD CONSTRAINT anomaly_insights_category_check CHECK (
      insight_category IS NULL
      OR insight_category IN ('anomaly', 'trend', 'forecast', 'opportunity', 'sla_risk', 'positive')
    );
END;
$$;

CREATE INDEX IF NOT EXISTS anomaly_insights_tenant_category_idx
  ON public.anomaly_insights (tenant_id, insight_category, detected_at DESC);

CREATE INDEX IF NOT EXISTS anomaly_insights_tenant_status_severity_idx
  ON public.anomaly_insights (tenant_id, status, severity, detected_at DESC);

CREATE OR REPLACE FUNCTION public.seed_predictive_insights_for_tenant(
  p_tenant_id uuid,
  p_force boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing integer := 0;
  v_connection_ids uuid[] := ARRAY[]::uuid[];
  v_inserted integer := 0;
BEGIN
  IF p_tenant_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COUNT(*)::integer
  INTO v_existing
  FROM public.anomaly_insights i
  WHERE i.tenant_id = p_tenant_id
    AND i.status IN ('open', 'acknowledged')
    AND i.detected_at >= now() - interval '45 days';

  IF v_existing > 0 AND p_force = false THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(array_agg(c.id ORDER BY c.created_at ASC), ARRAY[]::uuid[])
  INTO v_connection_ids
  FROM public.api_connections c
  WHERE c.tenant_id = p_tenant_id
    AND c.is_archived = false;

  INSERT INTO public.anomaly_insights (
    tenant_id,
    connection_id,
    title,
    description,
    severity,
    status,
    signal_type,
    context,
    detected_at,
    insight_category,
    confidence_score,
    metric_name,
    metric_value,
    metric_previous_value
  )
  VALUES
    (
      p_tenant_id,
      v_connection_ids[1],
      'Revenue dropped 34% vs 30-day average',
      'Revenue is materially below baseline and requires immediate review to avoid monthly target miss.',
      'critical',
      'open',
      'anomaly',
      jsonb_build_object(
        'sparkline', to_jsonb(ARRAY[132, 140, 137, 131, 124, 109, 96]::numeric[]),
        'action_prompt', 'Investigate revenue drop drivers and identify top affected customers and products.',
        'data_source', 'Finance'
      ),
      now() - interval '3 minutes',
      'anomaly',
      94.0,
      'Revenue',
      96,
      146
    ),
    (
      p_tenant_id,
      v_connection_ids[2],
      'Inventory for SKU-421 depleting faster than usual',
      'Based on current demand velocity, stock is projected to hit zero in approximately 3 days.',
      'high',
      'open',
      'forecast',
      jsonb_build_object(
        'sparkline', to_jsonb(ARRAY[220, 210, 198, 186, 170, 158, 145]::numeric[]),
        'action_prompt', 'Create a replenishment action plan for SKU-421 and recommend safe reorder quantity.',
        'data_source', 'Inventory'
      ),
      now() - interval '54 minutes',
      'forecast',
      91.0,
      'Stock Level',
      145,
      220
    ),
    (
      p_tenant_id,
      v_connection_ids[3],
      'SLA response time risk rising in support queue',
      'Average first-response latency increased 22% and may breach SLA if trend continues.',
      'high',
      'open',
      'risk',
      jsonb_build_object(
        'sparkline', to_jsonb(ARRAY[41, 43, 44, 48, 50, 52, 56]::numeric[]),
        'action_prompt', 'Show highest-latency support queues and suggest workload balancing actions.',
        'data_source', 'Support'
      ),
      now() - interval '1 hour 30 minutes',
      'sla_risk',
      89.0,
      'Response Time (min)',
      56,
      41
    ),
    (
      p_tenant_id,
      v_connection_ids[1],
      'Payment failure rate trending upward',
      'Retry failures increased over the last 24 hours with concentration in one payment processor region.',
      'medium',
      'open',
      'trend',
      jsonb_build_object(
        'sparkline', to_jsonb(ARRAY[2.1, 2.3, 2.4, 2.8, 3.1, 3.3, 3.6]::numeric[]),
        'action_prompt', 'Analyze payment failures by provider and region, then propose mitigation steps.',
        'data_source', 'Payments'
      ),
      now() - interval '4 hours',
      'trend',
      86.0,
      'Failure Rate (%)',
      3.6,
      2.1
    ),
    (
      p_tenant_id,
      v_connection_ids[2],
      'Margin improvement opportunity detected',
      'Renegotiating top freight routes could improve contribution margin by an estimated 2.4%.',
      'low',
      'open',
      'opportunity',
      jsonb_build_object(
        'sparkline', to_jsonb(ARRAY[18.2, 18.5, 18.9, 19.2, 19.1, 19.5, 20.0]::numeric[]),
        'action_prompt', 'Generate negotiation-ready summary for top freight vendors and projected savings.',
        'data_source', 'Operations'
      ),
      now() - interval '7 hours',
      'opportunity',
      82.0,
      'Contribution Margin (%)',
      20.0,
      18.2
    ),
    (
      p_tenant_id,
      v_connection_ids[1],
      'Churn risk improved in enterprise cohort',
      'Retention interventions reduced high-risk enterprise accounts by 18% over last week.',
      'low',
      'open',
      'positive',
      jsonb_build_object(
        'sparkline', to_jsonb(ARRAY[44, 42, 39, 35, 33, 30, 28]::numeric[]),
        'action_prompt', 'Summarize which retention actions worked best for enterprise churn reduction.',
        'data_source', 'Customer'
      ),
      now() - interval '11 hours',
      'positive',
      88.0,
      'High-Risk Accounts',
      28,
      44
    )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_predictive_insights()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_now timestamptz := now();
  v_seeded integer := 0;
  v_updated integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context found';
  END IF;

  v_seeded := public.seed_predictive_insights_for_tenant(v_tenant_id, false);

  UPDATE public.anomaly_insights i
  SET updated_at = v_now
  WHERE i.tenant_id = v_tenant_id
    AND i.status IN ('open', 'acknowledged')
    AND i.id IN (
      SELECT i2.id
      FROM public.anomaly_insights i2
      WHERE i2.tenant_id = v_tenant_id
        AND i2.status IN ('open', 'acknowledged')
      ORDER BY i2.detected_at DESC, i2.id DESC
      LIMIT 15
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'insights.refresh',
    'predictive_feed',
    'success',
    jsonb_build_object(
      'seeded', v_seeded,
      'touched', v_updated,
      'refreshedAt', v_now
    )
  );

  RETURN jsonb_build_object(
    'refreshedAt', v_now,
    'seeded', v_seeded,
    'touched', v_updated
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.dismiss_predictive_insight(
  p_insight_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_now timestamptz := now();
  v_title text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context found';
  END IF;

  UPDATE public.anomaly_insights i
  SET
    status = 'dismissed',
    dismissed_at = v_now,
    dismissed_by = auth.uid(),
    updated_at = v_now
  WHERE i.id = p_insight_id
    AND i.tenant_id = v_tenant_id
    AND i.status <> 'dismissed'
  RETURNING i.title INTO v_title;

  IF v_title IS NULL THEN
    RAISE EXCEPTION 'Insight not found or already dismissed';
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'insights.dismiss',
    p_insight_id::text,
    'success',
    jsonb_build_object('title', v_title, 'dismissedAt', v_now)
  );

  RETURN jsonb_build_object(
    'dismissed', true,
    'insightId', p_insight_id,
    'dismissedAt', v_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_predictive_insights_payload(
  p_tab text DEFAULT 'all',
  p_source_id uuid DEFAULT NULL,
  p_include_dismissed boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_tab text := lower(trim(COALESCE(p_tab, 'all')));
  v_sources jsonb := '[]'::jsonb;
  v_alerts jsonb := '[]'::jsonb;
  v_active_insights jsonb := '[]'::jsonb;
  v_dismissed_insights jsonb := '[]'::jsonb;
  v_active_count integer := 0;
  v_total_count integer := 0;
  v_connection_count integer := 0;
  v_last_updated timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context found';
  END IF;

  IF v_tab NOT IN ('all', 'anomalies', 'forecasts', 'sla_risks', 'positive') THEN
    v_tab := 'all';
  END IF;

  PERFORM public.seed_predictive_insights_for_tenant(v_tenant_id, false);

  WITH base AS (
    SELECT
      i.id,
      i.connection_id,
      i.title,
      i.description,
      lower(COALESCE(i.severity, 'medium')) AS severity,
      lower(COALESCE(i.status, 'open')) AS status,
      lower(COALESCE(i.signal_type, 'trend')) AS signal_type,
      COALESCE(
        lower(NULLIF(i.insight_category, '')),
        CASE
          WHEN lower(COALESCE(i.signal_type, '')) IN ('anomaly') THEN 'anomaly'
          WHEN lower(COALESCE(i.signal_type, '')) IN ('forecast', 'prediction') THEN 'forecast'
          WHEN lower(COALESCE(i.signal_type, '')) IN ('risk', 'sla_risk') THEN 'sla_risk'
          WHEN lower(COALESCE(i.signal_type, '')) IN ('positive', 'success') THEN 'positive'
          WHEN lower(COALESCE(i.signal_type, '')) IN ('opportunity') THEN 'opportunity'
          ELSE 'trend'
        END
      ) AS category,
      COALESCE(i.confidence_score, 84)::numeric(5,2) AS confidence_score,
      COALESCE(i.metric_name, NULLIF(i.context ->> 'metric', ''), 'Metric') AS metric_name,
      COALESCE(i.metric_value, NULLIF(i.context ->> 'metric_value', '')::numeric) AS metric_value,
      COALESCE(i.metric_previous_value, NULLIF(i.context ->> 'metric_previous_value', '')::numeric) AS metric_previous_value,
      COALESCE(i.context -> 'sparkline', '[]'::jsonb) AS sparkline,
      COALESCE(NULLIF(i.context ->> 'action_prompt', ''), format('Investigate insight "%s" and recommend next best action.', i.title)) AS action_prompt,
      COALESCE(NULLIF(i.context ->> 'data_source', ''), c.name, 'Unassigned source') AS data_source,
      c.name AS connection_name,
      c.type AS connection_type,
      i.detected_at,
      COALESCE(i.updated_at, i.detected_at) AS updated_at
    FROM public.anomaly_insights i
    LEFT JOIN public.api_connections c
      ON c.id = i.connection_id
    WHERE i.tenant_id = v_tenant_id
      AND (p_source_id IS NULL OR i.connection_id = p_source_id)
      AND (
        v_tab = 'all'
        OR (v_tab = 'anomalies' AND (
          COALESCE(lower(NULLIF(i.insight_category, '')), '') = 'anomaly'
          OR lower(COALESCE(i.signal_type, '')) = 'anomaly'
        ))
        OR (v_tab = 'forecasts' AND (
          COALESCE(lower(NULLIF(i.insight_category, '')), '') = 'forecast'
          OR lower(COALESCE(i.signal_type, '')) IN ('forecast', 'prediction')
        ))
        OR (v_tab = 'sla_risks' AND (
          COALESCE(lower(NULLIF(i.insight_category, '')), '') = 'sla_risk'
          OR lower(COALESCE(i.signal_type, '')) IN ('risk', 'sla_risk')
        ))
        OR (v_tab = 'positive' AND (
          COALESCE(lower(NULLIF(i.insight_category, '')), '') = 'positive'
          OR lower(COALESCE(i.signal_type, '')) IN ('positive', 'success')
        ))
      )
  )
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', b.id,
          'title', b.title,
          'description', b.description,
          'severity', b.severity,
          'category', b.category,
          'metricName', b.metric_name,
          'metricValue', b.metric_value,
          'metricPreviousValue', b.metric_previous_value,
          'confidenceScore', b.confidence_score,
          'dataSource', b.data_source,
          'connectionId', b.connection_id,
          'connectionName', b.connection_name,
          'connectionType', b.connection_type,
          'sparkline', b.sparkline,
          'actionPrompt', b.action_prompt,
          'status', b.status,
          'detectedAt', b.detected_at
        )
        ORDER BY b.detected_at DESC, b.id DESC
      ) FILTER (WHERE b.status <> 'dismissed'),
      '[]'::jsonb
    ),
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', b.id,
          'title', b.title,
          'description', b.description,
          'severity', b.severity,
          'category', b.category,
          'metricName', b.metric_name,
          'metricValue', b.metric_value,
          'metricPreviousValue', b.metric_previous_value,
          'confidenceScore', b.confidence_score,
          'dataSource', b.data_source,
          'connectionId', b.connection_id,
          'connectionName', b.connection_name,
          'connectionType', b.connection_type,
          'sparkline', b.sparkline,
          'actionPrompt', b.action_prompt,
          'status', b.status,
          'detectedAt', b.detected_at
        )
        ORDER BY b.detected_at DESC, b.id DESC
      ) FILTER (WHERE b.status = 'dismissed'),
      '[]'::jsonb
    ),
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', b.id,
          'title', b.title,
          'severity', b.severity,
          'metricName', b.metric_name,
          'metricValue', b.metric_value,
          'detectedAt', b.detected_at,
          'actionPrompt', b.action_prompt,
          'dataSource', b.data_source
        )
        ORDER BY
          CASE b.severity
            WHEN 'critical' THEN 1
            WHEN 'high' THEN 2
            ELSE 3
          END,
          b.detected_at DESC
      ) FILTER (WHERE b.status <> 'dismissed' AND b.severity IN ('critical', 'high')),
      '[]'::jsonb
    ),
    COUNT(*) FILTER (WHERE b.status <> 'dismissed')::integer,
    COUNT(*)::integer,
    COUNT(DISTINCT b.connection_id) FILTER (WHERE b.status <> 'dismissed' AND b.connection_id IS NOT NULL)::integer,
    MAX(b.updated_at)
  INTO
    v_active_insights,
    v_dismissed_insights,
    v_alerts,
    v_active_count,
    v_total_count,
    v_connection_count,
    v_last_updated
  FROM base b;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'type', c.type,
        'status', c.status
      )
      ORDER BY c.name
    ),
    '[]'::jsonb
  )
  INTO v_sources
  FROM public.api_connections c
  WHERE c.tenant_id = v_tenant_id
    AND c.is_archived = false;

  RETURN jsonb_build_object(
    'tab', v_tab,
    'sourceId', p_source_id,
    'lastUpdatedAt', v_last_updated,
    'counts', jsonb_build_object(
      'activeInsights', COALESCE(v_active_count, 0),
      'totalInsights', COALESCE(v_total_count, 0),
      'connectionsCount', COALESCE(v_connection_count, 0)
    ),
    'alerts', v_alerts,
    'insights', v_active_insights,
    'dismissedInsights', CASE WHEN p_include_dismissed THEN v_dismissed_insights ELSE '[]'::jsonb END,
    'sources', v_sources
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_predictive_insights_for_tenant(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_predictive_insights() TO authenticated;
GRANT EXECUTE ON FUNCTION public.dismiss_predictive_insight(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_predictive_insights_payload(text, uuid, boolean) TO authenticated;

