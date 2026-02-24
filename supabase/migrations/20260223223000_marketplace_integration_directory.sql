-- Integration Marketplace directory backend for /dashboard/marketplace.

ALTER TABLE public.integration_catalog
  ADD COLUMN IF NOT EXISTS summary text,
  ADD COLUMN IF NOT EXISTS connection_type text NOT NULL DEFAULT 'rest_api'
    CHECK (connection_type IN ('rest_api', 'oauth', 'webhook', 'hybrid')),
  ADD COLUMN IF NOT EXISTS access_tier text NOT NULL DEFAULT 'free'
    CHECK (access_tier IN ('free', 'pro_plus', 'enterprise')),
  ADD COLUMN IF NOT EXISTS rating numeric(3,2) NOT NULL DEFAULT 4.50,
  ADD COLUMN IF NOT EXISTS reviews_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS installed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.tenant_integration_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES public.integration_catalog(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'installed' CHECK (status IN ('installed', 'uninstalled')),
  installed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  uninstalled_at timestamptz,
  last_synced_at timestamptz,
  active_queries_today integer NOT NULL DEFAULT 0,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, integration_id)
);

ALTER TABLE public.tenant_integration_installs ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS tenant_integration_installs_tenant_status_idx
  ON public.tenant_integration_installs (tenant_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS tenant_integration_installs_integration_status_idx
  ON public.tenant_integration_installs (integration_id, status);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'set_updated_at_timestamp'
      AND pg_function_is_visible(oid)
  ) THEN
    DROP TRIGGER IF EXISTS tenant_integration_installs_set_updated_at ON public.tenant_integration_installs;
    CREATE TRIGGER tenant_integration_installs_set_updated_at
    BEFORE UPDATE ON public.tenant_integration_installs
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_timestamp();
  END IF;
END;
$$;

DROP POLICY IF EXISTS "Tenant members can view integration installs" ON public.tenant_integration_installs;
CREATE POLICY "Tenant members can view integration installs"
  ON public.tenant_integration_installs FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage integration installs" ON public.tenant_integration_installs;
CREATE POLICY "Tenant members can manage integration installs"
  ON public.tenant_integration_installs FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

INSERT INTO public.integration_catalog (
  code,
  display_name,
  category,
  summary,
  connection_type,
  access_tier,
  rating,
  reviews_count,
  installed_count,
  featured,
  supported_auth,
  docs_url,
  config_schema,
  is_active
)
VALUES
  (
    'salesforce',
    'Salesforce',
    'CRM',
    'Sync Salesforce CRM data and query leads, opportunities, and accounts via AI.',
    'oauth',
    'pro_plus',
    4.80,
    42,
    1240,
    true,
    ARRAY['oauth2']::text[],
    'https://developer.salesforce.com/docs',
    '{"required":["instance_url"],"type":"object"}'::jsonb,
    true
  ),
  (
    'sap',
    'SAP',
    'ERP',
    'Connect SAP ERP systems for governed workflows, finance ops, and inventory insights.',
    'oauth',
    'enterprise',
    4.70,
    31,
    680,
    true,
    ARRAY['oauth2','api_key']::text[],
    'https://help.sap.com/',
    '{"required":["tenant"],"type":"object"}'::jsonb,
    true
  ),
  (
    'hubspot',
    'HubSpot',
    'CRM',
    'Bring HubSpot contacts, deals, and lifecycle metrics into AI chat and automations.',
    'oauth',
    'pro_plus',
    4.90,
    56,
    1420,
    true,
    ARRAY['oauth2']::text[],
    'https://developers.hubspot.com/docs',
    '{"required":["portal_id"],"type":"object"}'::jsonb,
    true
  ),
  (
    'zendesk',
    'Zendesk',
    'Ticketing',
    'Analyze support queues, SLA risk, and automate ticket triage with governed actions.',
    'oauth',
    'pro_plus',
    4.60,
    28,
    790,
    false,
    ARRAY['oauth2','api_key']::text[],
    'https://developer.zendesk.com/documentation/',
    '{"required":["subdomain"],"type":"object"}'::jsonb,
    true
  ),
  (
    'jira',
    'Jira',
    'Ticketing',
    'Sync Jira issues and epics to monitor delivery risk and trigger execution workflows.',
    'oauth',
    'free',
    4.50,
    35,
    1010,
    false,
    ARRAY['oauth2','api_token']::text[],
    'https://developer.atlassian.com/cloud/jira/platform/',
    '{"required":["cloud_id"],"type":"object"}'::jsonb,
    true
  ),
  (
    'slack',
    'Slack',
    'Communication',
    'Post alerts and summaries to Slack channels and read incident threads for context.',
    'oauth',
    'free',
    4.70,
    63,
    1880,
    false,
    ARRAY['oauth2']::text[],
    'https://api.slack.com/',
    '{"required":["workspace"],"type":"object"}'::jsonb,
    true
  ),
  (
    'google_analytics',
    'Google Analytics',
    'Analytics',
    'Surface traffic and conversion trends with predictive insight generation.',
    'oauth',
    'free',
    4.40,
    22,
    540,
    false,
    ARRAY['oauth2']::text[],
    'https://developers.google.com/analytics',
    '{"required":["property_id"],"type":"object"}'::jsonb,
    true
  ),
  (
    'quickbooks',
    'QuickBooks',
    'Finance',
    'Sync accounting ledgers, invoices, and payments for finance-grade assistant workflows.',
    'oauth',
    'pro_plus',
    4.60,
    19,
    470,
    false,
    ARRAY['oauth2']::text[],
    'https://developer.intuit.com/',
    '{"required":["realm_id"],"type":"object"}'::jsonb,
    true
  ),
  (
    'workday',
    'Workday',
    'HR',
    'Access workforce and organizational data for HR analytics with strict governance controls.',
    'rest_api',
    'enterprise',
    4.30,
    14,
    260,
    false,
    ARRAY['api_key','oauth2']::text[],
    'https://developer.workday.com/',
    '{"required":["tenant"],"type":"object"}'::jsonb,
    true
  ),
  (
    'shopify',
    'Shopify',
    'eCommerce',
    'Connect orders, customers, and fulfillment events for operations and demand insights.',
    'oauth',
    'free',
    4.70,
    44,
    1190,
    false,
    ARRAY['oauth2']::text[],
    'https://shopify.dev/docs',
    '{"required":["shop_domain"],"type":"object"}'::jsonb,
    true
  ),
  (
    'notion',
    'Notion',
    'Communication',
    'Ingest team knowledge and docs from Notion workspaces into semantic search.',
    'oauth',
    'free',
    4.50,
    39,
    970,
    false,
    ARRAY['oauth2','integration_token']::text[],
    'https://developers.notion.com/',
    '{"required":["database_id"],"type":"object"}'::jsonb,
    true
  ),
  (
    'stripe',
    'Stripe',
    'Finance',
    'Track subscription and payment events with anomaly detection and revenue intelligence.',
    'webhook',
    'pro_plus',
    4.80,
    51,
    1330,
    false,
    ARRAY['webhook_secret','api_key']::text[],
    'https://docs.stripe.com/api',
    '{"required":["account_id"],"type":"object"}'::jsonb,
    true
  )
ON CONFLICT (code)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  summary = EXCLUDED.summary,
  connection_type = EXCLUDED.connection_type,
  access_tier = EXCLUDED.access_tier,
  rating = EXCLUDED.rating,
  reviews_count = EXCLUDED.reviews_count,
  installed_count = EXCLUDED.installed_count,
  featured = EXCLUDED.featured,
  supported_auth = EXCLUDED.supported_auth,
  docs_url = EXCLUDED.docs_url,
  config_schema = EXCLUDED.config_schema,
  is_active = EXCLUDED.is_active,
  updated_at = now();

CREATE OR REPLACE FUNCTION public.get_integration_marketplace_payload(
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
  v_tenant_id uuid;
  v_search text := NULLIF(trim(COALESCE(p_search, '')), '');
  v_category text := lower(regexp_replace(trim(COALESCE(p_category, 'all')), '[^a-z0-9]+', '', 'g'));
  v_installed_only boolean := COALESCE(p_installed_only, false);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT public.get_user_tenant_id()
  INTO v_tenant_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant membership required';
  END IF;

  IF v_category = '' THEN
    v_category := 'all';
  END IF;

  IF v_category NOT IN ('all', 'crm', 'erp', 'ticketing', 'communication', 'analytics', 'finance', 'hr', 'ecommerce') THEN
    v_category := 'all';
  END IF;

  RETURN (
    WITH installs AS (
      SELECT
        ti.integration_id,
        ti.status,
        ti.installed_at,
        ti.last_synced_at,
        ti.active_queries_today
      FROM public.tenant_integration_installs ti
      WHERE ti.tenant_id = v_tenant_id
    ),
    global_installs AS (
      SELECT
        ti.integration_id,
        COUNT(*) FILTER (WHERE ti.status = 'installed')::integer AS teams_installed
      FROM public.tenant_integration_installs ti
      GROUP BY ti.integration_id
    ),
    searchable AS (
      SELECT
        c.id,
        c.code,
        c.display_name,
        c.category,
        lower(regexp_replace(c.category, '[^a-z0-9]+', '', 'g')) AS category_key,
        COALESCE(c.summary, 'Extend AEAR with secure enterprise integration workflows.') AS summary,
        c.connection_type,
        c.access_tier,
        c.rating,
        c.reviews_count,
        GREATEST(COALESCE(c.installed_count, 0), COALESCE(gi.teams_installed, 0))::integer AS teams_used,
        c.featured,
        c.supported_auth,
        c.docs_url,
        (i.integration_id IS NOT NULL AND i.status = 'installed') AS installed,
        i.installed_at,
        i.last_synced_at,
        COALESCE(i.active_queries_today, 0)::integer AS active_queries_today
      FROM public.integration_catalog c
      LEFT JOIN installs i
        ON i.integration_id = c.id
      LEFT JOIN global_installs gi
        ON gi.integration_id = c.id
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
        jsonb_build_object('key', 'all', 'label', 'All', 'count', cc.all_count),
        jsonb_build_object('key', 'crm', 'label', 'CRM', 'count', cc.crm_count),
        jsonb_build_object('key', 'erp', 'label', 'ERP', 'count', cc.erp_count),
        jsonb_build_object('key', 'ticketing', 'label', 'Ticketing', 'count', cc.ticketing_count),
        jsonb_build_object('key', 'communication', 'label', 'Communication', 'count', cc.communication_count),
        jsonb_build_object('key', 'analytics', 'label', 'Analytics', 'count', cc.analytics_count),
        jsonb_build_object('key', 'finance', 'label', 'Finance', 'count', cc.finance_count),
        jsonb_build_object('key', 'hr', 'label', 'HR', 'count', cc.hr_count),
        jsonb_build_object('key', 'ecommerce', 'label', 'eCommerce', 'count', cc.ecommerce_count)
      ),
      'featured', (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', f.id,
              'code', f.code,
              'name', f.display_name,
              'category', f.category,
              'description', f.summary,
              'connectionType', f.connection_type,
              'rating', f.rating,
              'reviews', f.reviews_count,
              'teamsUsed', f.teams_used,
              'accessTier', f.access_tier,
              'installed', f.installed,
              'logoText', upper(left(f.display_name, 1)),
              'lastSyncedAt', f.last_synced_at,
              'activeQueriesToday', f.active_queries_today,
              'docsUrl', f.docs_url
            )
            ORDER BY f.display_name
          ),
          '[]'::jsonb
        )
        FROM featured f
      ),
      'integrations', (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', r.id,
              'code', r.code,
              'name', r.display_name,
              'category', r.category,
              'description', r.summary,
              'connectionType', r.connection_type,
              'rating', r.rating,
              'reviews', r.reviews_count,
              'teamsUsed', r.teams_used,
              'accessTier', r.access_tier,
              'installed', r.installed,
              'logoText', upper(left(r.display_name, 1)),
              'lastSyncedAt', r.last_synced_at,
              'installedAt', r.installed_at,
              'activeQueriesToday', r.active_queries_today,
              'docsUrl', r.docs_url
            )
            ORDER BY r.featured DESC, r.display_name
          ),
          '[]'::jsonb
        )
        FROM filtered r
      )
    )
    FROM category_counts cc
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_integration_install_state(
  p_integration_code text,
  p_operation text DEFAULT 'install'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_operation text := lower(trim(COALESCE(p_operation, 'install')));
  v_code text := lower(trim(COALESCE(p_integration_code, '')));
  v_integration_id uuid;
  v_integration_name text;
  v_result_status text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT public.get_user_tenant_id()
  INTO v_tenant_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant membership required';
  END IF;

  IF v_code = '' THEN
    RAISE EXCEPTION 'Integration code is required';
  END IF;

  IF v_operation NOT IN ('install', 'configure', 'uninstall') THEN
    RAISE EXCEPTION 'Unsupported operation';
  END IF;

  SELECT c.id, c.display_name
  INTO v_integration_id, v_integration_name
  FROM public.integration_catalog c
  WHERE lower(c.code) = v_code
    AND c.is_active = true
  LIMIT 1;

  IF v_integration_id IS NULL THEN
    RAISE EXCEPTION 'Integration not found';
  END IF;

  IF v_operation IN ('install', 'configure') THEN
    INSERT INTO public.tenant_integration_installs (
      tenant_id,
      integration_id,
      status,
      installed_by,
      installed_at,
      uninstalled_at,
      last_synced_at,
      active_queries_today
    )
    VALUES (
      v_tenant_id,
      v_integration_id,
      'installed',
      auth.uid(),
      now(),
      NULL,
      CASE WHEN v_operation = 'configure' THEN now() ELSE NULL END,
      0
    )
    ON CONFLICT (tenant_id, integration_id)
    DO UPDATE SET
      status = 'installed',
      installed_by = auth.uid(),
      installed_at = COALESCE(public.tenant_integration_installs.installed_at, now()),
      uninstalled_at = NULL,
      last_synced_at = CASE
        WHEN v_operation = 'configure' THEN now()
        ELSE public.tenant_integration_installs.last_synced_at
      END,
      updated_at = now();

    v_result_status := 'installed';
  ELSE
    UPDATE public.tenant_integration_installs
    SET
      status = 'uninstalled',
      uninstalled_at = now(),
      updated_at = now()
    WHERE tenant_id = v_tenant_id
      AND integration_id = v_integration_id;

    v_result_status := 'uninstalled';
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'marketplace.' || v_operation,
    'integration',
    'success',
    jsonb_build_object(
      'integrationCode', v_code,
      'integrationName', v_integration_name,
      'resultStatus', v_result_status
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'operation', v_operation,
    'integrationCode', v_code,
    'integrationName', v_integration_name,
    'status', v_result_status
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_integration_marketplace_payload(text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_integration_install_state(text, text) TO authenticated;
