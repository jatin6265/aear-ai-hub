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

  DELETE FROM public.pricing_plan_features WHERE true;

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

  DELETE FROM public.pricing_comparison_rows WHERE true;

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
    ('Is my data isolated per workspace?', 'Yes. OpsAI enforces tenant isolation with row-level security and governed execution paths.', 40, true),
    ('Do you support annual contracts?', 'Yes. Annual billing applies a 20% savings compared to monthly pricing.', 50, true),
    ('How do Enterprise contracts work?', 'Enterprise plans are custom. We scope your requirements for infra, security, and support, then provide a tailored proposal.', 60, true)
  ON CONFLICT (sort_order)
  DO UPDATE SET
    question = EXCLUDED.question,
    answer = EXCLUDED.answer,
    is_active = EXCLUDED.is_active;
END;
$$;

SELECT public.seed_public_pricing_catalog();
