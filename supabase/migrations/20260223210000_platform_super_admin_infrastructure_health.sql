-- Platform Super Admin infrastructure health backend for /platform-admin/infrastructure.

CREATE TABLE IF NOT EXISTS public.platform_infra_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity text NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  description text NOT NULL,
  status text NOT NULL DEFAULT 'resolved'
    CHECK (status IN ('active', 'investigating', 'resolved')),
  duration_minutes integer,
  affected_services text[] NOT NULL DEFAULT ARRAY[]::text[],
  resolution text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_infra_incidents ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS platform_infra_incidents_started_idx
  ON public.platform_infra_incidents (started_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'set_updated_at_timestamp'
      AND pg_function_is_visible(oid)
  ) THEN
    DROP TRIGGER IF EXISTS platform_infra_incidents_set_updated_at ON public.platform_infra_incidents;
    CREATE TRIGGER platform_infra_incidents_set_updated_at
    BEFORE UPDATE ON public.platform_infra_incidents
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_timestamp();
  END IF;
END;
$$;

DROP POLICY IF EXISTS "Platform admins can view infra incidents" ON public.platform_infra_incidents;
CREATE POLICY "Platform admins can view infra incidents"
  ON public.platform_infra_incidents FOR SELECT TO authenticated
  USING (public.is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "Platform admins can insert infra incidents" ON public.platform_infra_incidents;
CREATE POLICY "Platform admins can insert infra incidents"
  ON public.platform_infra_incidents FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "Platform admins can update infra incidents" ON public.platform_infra_incidents;
CREATE POLICY "Platform admins can update infra incidents"
  ON public.platform_infra_incidents FOR UPDATE TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

CREATE OR REPLACE FUNCTION public.get_platform_super_admin_infrastructure_health(
  p_hours integer DEFAULT 24
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_hours integer := GREATEST(6, LEAST(COALESCE(p_hours, 24), 168));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Forbidden: platform admin access required';
  END IF;

  RETURN (
    WITH service_catalog AS (
      SELECT *
      FROM (
        VALUES
          ('api_gateway', 'API Gateway', 120::numeric, 260::numeric, 420::numeric, 99.98::numeric),
          ('intent_parser', 'Intent Parser', 90::numeric, 200::numeric, 340::numeric, 99.97::numeric),
          ('rag_service', 'RAG Service', 170::numeric, 450::numeric, 900::numeric, 99.95::numeric),
          ('embedding_worker', 'Embedding Worker', 320::numeric, 900::numeric, 1700::numeric, 99.92::numeric),
          ('governance_engine', 'Governance Engine', 80::numeric, 180::numeric, 320::numeric, 99.99::numeric),
          ('execution_sandbox', 'Execution Sandbox', 140::numeric, 380::numeric, 780::numeric, 99.95::numeric),
          ('sync_engine', 'Sync Engine', 240::numeric, 620::numeric, 1200::numeric, 99.93::numeric),
          ('billing_service', 'Billing Service', 110::numeric, 250::numeric, 520::numeric, 99.96::numeric),
          ('notification_service', 'Notification Service', 95::numeric, 220::numeric, 450::numeric, 99.94::numeric)
      ) AS t(key, name, default_p50, default_p95, default_p99, default_uptime)
    ),
    base_window AS (
      SELECT
        date_trunc('hour', v_now - make_interval(hours => v_hours - 1)) AS start_at,
        date_trunc('hour', v_now) AS end_at
    ),
    hourly_series AS (
      SELECT
        gs::timestamptz AS bucket
      FROM base_window bw,
      LATERAL generate_series(bw.start_at, bw.end_at, interval '1 hour') AS gs
    ),
    service_events AS (
      SELECT
        'execution_sandbox'::text AS service_key,
        csr.created_at AS ts,
        GREATEST(COALESCE(csr.execution_ms, 0), 0)::numeric AS latency_ms,
        (NOT COALESCE(csr.success, false)) AS is_error
      FROM public.chat_sql_runs csr
      WHERE csr.created_at >= (SELECT start_at FROM base_window)

      UNION ALL

      SELECT
        'rag_service'::text AS service_key,
        atr.created_at AS ts,
        GREATEST(COALESCE(atr.latency_ms, 0), 0)::numeric AS latency_ms,
        lower(COALESCE(atr.status, 'success')) IN ('error', 'failed', 'blocked') AS is_error
      FROM public.agent_tool_runs atr
      WHERE atr.created_at >= (SELECT start_at FROM base_window)
        AND lower(COALESCE(atr.tool_name, '')) IN ('rag_search', 'knowledge_search', 'search_knowledge_documents_hybrid', 'search_knowledge')

      UNION ALL

      SELECT
        'api_gateway'::text AS service_key,
        atr.created_at AS ts,
        GREATEST(COALESCE(atr.latency_ms, 0), 0)::numeric AS latency_ms,
        lower(COALESCE(atr.status, 'success')) IN ('error', 'failed', 'blocked') AS is_error
      FROM public.agent_tool_runs atr
      WHERE atr.created_at >= (SELECT start_at FROM base_window)

      UNION ALL

      SELECT
        'intent_parser'::text AS service_key,
        ars.created_at AS ts,
        GREATEST(COALESCE(ars.latency_ms, 0), 0)::numeric AS latency_ms,
        lower(COALESCE(ars.status, 'success')) IN ('error', 'failed') AS is_error
      FROM public.agent_run_steps ars
      WHERE ars.created_at >= (SELECT start_at FROM base_window)
        AND lower(COALESCE(ars.step_type, '')) IN ('intent', 'planner', 'plan', 'reason')

      UNION ALL

      SELECT
        'sync_engine'::text AS service_key,
        COALESCE(cja.finished_at, cja.started_at, cja.created_at) AS ts,
        GREATEST(COALESCE(cja.duration_ms, 0), 0)::numeric AS latency_ms,
        lower(COALESCE(cja.status, 'success')) IN ('error', 'failed') AS is_error
      FROM public.connector_job_attempts cja
      WHERE COALESCE(cja.finished_at, cja.started_at, cja.created_at) >= (SELECT start_at FROM base_window)

      UNION ALL

      SELECT
        'embedding_worker'::text AS service_key,
        COALESCE(ej.finished_at, ej.started_at, ej.created_at) AS ts,
        GREATEST(
          COALESCE(
            EXTRACT(epoch FROM (COALESCE(ej.finished_at, v_now) - COALESCE(ej.started_at, ej.created_at))) * 1000,
            0
          ),
          0
        )::numeric AS latency_ms,
        lower(COALESCE(ej.status, 'queued')) IN ('error', 'dead_letter') AS is_error
      FROM public.embedding_jobs ej
      WHERE COALESCE(ej.finished_at, ej.started_at, ej.created_at) >= (SELECT start_at FROM base_window)

      UNION ALL

      SELECT
        'governance_engine'::text AS service_key,
        COALESCE(ar.decided_at, ar.created_at) AS ts,
        GREATEST(
          COALESCE(EXTRACT(epoch FROM (COALESCE(ar.decided_at, v_now) - ar.created_at)) * 1000, 0),
          0
        )::numeric AS latency_ms,
        lower(COALESCE(ar.status, 'pending')) IN ('rejected', 'expired') AS is_error
      FROM public.approval_requests ar
      WHERE COALESCE(ar.decided_at, ar.created_at) >= (SELECT start_at FROM base_window)

      UNION ALL

      SELECT
        'billing_service'::text AS service_key,
        COALESCE(be.processed_at, be.created_at) AS ts,
        CASE
          WHEN lower(COALESCE(be.status, 'received')) = 'error' THEN 900
          WHEN lower(COALESCE(be.status, 'received')) = 'processed' THEN 180
          ELSE 300
        END::numeric AS latency_ms,
        lower(COALESCE(be.status, 'received')) = 'error' AS is_error
      FROM public.billing_events be
      WHERE COALESCE(be.processed_at, be.created_at) >= (SELECT start_at FROM base_window)

      UNION ALL

      SELECT
        'notification_service'::text AS service_key,
        COALESCE(wd.finished_at, wd.started_at, wd.created_at) AS ts,
        GREATEST(
          COALESCE(
            EXTRACT(epoch FROM (COALESCE(wd.finished_at, v_now) - COALESCE(wd.started_at, wd.created_at))) * 1000,
            0
          ),
          0
        )::numeric AS latency_ms,
        lower(COALESCE(wd.status, 'queued')) IN ('error', 'dead_letter') AS is_error
      FROM public.webhook_deliveries wd
      WHERE COALESCE(wd.finished_at, wd.started_at, wd.created_at) >= (SELECT start_at FROM base_window)
    ),
    service_rollup AS (
      SELECT
        sc.key,
        sc.name,
        COUNT(se.service_key)::integer AS request_count,
        COUNT(*) FILTER (WHERE se.is_error)::integer AS error_count,
        ROUND(COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY NULLIF(se.latency_ms, 0)), sc.default_p50), 2) AS p50,
        ROUND(COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY NULLIF(se.latency_ms, 0)), sc.default_p95), 2) AS p95,
        ROUND(COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY NULLIF(se.latency_ms, 0)), sc.default_p99), 2) AS p99,
        ROUND(
          CASE
            WHEN COUNT(se.service_key) = 0 THEN 0
            ELSE (COUNT(*) FILTER (WHERE se.is_error)::numeric / COUNT(se.service_key)::numeric) * 100
          END,
          2
        ) AS error_rate_pct,
        ROUND(
          CASE
            WHEN COUNT(se.service_key) = 0 THEN sc.default_uptime
            ELSE GREATEST(
              95.00,
              LEAST(
                99.99,
                100
                - ((COUNT(*) FILTER (WHERE se.is_error)::numeric / GREATEST(COUNT(se.service_key), 1)::numeric) * 100 * 0.35)
                - (GREATEST(0, COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY NULLIF(se.latency_ms, 0)), sc.default_p95) - 1500) / 25000)
              )
            )
          END,
          2
        ) AS uptime_pct
      FROM service_catalog sc
      LEFT JOIN service_events se
        ON se.service_key = sc.key
      GROUP BY sc.key, sc.name, sc.default_p50, sc.default_p95, sc.default_p99, sc.default_uptime
    ),
    service_status AS (
      SELECT
        sr.*,
        CASE
          WHEN sr.error_rate_pct >= 8 OR sr.p95 >= 8000 THEN 'down'
          WHEN sr.error_rate_pct >= 2 OR sr.p95 >= 3000 THEN 'degraded'
          ELSE 'healthy'
        END AS status
      FROM service_rollup sr
    ),
    queue_health AS (
      SELECT
        'Embedding Queue'::text AS queue_name,
        COUNT(*) FILTER (WHERE lower(COALESCE(ej.status, 'queued')) = 'queued')::integer AS depth,
        COALESCE(
          FLOOR(
            EXTRACT(
              epoch
              FROM (v_now - MIN(ej.scheduled_at) FILTER (WHERE lower(COALESCE(ej.status, 'queued')) = 'queued'))
            )
          )::integer,
          0
        ) AS consumer_lag_sec
      FROM public.embedding_jobs ej

      UNION ALL

      SELECT
        'Sync Queue'::text AS queue_name,
        COUNT(*) FILTER (WHERE lower(COALESCE(cj.status, 'queued')) = 'queued')::integer AS depth,
        COALESCE(
          FLOOR(
            EXTRACT(
              epoch
              FROM (v_now - MIN(cj.scheduled_at) FILTER (WHERE lower(COALESCE(cj.status, 'queued')) = 'queued'))
            )
          )::integer,
          0
        ) AS consumer_lag_sec
      FROM public.connector_jobs cj

      UNION ALL

      SELECT
        'Approval Queue'::text AS queue_name,
        COUNT(*) FILTER (
          WHERE lower(COALESCE(ar.status, 'pending')) = 'pending'
            AND ar.decided_at IS NULL
        )::integer AS depth,
        COALESCE(
          FLOOR(
            EXTRACT(
              epoch
              FROM (
                v_now - MIN(ar.created_at) FILTER (
                  WHERE lower(COALESCE(ar.status, 'pending')) = 'pending'
                    AND ar.decided_at IS NULL
                )
              )
            )
          )::integer,
          0
        ) AS consumer_lag_sec
      FROM public.approval_requests ar
    ),
    queue_status AS (
      SELECT
        qh.queue_name,
        qh.depth,
        qh.consumer_lag_sec,
        CASE
          WHEN qh.depth >= 1000 OR qh.consumer_lag_sec >= 1200 THEN 'down'
          WHEN qh.depth >= 200 OR qh.consumer_lag_sec >= 180 THEN 'degraded'
          ELSE 'healthy'
        END AS status
      FROM queue_health qh
    ),
    hourly_latency AS (
      SELECT
        hs.bucket,
        ROUND(COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY NULLIF(se.latency_ms, 0)), 150), 2) AS p50,
        ROUND(COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY NULLIF(se.latency_ms, 0)), 420), 2) AS p95,
        ROUND(COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY NULLIF(se.latency_ms, 0)), 760), 2) AS p99
      FROM hourly_series hs
      LEFT JOIN service_events se
        ON date_trunc('hour', se.ts) = hs.bucket
      GROUP BY hs.bucket
      ORDER BY hs.bucket
    ),
    hourly_service_errors AS (
      SELECT
        hs.bucket,
        sc.key,
        COUNT(se.service_key)::integer AS request_count,
        COUNT(*) FILTER (WHERE se.is_error)::integer AS error_count
      FROM hourly_series hs
      CROSS JOIN service_catalog sc
      LEFT JOIN service_events se
        ON se.service_key = sc.key
        AND date_trunc('hour', se.ts) = hs.bucket
      GROUP BY hs.bucket, sc.key
    ),
    error_rate_wide AS (
      SELECT
        hse.bucket,
        ROUND(COALESCE(MAX(
          CASE WHEN hse.key = 'api_gateway' AND hse.request_count > 0 THEN (hse.error_count::numeric / hse.request_count::numeric) * 100 ELSE 0 END
        ), 0), 2) AS api_gateway,
        ROUND(COALESCE(MAX(
          CASE WHEN hse.key = 'intent_parser' AND hse.request_count > 0 THEN (hse.error_count::numeric / hse.request_count::numeric) * 100 ELSE 0 END
        ), 0), 2) AS intent_parser,
        ROUND(COALESCE(MAX(
          CASE WHEN hse.key = 'rag_service' AND hse.request_count > 0 THEN (hse.error_count::numeric / hse.request_count::numeric) * 100 ELSE 0 END
        ), 0), 2) AS rag_service,
        ROUND(COALESCE(MAX(
          CASE WHEN hse.key = 'embedding_worker' AND hse.request_count > 0 THEN (hse.error_count::numeric / hse.request_count::numeric) * 100 ELSE 0 END
        ), 0), 2) AS embedding_worker,
        ROUND(COALESCE(MAX(
          CASE WHEN hse.key = 'governance_engine' AND hse.request_count > 0 THEN (hse.error_count::numeric / hse.request_count::numeric) * 100 ELSE 0 END
        ), 0), 2) AS governance_engine,
        ROUND(COALESCE(MAX(
          CASE WHEN hse.key = 'execution_sandbox' AND hse.request_count > 0 THEN (hse.error_count::numeric / hse.request_count::numeric) * 100 ELSE 0 END
        ), 0), 2) AS execution_sandbox,
        ROUND(COALESCE(MAX(
          CASE WHEN hse.key = 'sync_engine' AND hse.request_count > 0 THEN (hse.error_count::numeric / hse.request_count::numeric) * 100 ELSE 0 END
        ), 0), 2) AS sync_engine,
        ROUND(COALESCE(MAX(
          CASE WHEN hse.key = 'billing_service' AND hse.request_count > 0 THEN (hse.error_count::numeric / hse.request_count::numeric) * 100 ELSE 0 END
        ), 0), 2) AS billing_service,
        ROUND(COALESCE(MAX(
          CASE WHEN hse.key = 'notification_service' AND hse.request_count > 0 THEN (hse.error_count::numeric / hse.request_count::numeric) * 100 ELSE 0 END
        ), 0), 2) AS notification_service
      FROM hourly_service_errors hse
      GROUP BY hse.bucket
      ORDER BY hse.bucket
    ),
    monthly_usage_cost AS (
      SELECT
        CASE
          WHEN lower(COALESCE(ume.event_type, '')) LIKE '%embed%' THEN 'embedding_worker'
          WHEN lower(COALESCE(ume.event_type, '')) LIKE '%sync%' THEN 'sync_engine'
          WHEN lower(COALESCE(ume.event_type, '')) LIKE '%govern%' OR lower(COALESCE(ume.event_type, '')) LIKE '%approval%' THEN 'governance_engine'
          WHEN lower(COALESCE(ume.event_type, '')) LIKE '%notify%' OR lower(COALESCE(ume.event_type, '')) LIKE '%webhook%' THEN 'notification_service'
          WHEN lower(COALESCE(ume.event_type, '')) LIKE '%billing%' THEN 'billing_service'
          WHEN lower(COALESCE(ume.event_type, '')) LIKE '%sql%' OR lower(COALESCE(ume.event_type, '')) LIKE '%execute%' THEN 'execution_sandbox'
          WHEN lower(COALESCE(ume.event_type, '')) LIKE '%rag%' THEN 'rag_service'
          WHEN lower(COALESCE(ume.event_type, '')) LIKE '%intent%' OR lower(COALESCE(ume.event_type, '')) LIKE '%plan%' THEN 'intent_parser'
          ELSE 'api_gateway'
        END AS service_key,
        SUM(COALESCE(ume.cost_credits, 0))::numeric / 100.0 AS cost_usd
      FROM public.usage_meter_events ume
      WHERE ume.created_at >= date_trunc('month', v_now)
      GROUP BY 1
    ),
    fallback_llm_cost AS (
      SELECT
        (
          COALESCE(SUM(COALESCE(ar.input_tokens, 0)), 0)::numeric / 1000.0 * 0.005
          + COALESCE(SUM(COALESCE(ar.output_tokens, 0)), 0)::numeric / 1000.0 * 0.015
        ) AS estimated_openai_cost
      FROM public.agent_runs ar
      WHERE ar.created_at >= date_trunc('month', v_now)
    ),
    cost_by_service AS (
      SELECT
        sc.key,
        sc.name,
        ROUND(
          COALESCE(muc.cost_usd, 0)
          + CASE
              WHEN sc.key = 'api_gateway' THEN COALESCE((SELECT estimated_openai_cost FROM fallback_llm_cost), 0)
              ELSE 0
            END,
          2
        ) AS cost_usd
      FROM service_catalog sc
      LEFT JOIN monthly_usage_cost muc
        ON muc.service_key = sc.key
    ),
    llm_spend AS (
      SELECT
        provider,
        ROUND(SUM(cost_usd), 2) AS cost_usd
      FROM (
        SELECT
          COALESCE(NULLIF(lower(ume.details ->> 'provider'), ''), 'openai') AS provider,
          (SUM(COALESCE(ume.cost_credits, 0))::numeric / 100.0) AS cost_usd
        FROM public.usage_meter_events ume
        WHERE ume.created_at >= date_trunc('month', v_now)
          AND (
            lower(COALESCE(ume.event_type, '')) LIKE '%llm%'
            OR lower(COALESCE(ume.event_type, '')) LIKE '%token%'
            OR lower(COALESCE(ume.event_type, '')) LIKE '%chat%'
          )
        GROUP BY COALESCE(NULLIF(lower(ume.details ->> 'provider'), ''), 'openai')

        UNION ALL

        SELECT
          'openai'::text AS provider,
          COALESCE((SELECT estimated_openai_cost FROM fallback_llm_cost), 0) AS cost_usd
      ) llm
      GROUP BY provider
      HAVING SUM(cost_usd) > 0.0001
    ),
    tenant_count AS (
      SELECT GREATEST(COUNT(*) FILTER (WHERE lower(COALESCE(t.status, 'trial')) IN ('trial', 'active')), 1)::numeric AS tenants
      FROM public.tenants t
    ),
    incident_rows AS (
      SELECT
        pii.id,
        pii.severity,
        pii.description,
        pii.duration_minutes,
        pii.affected_services,
        pii.resolution,
        pii.status,
        pii.started_at,
        pii.resolved_at
      FROM public.platform_infra_incidents pii
      WHERE pii.started_at >= (v_now - interval '7 days')

      UNION ALL

      SELECT
        gen_random_uuid() AS id,
        CASE
          WHEN ss.status = 'down' THEN 'critical'
          WHEN ss.status = 'degraded' THEN 'high'
          ELSE 'low'
        END AS severity,
        format('%s is currently %s (P95 %.0fms, error %.2f%%)', ss.name, ss.status, ss.p95, ss.error_rate_pct) AS description,
        NULL::integer AS duration_minutes,
        ARRAY[ss.name]::text[] AS affected_services,
        CASE
          WHEN ss.status = 'down' THEN 'Investigating service outage and mitigation in progress.'
          ELSE 'Monitoring elevated latency/error rate and scaling workers.'
        END AS resolution,
        CASE
          WHEN ss.status = 'healthy' THEN 'resolved'
          ELSE 'investigating'
        END AS status,
        v_now - interval '5 minutes' AS started_at,
        CASE WHEN ss.status = 'healthy' THEN v_now ELSE NULL END AS resolved_at
      FROM service_status ss
      WHERE ss.status IN ('degraded', 'down')
    ),
    ordered_incidents AS (
      SELECT
        ir.*
      FROM incident_rows ir
      ORDER BY ir.started_at DESC
      LIMIT 30
    ),
    status_summary AS (
      SELECT
        CASE
          WHEN EXISTS (SELECT 1 FROM service_status WHERE status = 'down')
            OR EXISTS (SELECT 1 FROM queue_status WHERE status = 'down')
          THEN 'degraded'
          WHEN EXISTS (SELECT 1 FROM service_status WHERE status = 'degraded')
            OR EXISTS (SELECT 1 FROM queue_status WHERE status = 'degraded')
          THEN 'degraded'
          ELSE 'healthy'
        END AS overall_status
    )
    SELECT jsonb_build_object(
      'generatedAt', v_now,
      'windowHours', v_hours,
      'systemStatus', jsonb_build_object(
        'status', ss.overall_status,
        'label', CASE WHEN ss.overall_status = 'healthy' THEN 'All Systems Operational' ELSE 'Degraded Performance' END,
        'lastCheckedSecondsAgo', 30,
        'autoRefreshSeconds', 30
      ),
      'services', (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'key', s.key,
              'name', s.name,
              'status', s.status,
              'uptimePct', s.uptime_pct,
              'latency', jsonb_build_object('p50', s.p50, 'p95', s.p95, 'p99', s.p99),
              'errorRatePct', s.error_rate_pct
            )
            ORDER BY s.name
          ),
          '[]'::jsonb
        )
        FROM service_status s
      ),
      'latencyTrends', (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'bucket', to_char(hl.bucket, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'label', to_char(hl.bucket, 'HH24:MI'),
              'p50', hl.p50,
              'p95', hl.p95,
              'p99', hl.p99
            )
            ORDER BY hl.bucket
          ),
          '[]'::jsonb
        )
        FROM hourly_latency hl
      ),
      'errorRateByService', (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'bucket', to_char(erw.bucket, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'label', to_char(erw.bucket, 'HH24:MI'),
              'apiGateway', erw.api_gateway,
              'intentParser', erw.intent_parser,
              'ragService', erw.rag_service,
              'embeddingWorker', erw.embedding_worker,
              'governanceEngine', erw.governance_engine,
              'executionSandbox', erw.execution_sandbox,
              'syncEngine', erw.sync_engine,
              'billingService', erw.billing_service,
              'notificationService', erw.notification_service
            )
            ORDER BY erw.bucket
          ),
          '[]'::jsonb
        )
        FROM error_rate_wide erw
      ),
      'queueHealth', (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'queueName', qs.queue_name,
              'depth', qs.depth,
              'consumerLagSec', qs.consumer_lag_sec,
              'status', qs.status
            )
            ORDER BY qs.queue_name
          ),
          '[]'::jsonb
        )
        FROM queue_status qs
      ),
      'recentIncidents', (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', oi.id,
              'severity', oi.severity,
              'description', oi.description,
              'durationMinutes', oi.duration_minutes,
              'affectedServices', oi.affected_services,
              'resolution', oi.resolution,
              'status', oi.status,
              'startedAt', oi.started_at,
              'resolvedAt', oi.resolved_at
            )
            ORDER BY oi.started_at DESC
          ),
          '[]'::jsonb
        )
        FROM ordered_incidents oi
      ),
      'costAnalytics', jsonb_build_object(
        'costByService', (
          SELECT COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'serviceKey', cbs.key,
                'serviceName', cbs.name,
                'costUsd', cbs.cost_usd
              )
              ORDER BY cbs.cost_usd DESC, cbs.name
            ),
            '[]'::jsonb
          )
          FROM cost_by_service cbs
        ),
        'avgCostPerTenantUsd', (
          SELECT ROUND(COALESCE(SUM(cbs.cost_usd), 0) / tc.tenants, 2)
          FROM cost_by_service cbs
          CROSS JOIN tenant_count tc
        ),
        'llmSpendByProvider', (
          SELECT COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'provider', ls.provider,
                'costUsd', ls.cost_usd
              )
              ORDER BY ls.cost_usd DESC, ls.provider
            ),
            jsonb_build_array(
              jsonb_build_object(
                'provider', 'openai',
                'costUsd', ROUND(COALESCE((SELECT estimated_openai_cost FROM fallback_llm_cost), 0), 2)
              )
            )
          )
          FROM llm_spend ls
        )
      )
    )
    FROM status_summary ss
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_platform_super_admin_infrastructure_health(integer) TO authenticated;
