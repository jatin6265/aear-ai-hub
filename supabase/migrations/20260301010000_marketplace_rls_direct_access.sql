-- Marketplace direct-access RPCs and RLS fixes.
-- The marketplace-directory edge function fails auth for some deployments.
-- These RPCs allow the frontend to call Supabase directly as a fallback.

-- 1. Ensure integration_catalog has RLS enabled and a SELECT policy for authenticated users.
ALTER TABLE public.integration_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read integration catalog" ON public.integration_catalog;
CREATE POLICY "Authenticated users can read integration catalog"
  ON public.integration_catalog FOR SELECT TO authenticated
  USING (true);

-- 2. get_marketplace_payload_direct: mirrors get_integration_marketplace_payload but
--    accepts an explicit tenant_id so it can be called with SECURITY DEFINER safely.
CREATE OR REPLACE FUNCTION public.get_marketplace_payload_direct(
  p_tenant_id uuid,
  p_search text DEFAULT NULL,
  p_category text DEFAULT 'all',
  p_installed_only boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_tenant_id uuid;
  v_search text := NULLIF(trim(COALESCE(p_search, '')), '');
  v_category text := lower(regexp_replace(trim(COALESCE(p_category, 'all')), '[^a-z0-9]+', '', 'g'));
  v_installed_only boolean := COALESCE(p_installed_only, false);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- Verify caller belongs to the requested tenant
  SELECT public.get_user_tenant_id() INTO v_caller_tenant_id;
  IF v_caller_tenant_id IS NULL OR v_caller_tenant_id <> p_tenant_id THEN
    RAISE EXCEPTION 'Tenant access denied';
  END IF;

  IF v_category = '' THEN v_category := 'all'; END IF;
  IF v_category NOT IN ('all','crm','erp','ticketing','communication','analytics','finance','hr','ecommerce','documents','databases') THEN
    v_category := 'all';
  END IF;

  RETURN (
    WITH installs AS (
      SELECT ti.integration_id, ti.status, ti.installed_at, ti.last_synced_at, ti.active_queries_today
      FROM public.tenant_integration_installs ti
      WHERE ti.tenant_id = p_tenant_id
    ),
    global_installs AS (
      SELECT ti.integration_id,
             COUNT(*) FILTER (WHERE ti.status = 'installed')::integer AS teams_installed
      FROM public.tenant_integration_installs ti
      GROUP BY ti.integration_id
    ),
    searchable AS (
      SELECT
        c.id, c.code, c.display_name, c.category,
        lower(regexp_replace(c.category, '[^a-z0-9]+', '', 'g')) AS category_key,
        COALESCE(c.summary, 'Extend OpsAI with secure enterprise integration workflows.') AS summary,
        c.connection_type, c.access_tier, c.rating, c.reviews_count,
        GREATEST(COALESCE(c.installed_count, 0), COALESCE(gi.teams_installed, 0))::integer AS teams_used,
        c.featured, c.docs_url,
        (i.integration_id IS NOT NULL AND i.status = 'installed') AS installed,
        i.installed_at, i.last_synced_at,
        COALESCE(i.active_queries_today, 0)::integer AS active_queries_today
      FROM public.integration_catalog c
      LEFT JOIN installs i ON i.integration_id = c.id
      LEFT JOIN global_installs gi ON gi.integration_id = c.id
      WHERE c.is_active = true
        AND (
          v_search IS NULL
          OR c.display_name ILIKE '%' || v_search || '%'
          OR c.category ILIKE '%' || v_search || '%'
          OR COALESCE(c.summary, '') ILIKE '%' || v_search || '%'
          OR c.code ILIKE '%' || v_search || '%'
        )
    ),
    filtered AS (
      SELECT s.*
      FROM searchable s
      WHERE (v_category = 'all' OR s.category_key = v_category)
        AND (NOT v_installed_only OR s.installed)
      ORDER BY s.featured DESC, s.display_name ASC
    ),
    featured AS (
      SELECT s.*
      FROM searchable s
      WHERE s.featured
      ORDER BY s.display_name
      LIMIT 3
    ),
    category_counts AS (
      SELECT
        COUNT(*)::integer AS all_count,
        COUNT(*) FILTER (WHERE category_key = 'crm')::integer AS crm_count,
        COUNT(*) FILTER (WHERE category_key = 'erp')::integer AS erp_count,
        COUNT(*) FILTER (WHERE category_key = 'ticketing')::integer AS ticketing_count,
        COUNT(*) FILTER (WHERE category_key = 'communication')::integer AS communication_count,
        COUNT(*) FILTER (WHERE category_key = 'analytics')::integer AS analytics_count,
        COUNT(*) FILTER (WHERE category_key = 'finance')::integer AS finance_count,
        COUNT(*) FILTER (WHERE category_key = 'hr')::integer AS hr_count,
        COUNT(*) FILTER (WHERE category_key = 'ecommerce')::integer AS ecommerce_count
      FROM searchable
    )
    SELECT jsonb_build_object(
      'summary', jsonb_build_object(
        'total', (SELECT COUNT(*)::integer FROM searchable),
        'installed', (SELECT COUNT(*)::integer FROM searchable WHERE installed),
        'featured', (SELECT COUNT(*)::integer FROM featured)
      ),
      'categories', jsonb_build_array(
        jsonb_build_object('key', 'all',           'label', 'All',           'count', cc.all_count),
        jsonb_build_object('key', 'crm',           'label', 'CRM',           'count', cc.crm_count),
        jsonb_build_object('key', 'erp',           'label', 'ERP',           'count', cc.erp_count),
        jsonb_build_object('key', 'ticketing',     'label', 'Ticketing',     'count', cc.ticketing_count),
        jsonb_build_object('key', 'communication', 'label', 'Communication', 'count', cc.communication_count),
        jsonb_build_object('key', 'analytics',     'label', 'Analytics',     'count', cc.analytics_count),
        jsonb_build_object('key', 'finance',       'label', 'Finance',       'count', cc.finance_count),
        jsonb_build_object('key', 'hr',            'label', 'HR',            'count', cc.hr_count),
        jsonb_build_object('key', 'ecommerce',     'label', 'eCommerce',     'count', cc.ecommerce_count)
      ),
      'featured', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', f.id, 'code', f.code, 'name', f.display_name, 'category', f.category,
          'description', f.summary, 'connectionType', f.connection_type, 'rating', f.rating,
          'reviews', f.reviews_count, 'teamsUsed', f.teams_used, 'accessTier', f.access_tier,
          'installed', f.installed, 'logoText', upper(left(f.display_name, 1)),
          'lastSyncedAt', f.last_synced_at, 'activeQueriesToday', f.active_queries_today,
          'docsUrl', f.docs_url
        ) ORDER BY f.display_name), '[]'::jsonb)
        FROM featured f
      ),
      'integrations', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', r.id, 'code', r.code, 'name', r.display_name, 'category', r.category,
          'description', r.summary, 'connectionType', r.connection_type, 'rating', r.rating,
          'reviews', r.reviews_count, 'teamsUsed', r.teams_used, 'accessTier', r.access_tier,
          'installed', r.installed, 'logoText', upper(left(r.display_name, 1)),
          'lastSyncedAt', r.last_synced_at, 'installedAt', r.installed_at,
          'activeQueriesToday', r.active_queries_today, 'docsUrl', r.docs_url
        ) ORDER BY r.featured DESC, r.display_name), '[]'::jsonb)
        FROM filtered r
      )
    )
    FROM category_counts cc
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_marketplace_payload_direct(uuid, text, text, boolean) TO authenticated;

-- 3. install_integration_direct: upsert a tenant install record.
CREATE OR REPLACE FUNCTION public.install_integration_direct(
  p_tenant_id uuid,
  p_catalog_id uuid,
  p_config jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_tenant_id uuid;
  v_integration_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT public.get_user_tenant_id() INTO v_caller_tenant_id;
  IF v_caller_tenant_id IS NULL OR v_caller_tenant_id <> p_tenant_id THEN
    RAISE EXCEPTION 'Tenant access denied';
  END IF;

  SELECT display_name INTO v_integration_name
  FROM public.integration_catalog
  WHERE id = p_catalog_id AND is_active = true;

  IF v_integration_name IS NULL THEN
    RAISE EXCEPTION 'Integration not found';
  END IF;

  INSERT INTO public.tenant_integration_installs (
    tenant_id, integration_id, status, installed_by, installed_at, config
  )
  VALUES (
    p_tenant_id, p_catalog_id, 'installed', auth.uid(), now(), COALESCE(p_config, '{}'::jsonb)
  )
  ON CONFLICT (tenant_id, integration_id)
  DO UPDATE SET
    status = 'installed',
    installed_by = auth.uid(),
    installed_at = COALESCE(public.tenant_integration_installs.installed_at, now()),
    uninstalled_at = NULL,
    config = COALESCE(p_config, public.tenant_integration_installs.config),
    updated_at = now();

  RETURN jsonb_build_object('ok', true, 'integrationName', v_integration_name, 'status', 'installed');
END;
$$;

GRANT EXECUTE ON FUNCTION public.install_integration_direct(uuid, uuid, jsonb) TO authenticated;

-- 4. uninstall_integration_direct: mark install record as uninstalled.
CREATE OR REPLACE FUNCTION public.uninstall_integration_direct(
  p_tenant_id uuid,
  p_catalog_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_tenant_id uuid;
  v_integration_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT public.get_user_tenant_id() INTO v_caller_tenant_id;
  IF v_caller_tenant_id IS NULL OR v_caller_tenant_id <> p_tenant_id THEN
    RAISE EXCEPTION 'Tenant access denied';
  END IF;

  SELECT display_name INTO v_integration_name
  FROM public.integration_catalog
  WHERE id = p_catalog_id AND is_active = true;

  IF v_integration_name IS NULL THEN
    RAISE EXCEPTION 'Integration not found';
  END IF;

  UPDATE public.tenant_integration_installs
  SET status = 'uninstalled', uninstalled_at = now(), updated_at = now()
  WHERE tenant_id = p_tenant_id AND integration_id = p_catalog_id;

  RETURN jsonb_build_object('ok', true, 'integrationName', v_integration_name, 'status', 'uninstalled');
END;
$$;

GRANT EXECUTE ON FUNCTION public.uninstall_integration_direct(uuid, uuid) TO authenticated;
