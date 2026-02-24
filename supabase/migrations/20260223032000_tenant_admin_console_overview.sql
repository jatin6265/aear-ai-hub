-- Tenant Admin Console overview payload for /dashboard/admin.

CREATE OR REPLACE FUNCTION public.get_tenant_admin_console_overview()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role text := 'member';

  v_connections_total integer := 0;
  v_connections_healthy integer := 0;
  v_connections_errors integer := 0;

  v_team_active integer := 0;
  v_team_pending integer := 0;

  v_raci_rules_defined integer := 0;
  v_raci_covered integer := 0;
  v_raci_coverage_score integer := 0;

  v_pending_approvals integer := 0;

  v_agents_active integer := 0;
  v_agents_total integer := 0;

  v_subscription_status text := '';

  v_audit_total_7d integer := 0;
  v_audit_flagged_7d integer := 0;

  v_connection_score integer := 60;
  v_billing_score integer := 70;
  v_audit_score integer := 90;
  v_health_score integer := 0;

  v_raci_distribution jsonb := '[]'::jsonb;
  v_recent_events jsonb := '[]'::jsonb;

  v_critical_resources_total integer := 0;
  v_critical_resources_covered integer := 0;
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
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE COALESCE(c.is_archived, false) = false)::integer,
    COUNT(*) FILTER (
      WHERE COALESCE(c.is_archived, false) = false
        AND lower(COALESCE(c.status, '')) IN ('active', 'healthy', 'syncing', 'ready')
    )::integer,
    COUNT(*) FILTER (
      WHERE COALESCE(c.is_archived, false) = false
        AND lower(COALESCE(c.status, '')) IN ('error', 'failed')
    )::integer
  INTO v_connections_total, v_connections_healthy, v_connections_errors
  FROM public.api_connections c
  WHERE c.tenant_id = v_tenant_id;

  IF v_connections_total > 0 THEN
    v_connection_score := GREATEST(0, LEAST(100, ROUND((v_connections_healthy::numeric / v_connections_total::numeric) * 100)::integer));
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE COALESCE(p.status, 'active') = 'active')::integer
  INTO v_team_active
  FROM public.profiles p
  WHERE p.tenant_id = v_tenant_id;

  SELECT
    COUNT(*) FILTER (
      WHERE lower(COALESCE(ti.status, 'pending')) IN ('pending', 'sent')
        AND COALESCE(ti.expires_at, now() + interval '1 day') > now()
    )::integer
  INTO v_team_pending
  FROM public.team_invitations ti
  WHERE ti.tenant_id = v_tenant_id;

  WITH grouped AS (
    SELECT
      rm.resource,
      rm.action,
      bool_or(upper(rm.raci_type) = 'R') AS has_r,
      bool_or(upper(rm.raci_type) = 'A') AS has_a
    FROM public.raci_matrix rm
    WHERE rm.tenant_id = v_tenant_id
    GROUP BY rm.resource, rm.action
  )
  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (WHERE has_r AND has_a)::integer
  INTO v_raci_rules_defined, v_raci_covered
  FROM grouped;

  IF v_raci_rules_defined > 0 THEN
    v_raci_coverage_score := GREATEST(0, LEAST(100, ROUND((v_raci_covered::numeric / v_raci_rules_defined::numeric) * 100)::integer));
  ELSE
    v_raci_coverage_score := 0;
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE lower(COALESCE(ar.status, 'pending')) = 'pending')::integer
  INTO v_pending_approvals
  FROM public.approval_requests ar
  WHERE ar.tenant_id = v_tenant_id;

  SELECT
    COUNT(*) FILTER (WHERE lower(COALESCE(a.status, '')) IN ('active', 'ready'))::integer,
    COUNT(*)::integer
  INTO v_agents_active, v_agents_total
  FROM public.ai_agents a
  WHERE a.tenant_id = v_tenant_id;

  SELECT lower(COALESCE(s.status, ''))
  INTO v_subscription_status
  FROM public.subscriptions s
  WHERE s.tenant_id = v_tenant_id
  ORDER BY s.created_at DESC
  LIMIT 1;

  IF v_subscription_status IN ('active', 'trialing', 'trial') THEN
    v_billing_score := 100;
  ELSIF v_subscription_status IN ('past_due', 'unpaid', 'cancelled', 'canceled') THEN
    v_billing_score := 30;
  ELSIF v_subscription_status = '' THEN
    v_billing_score := 70;
  ELSE
    v_billing_score := 60;
  END IF;

  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (
      WHERE lower(COALESCE(al.status, '')) IN ('failed', 'error', 'blocked', 'denied')
         OR lower(COALESCE(al.risk_level, '')) = 'critical'
    )::integer
  INTO v_audit_total_7d, v_audit_flagged_7d
  FROM public.audit_logs al
  WHERE al.tenant_id = v_tenant_id
    AND al.created_at >= now() - interval '7 days';

  IF v_audit_total_7d > 0 THEN
    v_audit_score := GREATEST(
      0,
      LEAST(
        100,
        ROUND((1 - (v_audit_flagged_7d::numeric / v_audit_total_7d::numeric)) * 100)::integer
      )
    );
  END IF;

  v_health_score := ROUND((v_connection_score + v_raci_coverage_score + v_audit_score + v_billing_score) / 4.0)::integer;

  WITH raci_types AS (
    SELECT unnest(ARRAY['R', 'A', 'C', 'I']) AS raci_type
  ),
  raci_counts AS (
    SELECT
      upper(COALESCE(rm.raci_type, '')) AS raci_type,
      COUNT(*)::integer AS cnt
    FROM public.raci_matrix rm
    WHERE rm.tenant_id = v_tenant_id
    GROUP BY upper(COALESCE(rm.raci_type, ''))
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'type', t.raci_type,
        'count', COALESCE(c.cnt, 0)
      )
      ORDER BY t.raci_type
    ),
    '[]'::jsonb
  )
  INTO v_raci_distribution
  FROM raci_types t
  LEFT JOIN raci_counts c
    ON c.raci_type = t.raci_type;

  IF to_regclass('public.risk_matrix_rules') IS NOT NULL THEN
    EXECUTE $q$
      WITH critical_resources AS (
        SELECT DISTINCT lower(trim(r.resource)) AS resource
        FROM public.risk_matrix_rules r
        WHERE r.tenant_id = $1
          AND lower(COALESCE(r.override_risk_level, r.risk_level, '')) = 'critical'
      ),
      coverage AS (
        SELECT
          cr.resource,
          EXISTS (
            SELECT 1
            FROM public.raci_matrix rm
            WHERE rm.tenant_id = $1
              AND lower(trim(rm.resource)) = cr.resource
              AND upper(rm.raci_type) = 'R'
          ) AS has_r,
          EXISTS (
            SELECT 1
            FROM public.raci_matrix rm
            WHERE rm.tenant_id = $1
              AND lower(trim(rm.resource)) = cr.resource
              AND upper(rm.raci_type) = 'A'
          ) AS has_a
        FROM critical_resources cr
      )
      SELECT
        COUNT(*)::integer,
        COUNT(*) FILTER (WHERE has_r AND has_a)::integer
      FROM coverage
    $q$
    INTO v_critical_resources_total, v_critical_resources_covered
    USING v_tenant_id;
  ELSE
    WITH critical_resources AS (
      SELECT DISTINCT lower(trim(rm.resource)) AS resource
      FROM public.raci_matrix rm
      WHERE rm.tenant_id = v_tenant_id
        AND lower(trim(rm.action)) IN ('delete', 'drop', 'truncate')
    ),
    coverage AS (
      SELECT
        cr.resource,
        EXISTS (
          SELECT 1
          FROM public.raci_matrix rm
          WHERE rm.tenant_id = v_tenant_id
            AND lower(trim(rm.resource)) = cr.resource
            AND upper(rm.raci_type) = 'R'
        ) AS has_r,
        EXISTS (
          SELECT 1
          FROM public.raci_matrix rm
          WHERE rm.tenant_id = v_tenant_id
            AND lower(trim(rm.resource)) = cr.resource
            AND upper(rm.raci_type) = 'A'
        ) AS has_a
      FROM critical_resources cr
    )
    SELECT
      COUNT(*)::integer,
      COUNT(*) FILTER (WHERE has_r AND has_a)::integer
    INTO v_critical_resources_total, v_critical_resources_covered
    FROM coverage;
  END IF;

  WITH events AS (
    SELECT
      al.id,
      al.action,
      al.resource,
      al.details,
      al.created_at,
      COALESCE(NULLIF(pr.full_name, ''), 'Admin') AS actor_name
    FROM public.audit_logs al
    LEFT JOIN public.profiles pr
      ON pr.id = al.user_id
     AND pr.tenant_id = al.tenant_id
    WHERE al.tenant_id = v_tenant_id
      AND (
        lower(al.action) ~ '(raci|guardrail|connection|team|role|billing|admin|tenant)'
        OR lower(al.resource) ~ '(raci|guardrail|connection|team|billing|tenant)'
      )
    ORDER BY al.created_at DESC
    LIMIT 20
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', e.id,
        'message', CASE
          WHEN lower(e.action) LIKE '%raci%'
            THEN format('RACI rule updated by %s', e.actor_name)
          WHEN lower(e.action) ~ '(connection|api_connection|connector)'
            THEN format('New connection added: %s', COALESCE(NULLIF(e.details ->> 'connection_name', ''), NULLIF(e.resource, ''), 'Connection'))
          WHEN lower(e.action) ~ '(role|team|member)'
            THEN format('User role changed: %s', COALESCE(NULLIF(e.details ->> 'target_name', ''), NULLIF(e.details ->> 'user_name', ''), 'Team member'))
          WHEN lower(e.action) LIKE '%billing%'
            THEN format('Billing settings updated by %s', e.actor_name)
          ELSE format('%s by %s', initcap(replace(replace(e.action, '.', ' '), '_', ' ')), e.actor_name)
        END,
        'createdAt', e.created_at,
        'actorName', e.actor_name,
        'action', e.action,
        'resource', e.resource
      )
      ORDER BY e.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_recent_events
  FROM events e;

  RETURN jsonb_build_object(
    'profileRole', v_role,
    'isAdmin', true,
    'workspaceHealthScore', v_health_score,
    'healthBreakdown', jsonb_build_object(
      'connectionHealth', v_connection_score,
      'raciCoverage', v_raci_coverage_score,
      'auditLogClean', v_audit_score,
      'billingCurrent', v_billing_score
    ),
    'stats', jsonb_build_object(
      'connections', jsonb_build_object('total', v_connections_total, 'healthy', v_connections_healthy, 'errors', v_connections_errors),
      'teamMembers', jsonb_build_object('active', v_team_active, 'pending', v_team_pending),
      'raciRules', jsonb_build_object('defined', v_raci_rules_defined, 'coverageScore', v_raci_coverage_score),
      'pendingApprovals', v_pending_approvals,
      'agents', jsonb_build_object('active', v_agents_active, 'total', v_agents_total)
    ),
    'recentAdminEvents', v_recent_events,
    'riskOverview', jsonb_build_object(
      'raciDistribution', v_raci_distribution,
      'criticalResources', jsonb_build_object(
        'covered', v_critical_resources_covered,
        'uncovered', GREATEST(v_critical_resources_total - v_critical_resources_covered, 0),
        'total', v_critical_resources_total
      )
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_admin_console_overview() TO authenticated;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'api_connections',
    'raci_matrix',
    'ai_agents',
    'profiles',
    'team_invitations',
    'subscriptions',
    'approval_requests',
    'audit_logs'
  ]
  LOOP
    IF to_regclass(format('public.%s', v_table)) IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = v_table
      ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
    END IF;
  END LOOP;
END;
$$;
