-- Audit Log full-view backend payload, filters, stats, and realtime wiring.

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created_at
  ON public.audit_logs (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_status_created_at
  ON public.audit_logs (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_risk_created_at
  ON public.audit_logs (tenant_id, risk_level, created_at DESC);

CREATE OR REPLACE FUNCTION public.get_audit_log_full_payload(
  p_search text DEFAULT NULL,
  p_risk_filter text DEFAULT 'all',
  p_action_type_filter text DEFAULT 'all',
  p_status_filter text DEFAULT 'all',
  p_user_filter text DEFAULT NULL,
  p_agent_filter text DEFAULT 'all',
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := public.get_user_tenant_id();
  v_from_date date := COALESCE(p_date_from, (now()::date - 6));
  v_to_date date := COALESCE(p_date_to, now()::date);
  v_from_ts timestamptz := v_from_date::timestamptz;
  v_to_ts timestamptz := (v_to_date + 1)::timestamptz;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);

  v_rows jsonb := '[]'::jsonb;
  v_total integer := 0;
  v_users jsonb := '[]'::jsonb;
  v_agents jsonb := '[]'::jsonb;
  v_week_trend jsonb := '[]'::jsonb;
  v_today_actions integer := 0;
  v_today_blocked integer := 0;
  v_today_approved integer := 0;
BEGIN
  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object(
      'rows', '[]'::jsonb,
      'total', 0,
      'stats', jsonb_build_object('todayActions', 0, 'todayBlocked', 0, 'todayApproved', 0),
      'weekTrend', '[]'::jsonb,
      'filterOptions', jsonb_build_object('users', '[]'::jsonb, 'agents', '[]'::jsonb),
      'page', jsonb_build_object('limit', v_limit, 'offset', v_offset),
      'dateRange', jsonb_build_object('from', v_from_date, 'to', v_to_date)
    );
  END IF;

  WITH normalized AS (
    SELECT
      al.id,
      al.created_at,
      al.user_id,
      COALESCE(NULLIF(pr.full_name, ''), CASE WHEN al.user_id IS NULL THEN 'System' ELSE 'User ' || left(al.user_id::text, 8) END) AS user_name,
      pr.avatar_url,
      al.action,
      al.resource,
      CASE
        WHEN lower(COALESCE(al.risk_level, '')) IN ('low', 'medium', 'high', 'critical') THEN lower(al.risk_level)
        ELSE 'low'
      END AS risk_level,
      CASE
        WHEN lower(COALESCE(al.status, '')) IN ('blocked', 'denied') OR lower(al.action) LIKE '%block%' THEN 'blocked'
        WHEN lower(COALESCE(al.status, '')) IN ('failed', 'error', 'rejected', 'denied') THEN 'failed'
        WHEN lower(COALESCE(al.status, '')) IN ('pending', 'pending_approval', 'awaiting_approval') THEN 'pending_approval'
        ELSE 'success'
      END AS status,
      COALESCE(
        NULLIF(al.details ->> 'agent', ''),
        NULLIF(al.details ->> 'agent_name', ''),
        NULLIF(al.details ->> 'agentName', ''),
        'Direct'
      ) AS agent_name,
      CASE
        WHEN lower(COALESCE(al.details ->> 'actionType', '')) IN ('query', 'update', 'delete', 'blocked')
          THEN lower(al.details ->> 'actionType')
        WHEN lower(COALESCE(al.status, '')) IN ('blocked', 'denied') OR lower(al.action) LIKE '%block%'
          THEN 'blocked'
        WHEN lower(al.action) LIKE '%delete%' OR lower(al.action) LIKE '%remove%' OR lower(al.action) LIKE '%drop%'
          THEN 'delete'
        WHEN lower(al.action) LIKE '%update%' OR lower(al.action) LIKE '%insert%' OR lower(al.action) LIKE '%upsert%'
          OR lower(al.action) LIKE '%approve%' OR lower(al.action) LIKE '%set %' OR lower(al.action) LIKE '%write%'
          THEN 'update'
        ELSE 'query'
      END AS action_type,
      COALESCE(al.details, '{}'::jsonb) AS details
    FROM public.audit_logs al
    LEFT JOIN public.profiles pr
      ON pr.id = al.user_id
     AND pr.tenant_id = al.tenant_id
    WHERE al.tenant_id = v_tenant
      AND al.created_at >= v_from_ts
      AND al.created_at < v_to_ts
  ),
  filtered AS (
    SELECT n.*
    FROM normalized n
    WHERE (
      COALESCE(NULLIF(trim(COALESCE(p_search, '')), ''), '') = ''
      OR n.user_name ILIKE '%' || trim(COALESCE(p_search, '')) || '%'
      OR n.action ILIKE '%' || trim(COALESCE(p_search, '')) || '%'
      OR n.resource ILIKE '%' || trim(COALESCE(p_search, '')) || '%'
      OR n.agent_name ILIKE '%' || trim(COALESCE(p_search, '')) || '%'
    )
      AND (lower(COALESCE(p_risk_filter, 'all')) = 'all' OR n.risk_level = lower(p_risk_filter))
      AND (lower(COALESCE(p_action_type_filter, 'all')) = 'all' OR n.action_type = lower(p_action_type_filter))
      AND (lower(COALESCE(p_status_filter, 'all')) = 'all' OR n.status = lower(p_status_filter))
      AND (COALESCE(NULLIF(trim(COALESCE(p_user_filter, '')), ''), '') = '' OR n.user_id::text = trim(p_user_filter))
      AND (lower(COALESCE(p_agent_filter, 'all')) = 'all' OR lower(n.agent_name) = lower(trim(COALESCE(p_agent_filter, ''))))
  ),
  paged AS (
    SELECT *
    FROM filtered
    ORDER BY created_at DESC
    LIMIT v_limit
    OFFSET v_offset
  )
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'createdAt', p.created_at,
          'userId', p.user_id,
          'userName', p.user_name,
          'userAvatar', p.avatar_url,
          'agent', p.agent_name,
          'action', p.action,
          'actionType', p.action_type,
          'resource', p.resource,
          'riskLevel', p.risk_level,
          'status', p.status,
          'details', p.details
        )
        ORDER BY p.created_at DESC
      ),
      '[]'::jsonb
    ),
    COALESCE((SELECT COUNT(*)::integer FROM filtered), 0)
  INTO v_rows, v_total
  FROM paged p;

  WITH normalized AS (
    SELECT
      al.user_id,
      COALESCE(NULLIF(pr.full_name, ''), CASE WHEN al.user_id IS NULL THEN 'System' ELSE 'User ' || left(al.user_id::text, 8) END) AS user_name,
      pr.avatar_url,
      COALESCE(
        NULLIF(al.details ->> 'agent', ''),
        NULLIF(al.details ->> 'agent_name', ''),
        NULLIF(al.details ->> 'agentName', ''),
        'Direct'
      ) AS agent_name
    FROM public.audit_logs al
    LEFT JOIN public.profiles pr
      ON pr.id = al.user_id
     AND pr.tenant_id = al.tenant_id
    WHERE al.tenant_id = v_tenant
      AND al.created_at >= v_from_ts
      AND al.created_at < v_to_ts
  )
  SELECT
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', x.user_id,
            'name', x.user_name,
            'avatarUrl', x.avatar_url
          )
          ORDER BY x.user_name
        )
        FROM (
          SELECT DISTINCT user_id, user_name, avatar_url
          FROM normalized
          WHERE user_id IS NOT NULL
        ) x
      ),
      '[]'::jsonb
    ),
    COALESCE(
      (
        SELECT jsonb_agg(a.agent_name ORDER BY a.agent_name)
        FROM (
          SELECT DISTINCT agent_name
          FROM normalized
          WHERE agent_name IS NOT NULL
            AND trim(agent_name) <> ''
        ) a
      ),
      '[]'::jsonb
    )
  INTO v_users, v_agents;

  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (
      WHERE lower(COALESCE(al.status, '')) IN ('blocked', 'denied')
         OR lower(al.action) LIKE '%block%'
    )::integer,
    COUNT(*) FILTER (
      WHERE lower(COALESCE(al.status, '')) IN ('approved', 'success')
    )::integer
  INTO v_today_actions, v_today_blocked, v_today_approved
  FROM public.audit_logs al
  WHERE al.tenant_id = v_tenant
    AND al.created_at >= date_trunc('day', now())
    AND al.created_at < date_trunc('day', now()) + interval '1 day';

  WITH days AS (
    SELECT generate_series((now()::date - 6), now()::date, interval '1 day')::date AS day
  ),
  day_counts AS (
    SELECT
      d.day,
      COUNT(al.id)::integer AS total,
      COUNT(al.id) FILTER (
        WHERE lower(COALESCE(al.status, '')) IN ('blocked', 'denied')
           OR lower(al.action) LIKE '%block%'
      )::integer AS blocked,
      COUNT(al.id) FILTER (
        WHERE lower(COALESCE(al.status, '')) IN ('approved', 'success')
      )::integer AS approved
    FROM days d
    LEFT JOIN public.audit_logs al
      ON al.tenant_id = v_tenant
     AND al.created_at >= d.day::timestamptz
     AND al.created_at < (d.day + 1)::timestamptz
    GROUP BY d.day
    ORDER BY d.day
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'date', to_char(dc.day, 'YYYY-MM-DD'),
        'total', dc.total,
        'blocked', dc.blocked,
        'approved', dc.approved
      )
      ORDER BY dc.day
    ),
    '[]'::jsonb
  )
  INTO v_week_trend
  FROM day_counts dc;

  RETURN jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'stats', jsonb_build_object(
      'todayActions', COALESCE(v_today_actions, 0),
      'todayBlocked', COALESCE(v_today_blocked, 0),
      'todayApproved', COALESCE(v_today_approved, 0)
    ),
    'weekTrend', v_week_trend,
    'filterOptions', jsonb_build_object(
      'users', v_users,
      'agents', v_agents
    ),
    'page', jsonb_build_object(
      'limit', v_limit,
      'offset', v_offset
    ),
    'dateRange', jsonb_build_object(
      'from', v_from_date,
      'to', v_to_date
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_audit_log_full_payload(text, text, text, text, text, text, date, date, integer, integer) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'audit_logs'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.audit_logs';
  END IF;
END;
$$;
