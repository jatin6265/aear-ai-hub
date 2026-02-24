-- Public pricing catalog backend for /pricing.

CREATE TABLE IF NOT EXISTS public.pricing_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  badge text,
  badge_tone text NOT NULL DEFAULT 'neutral',
  cta_label text NOT NULL,
  cta_variant text NOT NULL DEFAULT 'primary',
  highlighted boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  monthly_price_cents integer,
  annual_price_cents integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_plans_code_check CHECK (code IN ('starter', 'pro', 'business', 'enterprise')),
  CONSTRAINT pricing_plans_badge_tone_check CHECK (badge_tone IN ('neutral', 'popular', 'highlight')),
  CONSTRAINT pricing_plans_cta_variant_check CHECK (cta_variant IN ('primary', 'outline'))
);

CREATE TABLE IF NOT EXISTS public.pricing_plan_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_code text NOT NULL REFERENCES public.pricing_plans(code) ON DELETE CASCADE,
  feature_text text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_code, sort_order)
);

CREATE TABLE IF NOT EXISTS public.pricing_comparison_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_key text NOT NULL UNIQUE,
  category text NOT NULL,
  feature_name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  starter_value text NOT NULL,
  pro_value text NOT NULL,
  business_value text NOT NULL,
  enterprise_value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pricing_faq_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question text NOT NULL,
  answer text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sort_order)
);

ALTER TABLE public.pricing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_plan_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_comparison_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_faq_items ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF to_regproc('public.set_updated_at_timestamp') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS pricing_plans_set_updated_at ON public.pricing_plans;
    CREATE TRIGGER pricing_plans_set_updated_at
      BEFORE UPDATE ON public.pricing_plans
      FOR EACH ROW
      EXECUTE FUNCTION public.set_updated_at_timestamp();
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'pricing_plans'
      AND policyname = 'Public can read pricing plans'
  ) THEN
    CREATE POLICY "Public can read pricing plans"
      ON public.pricing_plans
      FOR SELECT
      TO anon, authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'pricing_plan_features'
      AND policyname = 'Public can read pricing plan features'
  ) THEN
    CREATE POLICY "Public can read pricing plan features"
      ON public.pricing_plan_features
      FOR SELECT
      TO anon, authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'pricing_comparison_rows'
      AND policyname = 'Public can read pricing comparison rows'
  ) THEN
    CREATE POLICY "Public can read pricing comparison rows"
      ON public.pricing_comparison_rows
      FOR SELECT
      TO anon, authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'pricing_faq_items'
      AND policyname = 'Public can read pricing FAQ items'
  ) THEN
    CREATE POLICY "Public can read pricing FAQ items"
      ON public.pricing_faq_items
      FOR SELECT
      TO anon, authenticated
      USING (true);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_public_pricing_catalog()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.pricing_plans (
    code,
    name,
    description,
    badge,
    badge_tone,
    cta_label,
    cta_variant,
    highlighted,
    sort_order,
    monthly_price_cents,
    annual_price_cents
  )
  VALUES
    ('starter', 'Starter', 'Most Popular for Small Teams', 'Most Popular for Small Teams', 'popular', 'Start Free Trial', 'primary', false, 10, 4900, 3920),
    ('pro', 'Pro', 'Best Value', 'Best Value', 'highlight', 'Start Free Trial', 'primary', true, 20, 29900, 23920),
    ('business', 'Business', 'For scaling teams with advanced governance.', NULL, 'neutral', 'Start Free Trial', 'primary', false, 30, 99900, 79920),
    ('enterprise', 'Enterprise', 'Dedicated infrastructure and advanced compliance.', NULL, 'neutral', 'Contact Sales', 'outline', false, 40, NULL, NULL)
  ON CONFLICT (code)
  DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    badge = EXCLUDED.badge,
    badge_tone = EXCLUDED.badge_tone,
    cta_label = EXCLUDED.cta_label,
    cta_variant = EXCLUDED.cta_variant,
    highlighted = EXCLUDED.highlighted,
    sort_order = EXCLUDED.sort_order,
    monthly_price_cents = EXCLUDED.monthly_price_cents,
    annual_price_cents = EXCLUDED.annual_price_cents,
    updated_at = now();

  DELETE FROM public.pricing_plan_features;

  INSERT INTO public.pricing_plan_features (plan_code, feature_text, sort_order)
  VALUES
    ('starter', 'Up to 5 users', 10),
    ('starter', '1 data connection', 20),
    ('starter', '500K tokens/month', 30),
    ('starter', '1 GB vector storage', 40),
    ('starter', 'Basic RAG (read-only)', 50),
    ('starter', 'Email support', 60),
    ('starter', 'Action execution', 70),
    ('starter', 'RACI governance', 80),
    ('starter', 'Predictive AI', 90),

    ('pro', 'Everything in Starter', 10),
    ('pro', 'Up to 25 users', 20),
    ('pro', '5 data connections', 30),
    ('pro', '5M tokens/month', 40),
    ('pro', 'Action execution engine', 50),
    ('pro', 'RACI governance', 60),
    ('pro', 'Approval workflows', 70),
    ('pro', 'Priority support', 80),
    ('pro', 'Predictive AI', 90),

    ('business', 'Everything in Pro', 10),
    ('business', 'Up to 100 users', 20),
    ('business', 'Unlimited connections', 30),
    ('business', '25M tokens/month', 40),
    ('business', 'Predictive AI engine', 50),
    ('business', 'Custom agents', 60),
    ('business', 'SLA guarantee', 70),
    ('business', 'Slack support', 80),

    ('enterprise', 'Everything in Business', 10),
    ('enterprise', 'Dedicated infrastructure', 20),
    ('enterprise', 'SSO & advanced IAM', 30),
    ('enterprise', 'Custom model policies', 40),
    ('enterprise', 'Dedicated CSM', 50),
    ('enterprise', 'Private networking options', 60)
  ON CONFLICT (plan_code, sort_order)
  DO UPDATE SET
    feature_text = EXCLUDED.feature_text;

  DELETE FROM public.pricing_comparison_rows;

  INSERT INTO public.pricing_comparison_rows (
    feature_key,
    category,
    feature_name,
    sort_order,
    starter_value,
    pro_value,
    business_value,
    enterprise_value
  )
  VALUES
    ('users_limit', 'Limits', 'Users included', 10, 'Up to 5', 'Up to 25', 'Up to 100', 'Unlimited'),
    ('connections_limit', 'Limits', 'Data connections', 20, '1', '5', 'Unlimited', 'Unlimited'),
    ('tokens_monthly', 'Limits', 'Tokens per month', 30, '500K', '5M', '25M', 'Custom'),
    ('vector_storage', 'Limits', 'Vector storage', 40, '1 GB', '10 GB', '50 GB', 'Custom'),
    ('agents_limit', 'Limits', 'Auto agents', 50, '3', '10', '25', 'Custom'),
    ('workspaces', 'Limits', 'Workspaces', 60, '1', '1', '3', 'Custom'),

    ('api_connectors_rest', 'Connectors', 'REST API connectors', 70, 'Yes', 'Yes', 'Yes', 'Yes'),
    ('api_connectors_sql', 'Connectors', 'SQL database connectors', 80, 'Yes', 'Yes', 'Yes', 'Yes'),
    ('api_connectors_mongo', 'Connectors', 'MongoDB connectors', 90, 'No', 'Yes', 'Yes', 'Yes'),
    ('api_connectors_sheets', 'Connectors', 'Google Sheets connectors', 100, 'No', 'Yes', 'Yes', 'Yes'),
    ('api_connectors_notion', 'Connectors', 'Notion connectors', 110, 'No', 'Yes', 'Yes', 'Yes'),
    ('custom_connectors', 'Connectors', 'Custom connector adapters', 120, 'No', 'No', 'Limited', 'Yes'),

    ('rag_read_only', 'RAG', 'Basic RAG (read-only)', 130, 'Yes', 'Yes', 'Yes', 'Yes'),
    ('rag_hybrid', 'RAG', 'Hybrid semantic + lexical retrieval', 140, 'No', 'Yes', 'Yes', 'Yes'),
    ('rag_citations', 'RAG', 'Citation grounding', 150, 'Yes', 'Yes', 'Yes', 'Yes'),
    ('rag_reindex', 'RAG', 'On-demand reindexing', 160, 'No', 'Yes', 'Yes', 'Yes'),
    ('doc_ingestion', 'RAG', 'Document ingestion', 170, 'Up to 200 docs', 'Up to 2,000 docs', 'Up to 10,000 docs', 'Custom'),

    ('action_execution', 'Execution', 'Action execution', 180, 'Yes', 'Yes', 'Yes', 'Yes'),
    ('action_engine', 'Execution', 'Action execution engine', 190, 'No', 'Yes', 'Yes', 'Yes'),
    ('simulation_preview', 'Execution', 'Simulation preview before writes', 200, 'Yes', 'Yes', 'Yes', 'Yes'),
    ('undo_window', 'Execution', 'Undo window', 210, '30 sec', '30 sec', '60 sec', 'Custom'),
    ('action_history', 'Execution', 'Action history retention', 220, '30 days', '90 days', '365 days', 'Custom'),

    ('raci_governance', 'Governance', 'RACI governance', 230, 'Yes', 'Yes', 'Yes', 'Yes'),
    ('approvals', 'Governance', 'Approval workflows', 240, 'No', 'Yes', 'Yes', 'Yes'),
    ('risk_dashboard', 'Governance', 'Risk classification dashboard', 250, 'No', 'Yes', 'Yes', 'Yes'),
    ('guardrails', 'Governance', 'Guardrails configuration', 260, 'Yes', 'Yes', 'Yes', 'Yes'),
    ('audit_log', 'Governance', 'Immutable audit log', 270, 'Yes', 'Yes', 'Yes', 'Yes'),
    ('policy_overrides', 'Governance', 'Policy override history', 280, 'No', 'Limited', 'Yes', 'Yes'),

    ('predictive_ai', 'AI', 'Predictive AI insights', 290, 'Yes', 'Yes', 'Yes', 'Yes'),
    ('predictive_engine', 'AI', 'Predictive AI engine controls', 300, 'No', 'No', 'Yes', 'Yes'),
    ('custom_agents', 'AI', 'Custom agent builder', 310, 'No', 'Limited', 'Yes', 'Yes'),
    ('agent_memory', 'AI', 'Persistent agent memory', 320, 'No', 'Yes', 'Yes', 'Yes'),
    ('llm_model_controls', 'AI', 'Model policy controls', 330, 'No', 'No', 'No', 'Yes'),

    ('email_support', 'Support', 'Email support', 340, 'Yes', 'Yes', 'Yes', 'Yes'),
    ('priority_support', 'Support', 'Priority support', 350, 'No', 'Yes', 'Yes', 'Yes'),
    ('slack_support', 'Support', 'Slack support', 360, 'No', 'No', 'Yes', 'Yes'),
    ('dedicated_csm', 'Support', 'Dedicated CSM', 370, 'No', 'No', 'No', 'Yes'),
    ('sla_guarantee', 'Support', 'SLA guarantee', 380, 'No', 'No', 'Yes', 'Yes'),

    ('api_access', 'Developer', 'Developer API access', 390, 'Yes', 'Yes', 'Yes', 'Yes'),
    ('api_rate_limits', 'Developer', 'API rate limits', 400, 'Standard', 'Higher', 'High', 'Custom'),
    ('webhook_events', 'Developer', 'Webhook events', 410, 'No', 'Yes', 'Yes', 'Yes'),
    ('sdk_support', 'Developer', 'Typed SDK support', 420, 'Yes', 'Yes', 'Yes', 'Yes'),

    ('sso_saml', 'Enterprise', 'SSO / SAML', 430, 'No', 'No', 'No', 'Yes'),
    ('data_residency', 'Enterprise', 'Custom data residency', 440, 'No', 'No', 'Limited', 'Yes'),
    ('dedicated_infra', 'Enterprise', 'Dedicated infrastructure', 450, 'No', 'No', 'No', 'Yes'),
    ('custom_models', 'Enterprise', 'Custom model hosting', 460, 'No', 'No', 'No', 'Yes')
  ON CONFLICT (feature_key)
  DO UPDATE SET
    category = EXCLUDED.category,
    feature_name = EXCLUDED.feature_name,
    sort_order = EXCLUDED.sort_order,
    starter_value = EXCLUDED.starter_value,
    pro_value = EXCLUDED.pro_value,
    business_value = EXCLUDED.business_value,
    enterprise_value = EXCLUDED.enterprise_value;

  INSERT INTO public.pricing_faq_items (question, answer, sort_order, is_active)
  VALUES
    ('Can I switch plans later?', 'Yes. You can upgrade or downgrade at any time. Changes apply immediately, and billing is prorated where applicable.', 10, true),
    ('Do you offer a free trial?', 'Yes. Starter, Pro, and Business include a free trial period before billing starts.', 20, true),
    ('What happens if I exceed my token limit?', 'Your workspace will be rate-limited for token-heavy operations until the next cycle or until you upgrade.', 30, true),
    ('Is my data isolated per workspace?', 'Yes. AEAR enforces tenant isolation with row-level security and governed execution paths.', 40, true),
    ('Do you support annual contracts?', 'Yes. Annual billing applies a 20% savings compared to monthly pricing.', 50, true),
    ('How do Enterprise contracts work?', 'Enterprise plans are custom. We scope your requirements for infra, security, and support, then provide a tailored proposal.', 60, true)
  ON CONFLICT (sort_order)
  DO UPDATE SET
    question = EXCLUDED.question,
    answer = EXCLUDED.answer,
    is_active = EXCLUDED.is_active;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_public_pricing_payload(
  p_billing_interval text DEFAULT 'monthly'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_interval text := lower(trim(COALESCE(p_billing_interval, 'monthly')));
  v_plans jsonb := '[]'::jsonb;
  v_comparison jsonb := '[]'::jsonb;
  v_faq jsonb := '[]'::jsonb;
BEGIN
  IF v_interval NOT IN ('monthly', 'annual') THEN
    v_interval := 'monthly';
  END IF;

  PERFORM public.seed_public_pricing_catalog();

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'code', p.code,
        'name', p.name,
        'description', p.description,
        'badge', p.badge,
        'badgeTone', p.badge_tone,
        'ctaLabel', p.cta_label,
        'ctaVariant', p.cta_variant,
        'highlighted', p.highlighted,
        'priceCents', CASE WHEN v_interval = 'annual' THEN p.annual_price_cents ELSE p.monthly_price_cents END,
        'priceDisplay',
          CASE
            WHEN (CASE WHEN v_interval = 'annual' THEN p.annual_price_cents ELSE p.monthly_price_cents END) IS NULL
              THEN 'Custom'
            ELSE to_char(((CASE WHEN v_interval = 'annual' THEN p.annual_price_cents ELSE p.monthly_price_cents END)::numeric / 100.0), 'FM$999999990.00')
          END,
        'periodLabel',
          CASE
            WHEN (CASE WHEN v_interval = 'annual' THEN p.annual_price_cents ELSE p.monthly_price_cents END) IS NULL THEN ''
            WHEN v_interval = 'annual' THEN '/mo billed annually'
            ELSE '/mo'
          END,
        'features', (
          SELECT COALESCE(
            jsonb_agg(ppf.feature_text ORDER BY ppf.sort_order),
            '[]'::jsonb
          )
          FROM public.pricing_plan_features ppf
          WHERE ppf.plan_code = p.code
        )
      )
      ORDER BY p.sort_order
    ),
    '[]'::jsonb
  )
  INTO v_plans
  FROM public.pricing_plans p;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'featureKey', r.feature_key,
        'category', r.category,
        'featureName', r.feature_name,
        'starter', r.starter_value,
        'pro', r.pro_value,
        'business', r.business_value,
        'enterprise', r.enterprise_value
      )
      ORDER BY r.sort_order, r.feature_name
    ),
    '[]'::jsonb
  )
  INTO v_comparison
  FROM public.pricing_comparison_rows r;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'question', q.question,
        'answer', q.answer,
        'sortOrder', q.sort_order
      )
      ORDER BY q.sort_order
    ),
    '[]'::jsonb
  )
  INTO v_faq
  FROM public.pricing_faq_items q
  WHERE q.is_active = true;

  RETURN jsonb_build_object(
    'billingInterval', v_interval,
    'annualSavingsPct', 20,
    'plans', v_plans,
    'comparisonRows', v_comparison,
    'faq', v_faq
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_public_pricing_catalog() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_pricing_payload(text) TO anon, authenticated;
