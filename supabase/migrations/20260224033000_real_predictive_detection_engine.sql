-- Real predictive/anomaly engine based on tenant telemetry (no seeded demo values).

ALTER TABLE public.anomaly_insights
  ADD COLUMN IF NOT EXISTS detection_key text;

CREATE UNIQUE INDEX IF NOT EXISTS anomaly_insights_tenant_detection_key_uniq
  ON public.anomaly_insights (tenant_id, detection_key)
  WHERE detection_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.refresh_predictive_insights_for_tenant(
  p_tenant_id uuid DEFAULT NULL,
  p_force boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := COALESCE(p_tenant_id, public.get_user_tenant_id());
  v_now timestamptz := now();
  v_role text := lower(COALESCE(current_setting('request.jwt.claim.role', true), ''));
  v_generated integer := 0;
  v_resolved integer := 0;
  v_active integer := 0;
BEGIN
  IF auth.uid() IS NULL AND v_role <> 'service_role' THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context found';
  END IF;

  WITH days AS (
    SELECT generate_series((current_date - 89)::date, current_date, interval '1 day')::date AS day
  ),
  messages_daily AS (
    SELECT
      d.day,
      COALESCE(COUNT(m.id), 0)::numeric AS value
    FROM days d
    LEFT JOIN public.chat_sessions s
      ON s.tenant_id = v_tenant_id
    LEFT JOIN public.chat_messages m
      ON m.session_id = s.id
     AND m.created_at >= d.day::timestamptz
     AND m.created_at < (d.day + 1)::timestamptz
    GROUP BY d.day
  ),
  sql_daily AS (
    SELECT
      d.day,
      COALESCE(COUNT(r.id), 0)::numeric AS total_runs,
      COALESCE(COUNT(*) FILTER (WHERE r.success IS FALSE), 0)::numeric AS failed_runs,
      COALESCE(
        percentile_disc(0.95) WITHIN GROUP (ORDER BY r.execution_ms)
          FILTER (WHERE r.execution_ms IS NOT NULL),
        0
      )::numeric AS p95_ms
    FROM days d
    LEFT JOIN public.chat_sql_runs r
      ON r.tenant_id = v_tenant_id
     AND r.created_at >= d.day::timestamptz
     AND r.created_at < (d.day + 1)::timestamptz
    GROUP BY d.day
  ),
  sync_daily AS (
    SELECT
      d.day,
      COALESCE(COUNT(sr.id), 0)::numeric AS total_runs,
      COALESCE(COUNT(*) FILTER (WHERE lower(COALESCE(sr.status, '')) = 'error'), 0)::numeric AS failed_runs
    FROM days d
    LEFT JOIN public.connection_sync_runs sr
      ON sr.tenant_id = v_tenant_id
     AND sr.started_at >= d.day::timestamptz
     AND sr.started_at < (d.day + 1)::timestamptz
    GROUP BY d.day
  ),
  approvals_daily AS (
    SELECT
      d.day,
      (
        SELECT COUNT(*)::numeric
        FROM public.approval_requests ar
        WHERE ar.tenant_id = v_tenant_id
          AND ar.created_at < (d.day + 1)::timestamptz
          AND (
            lower(COALESCE(ar.status, 'pending')) = 'pending'
            OR ar.decided_at IS NULL
            OR ar.decided_at >= (d.day + 1)::timestamptz
          )
      ) AS value
    FROM days d
  ),
  metric_series AS (
    SELECT 'messages_daily'::text AS metric_key, day, value FROM messages_daily
    UNION ALL
    SELECT
      'sql_error_rate'::text,
      day,
      CASE WHEN total_runs > 0 THEN ROUND((failed_runs / total_runs) * 100.0, 4) ELSE 0 END
    FROM sql_daily
    UNION ALL
    SELECT 'sql_p95_latency'::text, day, p95_ms FROM sql_daily
    UNION ALL
    SELECT
      'sync_error_rate'::text,
      day,
      CASE WHEN total_runs > 0 THEN ROUND((failed_runs / total_runs) * 100.0, 4) ELSE 0 END
    FROM sync_daily
    UNION ALL
    SELECT 'pending_approvals'::text, day, value FROM approvals_daily
  ),
  metric_stats AS (
    SELECT
      ms.metric_key,
      COUNT(*) FILTER (WHERE ms.day < current_date) AS sample_size,
      MAX(ms.value) FILTER (WHERE ms.day = current_date) AS actual_value,
      COALESCE(
        AVG(ms.value) FILTER (WHERE ms.day >= (current_date - 28) AND ms.day < current_date),
        AVG(ms.value) FILTER (WHERE ms.day < current_date),
        AVG(ms.value)
      ) AS baseline_value,
      COALESCE(
        STDDEV_POP(ms.value) FILTER (WHERE ms.day >= (current_date - 28) AND ms.day < current_date),
        STDDEV_POP(ms.value) FILTER (WHERE ms.day < current_date),
        STDDEV_POP(ms.value),
        0
      ) AS stddev_value,
      COALESCE(
        AVG(ms.value) FILTER (WHERE ms.day BETWEEN (current_date - 6) AND current_date),
        AVG(ms.value) FILTER (WHERE ms.day < current_date),
        0
      ) AS last7_avg,
      COALESCE(
        AVG(ms.value) FILTER (WHERE ms.day BETWEEN (current_date - 13) AND (current_date - 7)),
        AVG(ms.value) FILTER (WHERE ms.day < current_date),
        0
      ) AS prev7_avg,
      COALESCE(
        jsonb_agg(ROUND(ms.value, 4) ORDER BY ms.day) FILTER (WHERE ms.day >= (current_date - 6)),
        '[]'::jsonb
      ) AS sparkline,
      COALESCE(
        jsonb_agg(
          jsonb_build_object('date', ms.day, 'value', ROUND(ms.value, 4))
          ORDER BY ms.day
        ),
        '[]'::jsonb
      ) AS metric_series
    FROM metric_series ms
    GROUP BY ms.metric_key
  ),
  eval AS (
    SELECT
      m.metric_key,
      COALESCE(m.actual_value, 0)::numeric AS actual_value,
      COALESCE(m.baseline_value, 0)::numeric AS baseline_value,
      COALESCE(m.stddev_value, 0)::numeric AS stddev_value,
      GREATEST(COALESCE(m.sample_size, 0), 0)::integer AS sample_size,
      m.last7_avg::numeric,
      m.prev7_avg::numeric,
      m.sparkline,
      m.metric_series,
      CASE
        WHEN COALESCE(ABS(m.baseline_value), 0) > 0.0001
          THEN ROUND(((COALESCE(m.actual_value, 0) - COALESCE(m.baseline_value, 0)) / ABS(m.baseline_value)) * 100.0, 2)
        ELSE NULL
      END AS deviation_pct,
      CASE
        WHEN COALESCE(m.stddev_value, 0) > 0.0001
          THEN ROUND((COALESCE(m.actual_value, 0) - COALESCE(m.baseline_value, 0)) / m.stddev_value, 3)
        ELSE NULL
      END AS z_score,
      CASE
        WHEN COALESCE(ABS(m.prev7_avg), 0) > 0.0001
          THEN ROUND(((COALESCE(m.last7_avg, 0) - COALESCE(m.prev7_avg, 0)) / ABS(m.prev7_avg)) * 100.0, 2)
        ELSE NULL
      END AS trend_pct
    FROM metric_stats m
  ),
  candidates AS (
    SELECT
      'anomaly:messages_drop'::text AS detection_key,
      NULL::uuid AS connection_id,
      'Message volume dropped ' || ROUND(ABS(COALESCE(m.deviation_pct, 0)), 1) || '% vs baseline' AS title,
      'Daily message volume is below recent baseline and may indicate workflow friction or adoption drop.' AS description,
      CASE
        WHEN COALESCE(m.deviation_pct, 0) <= -55 THEN 'critical'
        WHEN COALESCE(m.deviation_pct, 0) <= -40 THEN 'high'
        ELSE 'medium'
      END AS severity,
      'anomaly'::text AS signal_type,
      'anomaly'::text AS insight_category,
      'Messages Today'::text AS metric_name,
      ROUND(m.actual_value, 2) AS metric_value,
      ROUND(m.baseline_value, 2) AS metric_previous_value,
      ROUND(
        LEAST(
          99::numeric,
          GREATEST(
            62::numeric,
            62
              + (ABS(COALESCE(m.deviation_pct, 0)) / 3)
              + (ABS(COALESCE(m.z_score, 0)) * 6)
              + (LEAST(m.sample_size, 30) * 0.30)
          )
        ),
        2
      ) AS confidence_score,
      m.sparkline,
      m.metric_series,
      'Message throughput has decelerated compared to its trailing baseline. Inspect active sessions, failed runs, and approval backlog to isolate bottlenecks.'::text AS analysis,
      jsonb_build_array(
        jsonb_build_object(
          'name', 'Baseline deviation',
          'impactPct', LEAST(85, GREATEST(20, ROUND(ABS(COALESCE(m.deviation_pct, 0))))),
          'details', 'Current day: ' || ROUND(m.actual_value, 2) || ', baseline: ' || ROUND(m.baseline_value, 2)
        ),
        jsonb_build_object(
          'name', 'Weekly momentum shift',
          'impactPct', LEAST(60, GREATEST(10, ROUND(ABS(COALESCE(m.trend_pct, 0))))),
          'details', 'Last 7d avg: ' || ROUND(m.last7_avg, 2) || ', previous 7d avg: ' || ROUND(m.prev7_avg, 2)
        )
      ) AS root_causes,
      jsonb_build_array(
        jsonb_build_object(
          'title', 'Break down low-volume cohorts',
          'prompt', 'Identify teams or workflows with the largest message drop over the last 7 days.',
          'actionType', 'chat'
        ),
        jsonb_build_object(
          'title', 'Check approval bottlenecks',
          'prompt', 'List pending approvals older than 24h and map them to impacted workflows.',
          'actionType', 'chat'
        ),
        jsonb_build_object(
          'title', 'Run connection health review',
          'prompt', 'Summarize connection sync errors in the last 48h and likely impact on chat usage.',
          'actionType', 'chat'
        )
      ) AS recommended_actions
    FROM eval m
    WHERE m.metric_key = 'messages_daily'
      AND m.baseline_value >= 8
      AND COALESCE(m.deviation_pct, 0) <= -35

    UNION ALL

    SELECT
      'anomaly:sql_error_rate'::text,
      (
        SELECT r.connection_id
        FROM public.chat_sql_runs r
        WHERE r.tenant_id = v_tenant_id
          AND r.created_at >= (v_now - interval '7 days')
          AND r.connection_id IS NOT NULL
        GROUP BY r.connection_id
        ORDER BY COUNT(*) FILTER (WHERE r.success IS FALSE) DESC, COUNT(*) DESC
        LIMIT 1
      ) AS connection_id,
      'SQL failure rate spiked to ' || ROUND(m.actual_value, 1) || '%' AS title,
      'Guarded SQL execution failures increased relative to baseline; query quality or schema drift may be impacting reliability.' AS description,
      CASE
        WHEN m.actual_value >= 20 THEN 'critical'
        WHEN m.actual_value >= 10 THEN 'high'
        ELSE 'medium'
      END AS severity,
      'anomaly'::text,
      'anomaly'::text,
      'SQL Failure Rate (%)'::text,
      ROUND(m.actual_value, 2),
      ROUND(m.baseline_value, 2),
      ROUND(
        LEAST(
          99::numeric,
          GREATEST(
            62::numeric,
            62
              + (ABS(COALESCE(m.deviation_pct, 0)) / 2.5)
              + (ABS(COALESCE(m.z_score, 0)) * 7)
              + (LEAST(m.sample_size, 30) * 0.30)
          )
        ),
        2
      ),
      m.sparkline,
      m.metric_series,
      'SQL error ratio is significantly above normal. Validate changed schemas, query plans, and guardrail policy blocks.'::text,
      jsonb_build_array(
        jsonb_build_object(
          'name', 'Failure ratio shift',
          'impactPct', LEAST(90, GREATEST(25, ROUND(ABS(COALESCE(m.deviation_pct, 0))))),
          'details', 'Current: ' || ROUND(m.actual_value, 2) || '%, baseline: ' || ROUND(m.baseline_value, 2) || '%'
        ),
        jsonb_build_object(
          'name', 'Execution volatility',
          'impactPct', LEAST(50, GREATEST(10, ROUND(ABS(COALESCE(m.z_score, 0)) * 10))),
          'details', 'Z-score: ' || COALESCE(ROUND(m.z_score, 2)::text, 'n/a')
        )
      ),
      jsonb_build_array(
        jsonb_build_object(
          'title', 'Inspect failed SQL runs',
          'prompt', 'Show failed SQL runs from the last 24h grouped by error category and connection.',
          'actionType', 'chat'
        ),
        jsonb_build_object(
          'title', 'Check schema drift',
          'prompt', 'Compare latest detected schema changes against failed SQL queries and identify mismatches.',
          'actionType', 'chat'
        ),
        jsonb_build_object(
          'title', 'Generate fix suggestions',
          'prompt', 'Propose corrected SQL for the top 5 failing query templates.',
          'actionType', 'chat'
        )
      )
    FROM eval m
    WHERE m.metric_key = 'sql_error_rate'
      AND m.baseline_value >= 1
      AND m.actual_value >= 3
      AND (
        m.actual_value >= (m.baseline_value * 1.8)
        OR COALESCE(m.deviation_pct, 0) >= 80
      )

    UNION ALL

    SELECT
      'anomaly:sync_error_rate'::text,
      (
        SELECT sr.connection_id
        FROM public.connection_sync_runs sr
        WHERE sr.tenant_id = v_tenant_id
          AND sr.started_at >= (v_now - interval '7 days')
        GROUP BY sr.connection_id
        ORDER BY COUNT(*) FILTER (WHERE lower(COALESCE(sr.status, '')) = 'error') DESC, COUNT(*) DESC
        LIMIT 1
      ) AS connection_id,
      'Data sync error rate elevated to ' || ROUND(m.actual_value, 1) || '%' AS title,
      'Connector sync failures are above normal and may reduce freshness of downstream RAG responses.' AS description,
      CASE
        WHEN m.actual_value >= 25 THEN 'critical'
        WHEN m.actual_value >= 10 THEN 'high'
        ELSE 'medium'
      END AS severity,
      'risk'::text,
      'sla_risk'::text,
      'Sync Error Rate (%)'::text,
      ROUND(m.actual_value, 2),
      ROUND(m.baseline_value, 2),
      ROUND(
        LEAST(
          99::numeric,
          GREATEST(
            62::numeric,
            62
              + (ABS(COALESCE(m.deviation_pct, 0)) / 2.8)
              + (ABS(COALESCE(m.z_score, 0)) * 6)
              + (LEAST(m.sample_size, 30) * 0.25)
          )
        ),
        2
      ),
      m.sparkline,
      m.metric_series,
      'Sync reliability dropped versus baseline. Investigate failing connectors and queue lag to restore freshness.'::text,
      jsonb_build_array(
        jsonb_build_object(
          'name', 'Connector error spike',
          'impactPct', LEAST(90, GREATEST(20, ROUND(ABS(COALESCE(m.deviation_pct, 0))))),
          'details', 'Current: ' || ROUND(m.actual_value, 2) || '%, baseline: ' || ROUND(m.baseline_value, 2) || '%'
        ),
        jsonb_build_object(
          'name', 'Pipeline instability',
          'impactPct', LEAST(50, GREATEST(10, ROUND(ABS(COALESCE(m.z_score, 0)) * 10))),
          'details', 'Z-score: ' || COALESCE(ROUND(m.z_score, 2)::text, 'n/a')
        )
      ),
      jsonb_build_array(
        jsonb_build_object(
          'title', 'Review failing connectors',
          'prompt', 'List connections with repeated sync failures and their latest error messages.',
          'actionType', 'chat'
        ),
        jsonb_build_object(
          'title', 'Prioritize reconnect actions',
          'prompt', 'Recommend the top connector recovery actions ranked by business impact.',
          'actionType', 'chat'
        ),
        jsonb_build_object(
          'title', 'Run targeted sync now',
          'prompt', 'Trigger guarded sync for the most impacted connection and summarize the result.',
          'actionType', 'workflow'
        )
      )
    FROM eval m
    WHERE m.metric_key = 'sync_error_rate'
      AND m.actual_value >= 5
      AND (
        m.actual_value >= (m.baseline_value * 1.8)
        OR COALESCE(m.deviation_pct, 0) >= 80
      )

    UNION ALL

    SELECT
      'anomaly:sql_latency_p95'::text,
      (
        SELECT r.connection_id
        FROM public.chat_sql_runs r
        WHERE r.tenant_id = v_tenant_id
          AND r.created_at >= (v_now - interval '7 days')
          AND r.connection_id IS NOT NULL
        GROUP BY r.connection_id
        ORDER BY percentile_disc(0.95) WITHIN GROUP (ORDER BY r.execution_ms) DESC NULLS LAST, COUNT(*) DESC
        LIMIT 1
      ) AS connection_id,
      'P95 SQL latency increased to ' || ROUND(m.actual_value, 0) || 'ms' AS title,
      'Query latency trend indicates potential degradation in response-time SLA.' AS description,
      CASE
        WHEN m.actual_value >= 2500 THEN 'critical'
        WHEN m.actual_value >= 1200 THEN 'high'
        ELSE 'medium'
      END AS severity,
      'risk'::text,
      'sla_risk'::text,
      'SQL P95 Latency (ms)'::text,
      ROUND(m.actual_value, 2),
      ROUND(m.baseline_value, 2),
      ROUND(
        LEAST(
          99::numeric,
          GREATEST(
            62::numeric,
            62
              + (ABS(COALESCE(m.deviation_pct, 0)) / 3.2)
              + (ABS(COALESCE(m.z_score, 0)) * 6)
              + (LEAST(m.sample_size, 30) * 0.25)
          )
        ),
        2
      ),
      m.sparkline,
      m.metric_series,
      'Latency distribution shifted upward relative to baseline; inspect hot queries and connector bottlenecks.'::text,
      jsonb_build_array(
        jsonb_build_object(
          'name', 'Latency shift',
          'impactPct', LEAST(85, GREATEST(20, ROUND(ABS(COALESCE(m.deviation_pct, 0))))),
          'details', 'Current p95: ' || ROUND(m.actual_value, 0) || 'ms, baseline: ' || ROUND(m.baseline_value, 0) || 'ms'
        ),
        jsonb_build_object(
          'name', 'Execution spread',
          'impactPct', LEAST(50, GREATEST(10, ROUND(ABS(COALESCE(m.z_score, 0)) * 10))),
          'details', 'Z-score: ' || COALESCE(ROUND(m.z_score, 2)::text, 'n/a')
        )
      ),
      jsonb_build_array(
        jsonb_build_object(
          'title', 'Find slowest SQL paths',
          'prompt', 'Show top p95 SQL queries and their average row counts over the last 24h.',
          'actionType', 'chat'
        ),
        jsonb_build_object(
          'title', 'Correlate with sync issues',
          'prompt', 'Compare high SQL latency windows with connector sync errors and queue lag.',
          'actionType', 'chat'
        ),
        jsonb_build_object(
          'title', 'Generate performance action plan',
          'prompt', 'Draft a prioritized latency remediation plan with expected impact.',
          'actionType', 'chat'
        )
      )
    FROM eval m
    WHERE m.metric_key = 'sql_p95_latency'
      AND m.baseline_value >= 120
      AND m.actual_value >= 400
      AND (
        m.actual_value >= (m.baseline_value * 1.5)
        OR COALESCE(m.deviation_pct, 0) >= 50
      )

    UNION ALL

    SELECT
      'anomaly:pending_approvals'::text,
      NULL::uuid,
      'Pending approvals backlog increased to ' || ROUND(m.actual_value, 0) AS title,
      'Approval queue is growing faster than baseline and may delay governed actions.' AS description,
      CASE
        WHEN m.actual_value >= 25 THEN 'high'
        WHEN m.actual_value >= 10 THEN 'medium'
        ELSE 'low'
      END AS severity,
      'risk'::text,
      'sla_risk'::text,
      'Pending Approvals'::text,
      ROUND(m.actual_value, 2),
      ROUND(m.baseline_value, 2),
      ROUND(
        LEAST(
          98::numeric,
          GREATEST(
            60::numeric,
            60
              + (ABS(COALESCE(m.deviation_pct, 0)) / 4.0)
              + (ABS(COALESCE(m.z_score, 0)) * 5)
              + (LEAST(m.sample_size, 30) * 0.20)
          )
        ),
        2
      ),
      m.sparkline,
      m.metric_series,
      'Approval throughput is below demand. Escalation or role balancing may be needed.'::text,
      jsonb_build_array(
        jsonb_build_object(
          'name', 'Queue accumulation',
          'impactPct', LEAST(80, GREATEST(20, ROUND(ABS(COALESCE(m.deviation_pct, 0))))),
          'details', 'Current pending: ' || ROUND(m.actual_value, 0) || ', baseline: ' || ROUND(m.baseline_value, 1)
        ),
        jsonb_build_object(
          'name', 'Approval throughput mismatch',
          'impactPct', LEAST(55, GREATEST(10, ROUND(ABS(COALESCE(m.trend_pct, 0))))),
          'details', 'Last 7d avg: ' || ROUND(m.last7_avg, 1) || ', previous 7d avg: ' || ROUND(m.prev7_avg, 1)
        )
      ),
      jsonb_build_array(
        jsonb_build_object(
          'title', 'List oldest pending approvals',
          'prompt', 'Show pending approvals older than 24h grouped by accountable role and risk.',
          'actionType', 'chat'
        ),
        jsonb_build_object(
          'title', 'Recommend escalation targets',
          'prompt', 'Suggest escalation for high-risk pending approvals based on SLA impact.',
          'actionType', 'chat'
        )
      )
    FROM eval m
    WHERE m.metric_key = 'pending_approvals'
      AND m.actual_value >= 5
      AND m.baseline_value >= 1
      AND (
        m.actual_value >= (m.baseline_value * 1.7)
        OR COALESCE(m.deviation_pct, 0) >= 60
      )

    UNION ALL

    SELECT
      'forecast:messages_weekly'::text,
      NULL::uuid,
      'Message throughput trend indicates possible near-term shortfall' AS title,
      'Recent 7-day average is materially below the previous week; proactive intervention can prevent further drop.' AS description,
      CASE
        WHEN COALESCE(m.trend_pct, 0) <= -35 THEN 'high'
        ELSE 'medium'
      END AS severity,
      'forecast'::text,
      'forecast'::text,
      '7d Message Average'::text,
      ROUND(m.last7_avg, 2),
      ROUND(m.prev7_avg, 2),
      ROUND(
        LEAST(
          96::numeric,
          GREATEST(
            58::numeric,
            58
              + (ABS(COALESCE(m.trend_pct, 0)) / 3.5)
              + (LEAST(m.sample_size, 30) * 0.20)
          )
        ),
        2
      ),
      m.sparkline,
      m.metric_series,
      'Seven-day rolling message throughput is trending down compared to the prior week.'::text,
      jsonb_build_array(
        jsonb_build_object(
          'name', 'Weekly trend shift',
          'impactPct', LEAST(80, GREATEST(20, ROUND(ABS(COALESCE(m.trend_pct, 0))))),
          'details', 'Last 7d avg: ' || ROUND(m.last7_avg, 2) || ', previous 7d avg: ' || ROUND(m.prev7_avg, 2)
        )
      ),
      jsonb_build_array(
        jsonb_build_object(
          'title', 'Project weekly completion risk',
          'prompt', 'Forecast next 7 days message volume and estimate risk of missing weekly baseline.',
          'actionType', 'chat'
        ),
        jsonb_build_object(
          'title', 'Prioritize recovery actions',
          'prompt', 'Recommend top interventions to recover message throughput over the next week.',
          'actionType', 'chat'
        )
      )
    FROM eval m
    WHERE m.metric_key = 'messages_daily'
      AND m.prev7_avg >= 8
      AND m.last7_avg < (m.prev7_avg * 0.85)

    UNION ALL

    SELECT
      'positive:sql_error_rate_improved'::text,
      (
        SELECT r.connection_id
        FROM public.chat_sql_runs r
        WHERE r.tenant_id = v_tenant_id
          AND r.created_at >= (v_now - interval '7 days')
          AND r.connection_id IS NOT NULL
        GROUP BY r.connection_id
        ORDER BY COUNT(*) DESC
        LIMIT 1
      ),
      'SQL reliability improved by ' || ROUND(ABS(COALESCE(m.deviation_pct, 0)), 1) || '% vs baseline' AS title,
      'Failure rate is down materially relative to baseline, indicating healthier query execution.' AS description,
      'low'::text,
      'positive'::text,
      'positive'::text,
      'SQL Failure Rate (%)'::text,
      ROUND(m.actual_value, 2),
      ROUND(m.baseline_value, 2),
      ROUND(
        LEAST(
          95::numeric,
          GREATEST(
            55::numeric,
            55
              + (ABS(COALESCE(m.deviation_pct, 0)) / 4.0)
              + (LEAST(m.sample_size, 30) * 0.20)
          )
        ),
        2
      ),
      m.sparkline,
      m.metric_series,
      'SQL error rate is trending down versus baseline; capture what changed to preserve reliability gains.'::text,
      jsonb_build_array(
        jsonb_build_object(
          'name', 'Error-rate reduction',
          'impactPct', LEAST(80, GREATEST(20, ROUND(ABS(COALESCE(m.deviation_pct, 0))))),
          'details', 'Current: ' || ROUND(m.actual_value, 2) || '%, baseline: ' || ROUND(m.baseline_value, 2) || '%'
        )
      ),
      jsonb_build_array(
        jsonb_build_object(
          'title', 'Document successful query patterns',
          'prompt', 'Summarize the highest-success SQL templates and guardrails from the last 7 days.',
          'actionType', 'chat'
        ),
        jsonb_build_object(
          'title', 'Scale proven patterns',
          'prompt', 'Recommend where these reliability improvements should be applied next.',
          'actionType', 'chat'
        )
      )
    FROM eval m
    WHERE m.metric_key = 'sql_error_rate'
      AND m.baseline_value >= 3
      AND m.actual_value <= (m.baseline_value * 0.65)
      AND COALESCE(m.deviation_pct, 0) <= -35
  ),
  upserted AS (
    INSERT INTO public.anomaly_insights (
      tenant_id,
      detection_key,
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
    SELECT
      v_tenant_id,
      c.detection_key,
      c.connection_id,
      c.title,
      c.description,
      c.severity,
      'open'::text,
      c.signal_type,
      jsonb_build_object(
        'generated_by', 'predictive_v2',
        'metric_key', split_part(c.detection_key, ':', 2),
        'expected', c.metric_previous_value,
        'actual', c.metric_value,
        'deviation_pct', CASE
          WHEN ABS(COALESCE(c.metric_previous_value, 0)) > 0.0001
            THEN ROUND(((COALESCE(c.metric_value, 0) - COALESCE(c.metric_previous_value, 0)) / ABS(c.metric_previous_value)) * 100.0, 2)
          ELSE NULL
        END,
        'sparkline', c.sparkline,
        'metric_series', c.metric_series,
        'analysis', c.analysis,
        'root_causes', c.root_causes,
        'recommended_actions', c.recommended_actions,
        'baseline_window_days', 28
      ),
      v_now,
      c.insight_category,
      c.confidence_score,
      c.metric_name,
      c.metric_value,
      c.metric_previous_value
    FROM candidates c
    ON CONFLICT (tenant_id, detection_key) WHERE detection_key IS NOT NULL DO UPDATE
    SET
      connection_id = EXCLUDED.connection_id,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      severity = EXCLUDED.severity,
      signal_type = EXCLUDED.signal_type,
      insight_category = EXCLUDED.insight_category,
      confidence_score = EXCLUDED.confidence_score,
      metric_name = EXCLUDED.metric_name,
      metric_value = EXCLUDED.metric_value,
      metric_previous_value = EXCLUDED.metric_previous_value,
      context = EXCLUDED.context,
      detected_at = EXCLUDED.detected_at,
      status = CASE
        WHEN public.anomaly_insights.status = 'dismissed'
          AND public.anomaly_insights.dismissed_at IS NOT NULL
          AND public.anomaly_insights.dismissed_at > (v_now - interval '24 hours')
          AND NOT p_force
          THEN 'dismissed'
        ELSE 'open'
      END,
      resolved_at = CASE
        WHEN (
          public.anomaly_insights.status = 'dismissed'
          AND public.anomaly_insights.dismissed_at IS NOT NULL
          AND public.anomaly_insights.dismissed_at > (v_now - interval '24 hours')
          AND NOT p_force
        ) THEN public.anomaly_insights.resolved_at
        ELSE NULL
      END,
      updated_at = v_now
    RETURNING id
  ),
  resolved AS (
    UPDATE public.anomaly_insights i
    SET
      status = 'resolved',
      resolved_at = COALESCE(i.resolved_at, v_now),
      updated_at = v_now,
      context = COALESCE(i.context, '{}'::jsonb) || jsonb_build_object(
        'resolved_reason', 'metric_normalized',
        'resolved_at', v_now
      )
    WHERE i.tenant_id = v_tenant_id
      AND i.detection_key IS NOT NULL
      AND i.status IN ('open', 'acknowledged')
      AND COALESCE(i.context ->> 'generated_by', '') = 'predictive_v2'
      AND NOT EXISTS (
        SELECT 1
        FROM candidates c
        WHERE c.detection_key = i.detection_key
      )
    RETURNING i.id
  )
  SELECT
    COALESCE((SELECT COUNT(*) FROM upserted), 0),
    COALESCE((SELECT COUNT(*) FROM resolved), 0)
  INTO v_generated, v_resolved;

  SELECT COUNT(*)::integer
  INTO v_active
  FROM public.anomaly_insights i
  WHERE i.tenant_id = v_tenant_id
    AND i.status IN ('open', 'acknowledged');

  RETURN jsonb_build_object(
    'tenantId', v_tenant_id,
    'refreshedAt', v_now,
    'generated', v_generated,
    'resolved', v_resolved,
    'activeInsights', v_active
  );
END;
$$;

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
  v_payload jsonb := '{}'::jsonb;
BEGIN
  v_payload := public.refresh_predictive_insights_for_tenant(p_tenant_id, p_force);
  RETURN COALESCE((v_payload ->> 'generated')::integer, 0);
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
  v_payload jsonb := '{}'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context found';
  END IF;

  v_payload := public.refresh_predictive_insights_for_tenant(v_tenant_id, true);

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'insights.refresh',
    'predictive_feed',
    'success',
    v_payload
  );

  RETURN v_payload;
END;
$$;

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
  v_last_generated timestamptz;
  v_series jsonb := '[]'::jsonb;
  v_baseline numeric := 0;
  v_stddev numeric := 0;
  v_latest numeric := 0;
  v_last7_avg numeric := 0;
  v_prev7_avg numeric := 0;
  v_slope numeric := 0;
  v_inserted integer := 0;
  v_inserted_forecast integer := 0;
  v_inserted_causes integer := 0;
  v_inserted_actions integer := 0;
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
    i.severity,
    i.detected_at,
    i.updated_at,
    i.detection_key,
    COALESCE(i.metric_name, 'Metric') AS metric_name,
    COALESCE(i.metric_previous_value, 0) AS metric_previous_value,
    COALESCE(i.metric_value, 0) AS metric_value,
    COALESCE(i.context, '{}'::jsonb) AS context
  INTO v_insight
  FROM public.anomaly_insights i
  WHERE i.id = p_insight_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  SELECT COUNT(*)::integer, MAX(created_at)
  INTO v_existing, v_last_generated
  FROM public.anomaly_metric_points p
  WHERE p.insight_id = p_insight_id;

  IF v_existing > 0
    AND p_force = false
    AND v_last_generated IS NOT NULL
    AND v_last_generated >= COALESCE(v_insight.updated_at, v_insight.detected_at) THEN
    RETURN 0;
  END IF;

  DELETE FROM public.anomaly_metric_points WHERE insight_id = p_insight_id;
  DELETE FROM public.anomaly_root_causes WHERE insight_id = p_insight_id;
  DELETE FROM public.anomaly_recommended_actions WHERE insight_id = p_insight_id;
  DELETE FROM public.anomaly_similar_events WHERE insight_id = p_insight_id;

  v_series := COALESCE(v_insight.context -> 'metric_series', '[]'::jsonb);
  IF jsonb_typeof(v_series) IS DISTINCT FROM 'array' THEN
    v_series := '[]'::jsonb;
  END IF;

  IF jsonb_array_length(v_series) = 0 THEN
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object('date', h.day, 'value', ROUND(h.value, 4))
        ORDER BY h.day
      ),
      '[]'::jsonb
    )
    INTO v_series
    FROM (
      SELECT
        date_trunc('day', ai.detected_at)::date AS day,
        AVG(ai.metric_value)::numeric AS value
      FROM public.anomaly_insights ai
      WHERE ai.tenant_id = v_insight.tenant_id
        AND ai.metric_name = v_insight.metric_name
        AND ai.metric_value IS NOT NULL
        AND ai.detected_at >= now() - interval '120 days'
      GROUP BY 1
    ) h;
  END IF;

  IF jsonb_array_length(v_series) = 0 THEN
    v_series := jsonb_build_array(
      jsonb_build_object(
        'date', (date_trunc('day', v_insight.detected_at)::date - 1),
        'value', ROUND(COALESCE(v_insight.metric_previous_value, v_insight.metric_value, 0), 4)
      ),
      jsonb_build_object(
        'date', date_trunc('day', v_insight.detected_at)::date,
        'value', ROUND(COALESCE(v_insight.metric_value, v_insight.metric_previous_value, 0), 4)
      )
    );
  END IF;

  WITH s AS (
    SELECT
      (elem ->> 'date')::date AS day,
      NULLIF(elem ->> 'value', '')::numeric AS value
    FROM jsonb_array_elements(v_series) elem
    WHERE jsonb_typeof(elem) = 'object'
      AND elem ? 'date'
      AND elem ? 'value'
  )
  SELECT
    COALESCE(
      AVG(value) FILTER (WHERE day >= (current_date - 28) AND day < current_date),
      AVG(value) FILTER (WHERE day < current_date),
      AVG(value),
      v_insight.metric_previous_value,
      v_insight.metric_value,
      0
    ),
    COALESCE(
      STDDEV_POP(value) FILTER (WHERE day >= (current_date - 28) AND day < current_date),
      STDDEV_POP(value) FILTER (WHERE day < current_date),
      STDDEV_POP(value),
      0
    ),
    COALESCE(
      MAX(value) FILTER (WHERE day = current_date),
      MAX(value) FILTER (WHERE day = date_trunc('day', v_insight.detected_at)::date),
      MAX(value),
      v_insight.metric_value,
      v_insight.metric_previous_value,
      0
    ),
    COALESCE(AVG(value) FILTER (WHERE day BETWEEN (current_date - 6) AND current_date), 0),
    COALESCE(AVG(value) FILTER (WHERE day BETWEEN (current_date - 13) AND (current_date - 7)), 0)
  INTO v_baseline, v_stddev, v_latest, v_last7_avg, v_prev7_avg
  FROM s;

  IF COALESCE(v_stddev, 0) <= 0 THEN
    v_stddev := GREATEST(ABS(v_baseline) * 0.08, 1);
  END IF;

  IF v_prev7_avg IS NOT NULL AND ABS(v_prev7_avg) > 0.0001 THEN
    v_slope := (COALESCE(v_last7_avg, v_latest) - v_prev7_avg) / 7.0;
  ELSE
    v_slope := 0;
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
  SELECT
    v_insight.tenant_id,
    v_insight.id,
    s.day,
    ROUND(v_baseline, 2),
    ROUND(s.value, 2),
    ROUND(v_baseline - (v_stddev * 1.5), 2),
    ROUND(v_baseline + (v_stddev * 1.5), 2),
    NULL,
    (
      s.day = date_trunc('day', v_insight.detected_at)::date
      OR s.value < (v_baseline - (v_stddev * 1.5))
      OR s.value > (v_baseline + (v_stddev * 1.5))
    )
  FROM (
    SELECT
      (elem ->> 'date')::date AS day,
      NULLIF(elem ->> 'value', '')::numeric AS value
    FROM jsonb_array_elements(v_series) elem
    WHERE jsonb_typeof(elem) = 'object'
      AND elem ? 'date'
      AND elem ? 'value'
  ) s
  WHERE s.day IS NOT NULL
    AND s.value IS NOT NULL
  ON CONFLICT (insight_id, observed_on) DO UPDATE
  SET
    expected_value = EXCLUDED.expected_value,
    actual_value = EXCLUDED.actual_value,
    lower_band = EXCLUDED.lower_band,
    upper_band = EXCLUDED.upper_band,
    forecast_value = EXCLUDED.forecast_value,
    is_anomaly = EXCLUDED.is_anomaly;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

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
  SELECT
    v_insight.tenant_id,
    v_insight.id,
    (current_date + offs)::date AS observed_on,
    ROUND(v_baseline, 2),
    NULL,
    ROUND(v_baseline - (v_stddev * 1.5), 2),
    ROUND(v_baseline + (v_stddev * 1.5), 2),
    ROUND((v_latest + (v_slope * offs))::numeric, 2),
    false
  FROM generate_series(1, 14) offs
  ON CONFLICT (insight_id, observed_on) DO UPDATE
  SET
    expected_value = EXCLUDED.expected_value,
    actual_value = EXCLUDED.actual_value,
    lower_band = EXCLUDED.lower_band,
    upper_band = EXCLUDED.upper_band,
    forecast_value = EXCLUDED.forecast_value,
    is_anomaly = EXCLUDED.is_anomaly;

  GET DIAGNOSTICS v_inserted_forecast = ROW_COUNT;
  v_inserted := v_inserted + v_inserted_forecast;

  INSERT INTO public.anomaly_root_causes (
    tenant_id,
    insight_id,
    factor_name,
    impact_pct,
    sort_order,
    details
  )
  SELECT
    v_insight.tenant_id,
    v_insight.id,
    COALESCE(NULLIF(trim(item ->> 'name'), ''), 'Signal change'),
    GREATEST(
      0,
      LEAST(
        100,
        COALESCE(
          NULLIF(item ->> 'impactPct', '')::numeric,
          NULLIF(item ->> 'impact_pct', '')::numeric,
          0
        )
      )
    ),
    (ord::integer) * 10,
    NULLIF(item ->> 'details', '')
  FROM jsonb_array_elements(COALESCE(v_insight.context -> 'root_causes', '[]'::jsonb)) WITH ORDINALITY t(item, ord)
  WHERE jsonb_typeof(item) = 'object';

  GET DIAGNOSTICS v_inserted_causes = ROW_COUNT;

  IF v_inserted_causes = 0 THEN
    INSERT INTO public.anomaly_root_causes (
      tenant_id,
      insight_id,
      factor_name,
      impact_pct,
      sort_order,
      details
    )
    VALUES
      (
        v_insight.tenant_id,
        v_insight.id,
        'Deviation from baseline',
        LEAST(85, GREATEST(20, ROUND(
          CASE
            WHEN ABS(v_baseline) > 0.0001 THEN ABS(((v_latest - v_baseline) / ABS(v_baseline)) * 100.0)
            ELSE 20
          END
        ))),
        10,
        'Current: ' || ROUND(v_latest, 2) || ', baseline: ' || ROUND(v_baseline, 2)
      ),
      (
        v_insight.tenant_id,
        v_insight.id,
        'Recent trend momentum',
        LEAST(60, GREATEST(10, ROUND(ABS(v_slope) * 10))),
        20,
        'Trend/day: ' || ROUND(v_slope, 3)
      );
  END IF;

  INSERT INTO public.anomaly_recommended_actions (
    tenant_id,
    insight_id,
    title,
    prompt,
    action_type,
    sort_order
  )
  SELECT
    v_insight.tenant_id,
    v_insight.id,
    COALESCE(NULLIF(trim(item ->> 'title'), ''), 'Investigate anomaly'),
    COALESCE(
      NULLIF(trim(item ->> 'prompt'), ''),
      'Investigate "' || COALESCE(v_insight.metric_name, 'metric') || '" anomaly and suggest mitigation.'
    ),
    CASE lower(COALESCE(item ->> 'actionType', item ->> 'action_type', 'chat'))
      WHEN 'workflow' THEN 'workflow'
      ELSE 'chat'
    END,
    (ord::integer) * 10
  FROM jsonb_array_elements(COALESCE(v_insight.context -> 'recommended_actions', '[]'::jsonb)) WITH ORDINALITY t(item, ord)
  WHERE jsonb_typeof(item) = 'object';

  GET DIAGNOSTICS v_inserted_actions = ROW_COUNT;

  IF v_inserted_actions = 0 THEN
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
        'Generate detailed breakdown',
        'Generate a detailed breakdown for "' || COALESCE(v_insight.metric_name, 'this metric') || '" and highlight top drivers.',
        'chat',
        10
      ),
      (
        v_insight.tenant_id,
        v_insight.id,
        'Alert responsible team',
        'Draft an alert for the responsible team summarizing this anomaly and immediate checks.',
        'chat',
        20
      ),
      (
        v_insight.tenant_id,
        v_insight.id,
        'Compare with historical periods',
        'Compare this anomaly window with prior periods and quantify recurrence patterns.',
        'chat',
        30
      );
  END IF;

  INSERT INTO public.anomaly_similar_events (
    tenant_id,
    insight_id,
    title,
    detected_at,
    severity,
    deviation_pct,
    details
  )
  SELECT
    ai.tenant_id,
    v_insight.id,
    ai.title,
    ai.detected_at,
    ai.severity,
    CASE
      WHEN ABS(COALESCE(ai.metric_previous_value, 0)) > 0.0001
        THEN ROUND(((COALESCE(ai.metric_value, 0) - ai.metric_previous_value) / ABS(ai.metric_previous_value)) * 100.0, 2)
      ELSE NULL
    END,
    ai.description
  FROM public.anomaly_insights ai
  WHERE ai.tenant_id = v_insight.tenant_id
    AND ai.id <> v_insight.id
    AND ai.detected_at >= (now() - interval '12 months')
    AND (
      (v_insight.detection_key IS NOT NULL AND ai.detection_key = v_insight.detection_key)
      OR lower(COALESCE(ai.metric_name, '')) = lower(COALESCE(v_insight.metric_name, ''))
    )
  ORDER BY ai.detected_at DESC
  LIMIT 10;

  RETURN v_inserted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_predictive_insights_for_tenant(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.seed_predictive_insights_for_tenant(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_predictive_insights() TO authenticated;
GRANT EXECUTE ON FUNCTION public.seed_anomaly_detail_for_insight(uuid, boolean) TO authenticated, service_role;
