-- Platform Super Admin tenant list + quick view + management RPCs.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.is_platform_admin(p_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    EXISTS (
      SELECT 1
      FROM public.platform_admin_users pa
      WHERE pa.user_id = COALESCE(p_user_id, auth.uid())
    )
    OR lower(COALESCE(auth.jwt() -> 'user_metadata' ->> 'superadmin', 'false')) IN ('true', '1', 'yes')
    OR lower(COALESCE(auth.jwt() -> 'user_metadata' ->> 'super_admin', 'false')) IN ('true', '1', 'yes')
    OR lower(COALESCE(auth.jwt() -> 'app_metadata' ->> 'superadmin', 'false')) IN ('true', '1', 'yes')
    OR lower(COALESCE(auth.jwt() -> 'app_metadata' ->> 'super_admin', 'false')) IN ('true', '1', 'yes')
  );
$$;

CREATE OR REPLACE FUNCTION public.get_platform_super_admin_tenants(
  p_search text DEFAULT NULL,
  p_plan text DEFAULT 'all',
  p_status text DEFAULT 'all',
  p_created_from date DEFAULT NULL,
  p_created_to date DEFAULT NULL,
  p_sort_by text DEFAULT 'mrr',
  p_sort_dir text DEFAULT 'desc',
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_search text := NULLIF(trim(COALESCE(p_search, '')), '');
  v_plan text := lower(trim(COALESCE(p_plan, 'all')));
  v_status text := lower(trim(COALESCE(p_status, 'all')));
  v_sort_by text := lower(trim(COALESCE(p_sort_by, 'mrr')));
  v_sort_dir text := lower(trim(COALESCE(p_sort_dir, 'desc')));
  v_created_from date := p_created_from;
  v_created_to date := p_created_to;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
  v_offset integer := GREATEST(0, COALESCE(p_offset, 0));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Forbidden: platform admin access required';
  END IF;

  IF v_plan NOT IN ('all', 'starter', 'pro', 'business', 'enterprise') THEN
    v_plan := 'all';
  END IF;

  IF v_status NOT IN ('all', 'active', 'trial', 'suspended', 'cancelled') THEN
    v_status := 'all';
  END IF;

  IF v_sort_by NOT IN ('mrr', 'created', 'last_active', 'health_score') THEN
    v_sort_by := 'mrr';
  END IF;

  IF v_sort_dir NOT IN ('asc', 'desc') THEN
    v_sort_dir := 'desc';
  END IF;

  RETURN (
    WITH tenant_rollup AS (
      SELECT
        t.id,
        t.name,
        t.slug,
        lower(COALESCE(s.plan, t.plan, 'starter')) AS plan,
        lower(COALESCE(s.status, t.status, 'trial')) AS status,
        lower(COALESCE(s.billing_cycle, 'monthly')) AS billing_cycle,
        t.created_at,
        COALESCE(t.updated_at, t.created_at) AS updated_at,
        COALESCE(owner.owner_email, '') AS owner_email,
        COALESCE(owner.owner_name, t.name) AS owner_name,
        COALESCE(member_stats.users_count, 0)::integer AS users_count,
        COALESCE(member_stats.last_active_at, t.created_at) AS last_active_at,
        COALESCE(conn_stats.total_connections, 0)::integer AS connections_count,
        COALESCE(conn_stats.active_connections, 0)::integer AS active_connections,
        COALESCE(conn_stats.error_connections, 0)::integer AS error_connections,
        (
          COALESCE(usage_stats.tokens_from_events, 0)
          + COALESCE(run_stats.tokens_from_runs, 0)
        )::bigint AS tokens_used
      FROM public.tenants t
      LEFT JOIN public.subscriptions s
        ON s.tenant_id = t.id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (
            WHERE COALESCE(p.status, 'active') <> 'removed'
          )::integer AS users_count,
          MAX(COALESCE(p.last_active_at, p.updated_at, p.created_at)) AS last_active_at
        FROM public.profiles p
        WHERE p.tenant_id = t.id
      ) member_stats ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE COALESCE(c.is_archived, false) = false)::integer AS total_connections,
          COUNT(*) FILTER (
            WHERE COALESCE(c.is_archived, false) = false
              AND lower(COALESCE(c.status, 'pending')) IN ('active', 'success', 'ready')
          )::integer AS active_connections,
          COUNT(*) FILTER (
            WHERE COALESCE(c.is_archived, false) = false
              AND lower(COALESCE(c.status, 'pending')) IN ('error', 'failed')
          )::integer AS error_connections
        FROM public.api_connections c
        WHERE c.tenant_id = t.id
      ) conn_stats ON true
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(
            SUM(
              CASE
                WHEN lower(COALESCE(u.metric_type, '')) IN (
                  'tokens',
                  'llm_tokens',
                  'input_tokens',
                  'output_tokens'
                ) THEN u.quantity
                ELSE 0
              END
            ),
            0
          )::bigint AS tokens_from_events
        FROM public.usage_events u
        WHERE u.tenant_id = t.id
          AND u.recorded_at >= date_trunc('month', v_now)
      ) usage_stats ON true
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(COALESCE(r.input_tokens, 0) + COALESCE(r.output_tokens, 0)), 0)::bigint AS tokens_from_runs
        FROM public.agent_runs r
        WHERE r.tenant_id = t.id
          AND r.created_at >= date_trunc('month', v_now)
      ) run_stats ON true
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(au.email, '') AS owner_email,
          COALESCE(
            NULLIF(trim(p.full_name), ''),
            NULLIF(split_part(COALESCE(au.email, ''), '@', 1), ''),
            'Owner'
          ) AS owner_name
        FROM public.profiles p
        LEFT JOIN auth.users au
          ON au.id = p.id
        WHERE p.tenant_id = t.id
          AND COALESCE(p.status, 'active') <> 'removed'
        ORDER BY
          CASE WHEN lower(COALESCE(p.role, 'member')) IN ('owner', 'admin') THEN 0 ELSE 1 END,
          p.created_at ASC
        LIMIT 1
      ) owner ON true
    ),
    enriched AS (
      SELECT
        tr.*,
        (
          CASE tr.plan
            WHEN 'pro' THEN 299::numeric
            WHEN 'business' THEN 999::numeric
            WHEN 'enterprise' THEN 0::numeric
            ELSE 49::numeric
          END
          * CASE WHEN tr.billing_cycle = 'annual' THEN 0.8::numeric ELSE 1::numeric END
        )::numeric(12,2) AS mrr_usd,
        (
          (
            CASE tr.plan
              WHEN 'pro' THEN 299::numeric
              WHEN 'business' THEN 999::numeric
              WHEN 'enterprise' THEN 0::numeric
              ELSE 49::numeric
            END
            * CASE WHEN tr.billing_cycle = 'annual' THEN 0.8::numeric ELSE 1::numeric END
          ) * 12
        )::numeric(12,2) AS arr_usd,
        LEAST(
          100,
          GREATEST(
            0,
            (
              CASE
                WHEN tr.connections_count = 0 THEN 20
                ELSE ROUND((tr.active_connections::numeric / GREATEST(tr.connections_count, 1)) * 45)
              END
              + CASE WHEN tr.error_connections > 0 THEN 5 ELSE 20 END
              + CASE
                  WHEN tr.last_active_at >= v_now - interval '7 days' THEN 25
                  WHEN tr.last_active_at >= v_now - interval '30 days' THEN 15
                  ELSE 5
                END
              + CASE WHEN tr.status IN ('active', 'trial') THEN 10 ELSE 0 END
            )
          )
        )::integer AS health_score
      FROM tenant_rollup tr
    ),
    filtered AS (
      SELECT
        e.*,
        CASE
          WHEN e.health_score >= 75 THEN 'green'
          WHEN e.health_score >= 45 THEN 'amber'
          ELSE 'red'
        END AS health
      FROM enriched e
      WHERE (v_search IS NULL OR e.name ILIKE '%' || v_search || '%' OR e.owner_email ILIKE '%' || v_search || '%')
        AND (v_plan = 'all' OR e.plan = v_plan)
        AND (v_status = 'all' OR e.status = v_status)
        AND (v_created_from IS NULL OR e.created_at::date >= v_created_from)
        AND (v_created_to IS NULL OR e.created_at::date <= v_created_to)
    ),
    filtered_count AS (
      SELECT COUNT(*)::integer AS total
      FROM filtered
    ),
    ordered AS (
      SELECT
        f.*,
        ROW_NUMBER() OVER (
          ORDER BY
            CASE WHEN v_sort_by = 'mrr' AND v_sort_dir = 'asc' THEN f.mrr_usd END ASC NULLS LAST,
            CASE WHEN v_sort_by = 'mrr' AND v_sort_dir = 'desc' THEN f.mrr_usd END DESC NULLS LAST,
            CASE WHEN v_sort_by = 'created' AND v_sort_dir = 'asc' THEN f.created_at END ASC NULLS LAST,
            CASE WHEN v_sort_by = 'created' AND v_sort_dir = 'desc' THEN f.created_at END DESC NULLS LAST,
            CASE WHEN v_sort_by = 'last_active' AND v_sort_dir = 'asc' THEN f.last_active_at END ASC NULLS LAST,
            CASE WHEN v_sort_by = 'last_active' AND v_sort_dir = 'desc' THEN f.last_active_at END DESC NULLS LAST,
            CASE WHEN v_sort_by = 'health_score' AND v_sort_dir = 'asc' THEN f.health_score END ASC NULLS LAST,
            CASE WHEN v_sort_by = 'health_score' AND v_sort_dir = 'desc' THEN f.health_score END DESC NULLS LAST,
            f.created_at DESC,
            f.id ASC
        )::integer AS row_index
      FROM filtered f
    ),
    paged AS (
      SELECT *
      FROM ordered
      WHERE row_index > v_offset
        AND row_index <= (v_offset + v_limit)
      ORDER BY row_index
    ),
    global_stats AS (
      SELECT
        COUNT(*)::integer AS total_tenants,
        COUNT(*) FILTER (WHERE e.status = 'active')::integer AS active_tenants,
        COUNT(*) FILTER (WHERE e.status = 'trial')::integer AS trial_tenants,
        COUNT(*) FILTER (
          WHERE e.status = 'cancelled'
            AND e.updated_at >= (v_now - interval '30 days')
        )::integer AS churned_last_30d,
        COALESCE(SUM(e.mrr_usd), 0)::numeric(12,2) AS mrr_total,
        COALESCE(SUM(e.arr_usd), 0)::numeric(12,2) AS arr_total
      FROM enriched e
    )
    SELECT jsonb_build_object(
      'stats', jsonb_build_object(
        'totalTenants', gs.total_tenants,
        'active', gs.active_tenants,
        'trial', gs.trial_tenants,
        'churnedLast30d', gs.churned_last_30d,
        'mrr', gs.mrr_total,
        'arr', gs.arr_total
      ),
      'filters', jsonb_build_object(
        'search', COALESCE(v_search, ''),
        'plan', v_plan,
        'status', v_status,
        'createdFrom', v_created_from,
        'createdTo', v_created_to,
        'sortBy', v_sort_by,
        'sortDir', v_sort_dir
      ),
      'pagination', jsonb_build_object(
        'limit', v_limit,
        'offset', v_offset,
        'total', fc.total
      ),
      'tenants', COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', p.id,
              'company', p.name,
              'slug', p.slug,
              'ownerEmail', p.owner_email,
              'ownerName', p.owner_name,
              'plan', p.plan,
              'status', p.status,
              'users', p.users_count,
              'connections', p.connections_count,
              'mrr', p.mrr_usd,
              'arr', p.arr_usd,
              'tokensUsed', p.tokens_used,
              'createdAt', p.created_at,
              'updatedAt', p.updated_at,
              'lastActiveAt', p.last_active_at,
              'healthScore', p.health_score,
              'health', p.health
            )
            ORDER BY p.row_index
          )
          FROM paged p
        ),
        '[]'::jsonb
      )
    )
    FROM global_stats gs
    CROSS JOIN filtered_count fc
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_platform_super_admin_tenant_quick_view(
  p_tenant_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_tenant record;
  v_connections jsonb := '[]'::jsonb;
  v_recent_events jsonb := '[]'::jsonb;
  v_latest_invoice jsonb := NULL;
  v_tokens_this_month bigint := 0;
  v_api_calls_this_month bigint := 0;
  v_actions_this_month bigint := 0;
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

  SELECT
    t.id,
    t.name,
    t.slug,
    lower(COALESCE(s.plan, t.plan, 'starter')) AS plan,
    lower(COALESCE(s.status, t.status, 'trial')) AS status,
    lower(COALESCE(s.billing_cycle, 'monthly')) AS billing_cycle,
    COALESCE(s.current_period_end, date_trunc('month', v_now) + interval '1 month') AS current_period_end,
    t.created_at,
    COALESCE(t.updated_at, t.created_at) AS updated_at,
    (
      CASE lower(COALESCE(s.plan, t.plan, 'starter'))
        WHEN 'pro' THEN 299::numeric
        WHEN 'business' THEN 999::numeric
        WHEN 'enterprise' THEN 0::numeric
        ELSE 49::numeric
      END
      * CASE WHEN lower(COALESCE(s.billing_cycle, 'monthly')) = 'annual' THEN 0.8::numeric ELSE 1::numeric END
    )::numeric(12,2) AS mrr,
    COALESCE(member_stats.active_members, 0)::integer AS active_members,
    COALESCE(member_stats.suspended_members, 0)::integer AS suspended_members,
    COALESCE(member_stats.last_active_at, t.created_at) AS last_active_at,
    COALESCE(conn_stats.total_connections, 0)::integer AS total_connections,
    COALESCE(conn_stats.active_connections, 0)::integer AS active_connections,
    COALESCE(conn_stats.syncing_connections, 0)::integer AS syncing_connections,
    COALESCE(conn_stats.error_connections, 0)::integer AS error_connections
  INTO v_tenant
  FROM public.tenants t
  LEFT JOIN public.subscriptions s
    ON s.tenant_id = t.id
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE COALESCE(p.status, 'active') = 'active')::integer AS active_members,
      COUNT(*) FILTER (WHERE COALESCE(p.status, 'active') = 'suspended')::integer AS suspended_members,
      MAX(COALESCE(p.last_active_at, p.updated_at, p.created_at)) AS last_active_at
    FROM public.profiles p
    WHERE p.tenant_id = t.id
      AND COALESCE(p.status, 'active') <> 'removed'
  ) member_stats ON true
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE COALESCE(c.is_archived, false) = false)::integer AS total_connections,
      COUNT(*) FILTER (
        WHERE COALESCE(c.is_archived, false) = false
          AND lower(COALESCE(c.status, 'pending')) IN ('active', 'ready', 'success')
      )::integer AS active_connections,
      COUNT(*) FILTER (
        WHERE COALESCE(c.is_archived, false) = false
          AND lower(COALESCE(c.status, 'pending')) IN ('syncing', 'running')
      )::integer AS syncing_connections,
      COUNT(*) FILTER (
        WHERE COALESCE(c.is_archived, false) = false
          AND lower(COALESCE(c.status, 'pending')) IN ('error', 'failed')
      )::integer AS error_connections
    FROM public.api_connections c
    WHERE c.tenant_id = t.id
  ) conn_stats ON true
  WHERE t.id = p_tenant_id
  LIMIT 1;

  IF v_tenant.id IS NULL THEN
    RAISE EXCEPTION 'Tenant not found';
  END IF;

  SELECT COALESCE(
    SUM(
      CASE
        WHEN lower(COALESCE(u.metric_type, '')) IN ('tokens', 'llm_tokens', 'input_tokens', 'output_tokens')
          THEN u.quantity
        ELSE 0
      END
    ),
    0
  )::bigint
  INTO v_tokens_this_month
  FROM public.usage_events u
  WHERE u.tenant_id = p_tenant_id
    AND u.recorded_at >= date_trunc('month', v_now);

  SELECT COALESCE(
    SUM(
      CASE
        WHEN lower(COALESCE(u.metric_type, '')) IN ('api_calls', 'requests') THEN u.quantity
        ELSE 0
      END
    ),
    0
  )::bigint
  INTO v_api_calls_this_month
  FROM public.usage_events u
  WHERE u.tenant_id = p_tenant_id
    AND u.recorded_at >= date_trunc('month', v_now);

  SELECT COALESCE(COUNT(*), 0)::bigint
  INTO v_actions_this_month
  FROM public.agent_action_runs aar
  WHERE aar.tenant_id = p_tenant_id
    AND aar.created_at >= date_trunc('month', v_now);

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'type', c.type,
        'status', c.status,
        'schemaDetected', c.schema_detected,
        'lastSyncedAt', c.last_synced_at,
        'updatedAt', c.updated_at
      )
      ORDER BY COALESCE(c.updated_at, c.created_at) DESC
    ),
    '[]'::jsonb
  )
  INTO v_connections
  FROM (
    SELECT c.*
    FROM public.api_connections c
    WHERE c.tenant_id = p_tenant_id
      AND COALESCE(c.is_archived, false) = false
    ORDER BY COALESCE(c.updated_at, c.created_at) DESC
    LIMIT 20
  ) c;

  SELECT jsonb_build_object(
    'id', i.id,
    'status', i.invoice_status,
    'totalCents', i.total_cents,
    'amountDueCents', i.amount_due_cents,
    'dueAt', i.due_at,
    'paidAt', i.paid_at,
    'hostedInvoiceUrl', i.hosted_invoice_url
  )
  INTO v_latest_invoice
  FROM public.invoice_snapshots i
  WHERE i.tenant_id = p_tenant_id
  ORDER BY COALESCE(i.period_end, i.created_at) DESC, i.created_at DESC
  LIMIT 1;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', x.id,
        'action', x.action,
        'resource', x.resource,
        'status', x.status,
        'riskLevel', x.risk_level,
        'createdAt', x.created_at,
        'actorName', x.actor_name
      )
      ORDER BY x.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_recent_events
  FROM (
    SELECT
      al.id,
      al.action,
      al.resource,
      al.status,
      al.risk_level,
      al.created_at,
      COALESCE(
        NULLIF(trim(p.full_name), ''),
        NULLIF(split_part(COALESCE(au.email, ''), '@', 1), ''),
        'System'
      ) AS actor_name
    FROM public.audit_logs al
    LEFT JOIN public.profiles p
      ON p.id = al.user_id
    LEFT JOIN auth.users au
      ON au.id = al.user_id
    WHERE al.tenant_id = p_tenant_id
    ORDER BY al.created_at DESC
    LIMIT 10
  ) x;

  RETURN jsonb_build_object(
    'tenant', jsonb_build_object(
      'id', v_tenant.id,
      'name', v_tenant.name,
      'slug', v_tenant.slug,
      'plan', v_tenant.plan,
      'status', v_tenant.status,
      'billingCycle', v_tenant.billing_cycle,
      'mrr', v_tenant.mrr,
      'createdAt', v_tenant.created_at,
      'updatedAt', v_tenant.updated_at,
      'lastActiveAt', v_tenant.last_active_at,
      'currentPeriodEnd', v_tenant.current_period_end
    ),
    'stats', jsonb_build_object(
      'users', jsonb_build_object(
        'active', v_tenant.active_members,
        'suspended', v_tenant.suspended_members,
        'total', v_tenant.active_members + v_tenant.suspended_members
      ),
      'connections', jsonb_build_object(
        'total', v_tenant.total_connections,
        'active', v_tenant.active_connections,
        'syncing', v_tenant.syncing_connections,
        'error', v_tenant.error_connections
      ),
      'usage', jsonb_build_object(
        'tokensThisMonth', v_tokens_this_month,
        'apiCallsThisMonth', v_api_calls_this_month,
        'actionsThisMonth', v_actions_this_month
      )
    ),
    'billingStatus', jsonb_build_object(
      'plan', v_tenant.plan,
      'status', v_tenant.status,
      'mrr', v_tenant.mrr,
      'latestInvoice', v_latest_invoice
    ),
    'connections', v_connections,
    'recentAuditEvents', v_recent_events,
    'links', jsonb_build_object(
      'fullTenantDashboard', '/dashboard/admin?tenant_id=' || v_tenant.id::text
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_admin_manage_tenant(
  p_tenant_id uuid,
  p_action text,
  p_value text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action text := lower(trim(COALESCE(p_action, '')));
  v_value text := lower(trim(COALESCE(p_value, '')));
  v_current_plan text;
  v_current_status text;
  v_next_plan text;
  v_next_status text;
  v_next_subscription_status text;
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

  IF v_action NOT IN ('suspend', 'activate', 'cancel', 'change_plan') THEN
    RAISE EXCEPTION 'Unsupported action %', v_action;
  END IF;

  SELECT
    lower(COALESCE(s.plan, t.plan, 'starter')),
    lower(COALESCE(s.status, t.status, 'trial'))
  INTO v_current_plan, v_current_status
  FROM public.tenants t
  LEFT JOIN public.subscriptions s
    ON s.tenant_id = t.id
  WHERE t.id = p_tenant_id
  LIMIT 1;

  IF v_current_plan IS NULL THEN
    RAISE EXCEPTION 'Tenant not found';
  END IF;

  v_next_plan := v_current_plan;
  v_next_status := v_current_status;
  v_next_subscription_status := v_current_status;

  IF v_action = 'suspend' THEN
    v_next_status := 'suspended';
    v_next_subscription_status := 'paused';
  ELSIF v_action = 'activate' THEN
    v_next_status := 'active';
    v_next_subscription_status := 'active';
  ELSIF v_action = 'cancel' THEN
    v_next_status := 'cancelled';
    v_next_subscription_status := 'cancelled';
  ELSIF v_action = 'change_plan' THEN
    IF v_value NOT IN ('starter', 'pro', 'business', 'enterprise') THEN
      RAISE EXCEPTION 'Invalid plan %', v_value;
    END IF;
    v_next_plan := v_value;
    v_next_subscription_status := v_current_status;
  END IF;

  UPDATE public.tenants t
  SET
    plan = v_next_plan,
    status = v_next_status,
    updated_at = now()
  WHERE t.id = p_tenant_id;

  INSERT INTO public.subscriptions (
    tenant_id,
    plan,
    status,
    billing_cycle,
    current_period_start,
    current_period_end
  )
  VALUES (
    p_tenant_id,
    v_next_plan,
    COALESCE(v_next_subscription_status, 'active'),
    'monthly',
    date_trunc('month', now()),
    date_trunc('month', now()) + interval '1 month'
  )
  ON CONFLICT (tenant_id)
  DO UPDATE SET
    plan = EXCLUDED.plan,
    status = COALESCE(v_next_subscription_status, public.subscriptions.status);

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    p_tenant_id,
    auth.uid(),
    'platform_admin.' || v_action,
    'tenant',
    'success',
    jsonb_build_object(
      'fromPlan', v_current_plan,
      'toPlan', v_next_plan,
      'fromStatus', v_current_status,
      'toStatus', v_next_status
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'tenantId', p_tenant_id,
    'action', v_action,
    'plan', v_next_plan,
    'status', v_next_status
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_admin_start_impersonation(
  p_tenant_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token text := encode(gen_random_bytes(16), 'hex');
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

  SELECT t.name INTO v_tenant_name
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
    'platform_admin.impersonation_requested',
    'tenant',
    'success',
    jsonb_build_object(
      'tokenPreview', left(v_token, 8),
      'warning', 'service_role_exchange_required'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'tenantId', p_tenant_id,
    'tenantName', v_tenant_name,
    'tokenPreview', left(v_token, 8) || '...',
    'expiresAt', now() + interval '10 minutes',
    'redirectUrl', '/dashboard?impersonate_tenant=' || p_tenant_id::text,
    'warning', 'Secure impersonation requires a server-side service-role exchange flow.'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_platform_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_platform_super_admin_tenants(text, text, text, date, date, text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_platform_super_admin_tenant_quick_view(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_admin_manage_tenant(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_admin_start_impersonation(uuid) TO authenticated;
