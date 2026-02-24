-- Risk Classification Dashboard backend: matrix rules, override history, and payload RPCs.

CREATE TABLE IF NOT EXISTS public.risk_matrix_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  resource text NOT NULL,
  action text NOT NULL,
  risk_level text NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  override_risk_level text CHECK (override_risk_level IN ('low', 'medium', 'high', 'critical')),
  override_justification text,
  overridden_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  overridden_at timestamptz,
  policy text NOT NULL DEFAULT '',
  raci_required text NOT NULL DEFAULT 'R',
  requires_dual_approval boolean NOT NULL DEFAULT false,
  requires_2fa boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  source_guardrail_code text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.risk_matrix_rules ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS risk_matrix_rules_tenant_resource_action_uidx
  ON public.risk_matrix_rules (tenant_id, lower(resource), lower(action));

CREATE INDEX IF NOT EXISTS risk_matrix_rules_tenant_risk_idx
  ON public.risk_matrix_rules (tenant_id, enabled, risk_level);

DROP TRIGGER IF EXISTS risk_matrix_rules_set_updated_at ON public.risk_matrix_rules;
CREATE TRIGGER risk_matrix_rules_set_updated_at
BEFORE UPDATE ON public.risk_matrix_rules
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

CREATE TABLE IF NOT EXISTS public.risk_rule_override_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  risk_rule_id uuid NOT NULL REFERENCES public.risk_matrix_rules(id) ON DELETE CASCADE,
  previous_risk_level text NOT NULL CHECK (previous_risk_level IN ('low', 'medium', 'high', 'critical')),
  override_risk_level text NOT NULL CHECK (override_risk_level IN ('low', 'medium', 'high', 'critical')),
  justification text NOT NULL,
  overridden_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.risk_rule_override_history ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS risk_rule_override_history_tenant_rule_idx
  ON public.risk_rule_override_history (tenant_id, risk_rule_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'risk_matrix_rules'
      AND policyname = 'Tenant members can view risk matrix rules'
  ) THEN
    CREATE POLICY "Tenant members can view risk matrix rules"
      ON public.risk_matrix_rules
      FOR SELECT TO authenticated
      USING (tenant_id = public.get_user_tenant_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'risk_matrix_rules'
      AND policyname = 'Tenant members can manage risk matrix rules'
  ) THEN
    CREATE POLICY "Tenant members can manage risk matrix rules"
      ON public.risk_matrix_rules
      FOR ALL TO authenticated
      USING (tenant_id = public.get_user_tenant_id())
      WITH CHECK (tenant_id = public.get_user_tenant_id());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'risk_rule_override_history'
      AND policyname = 'Tenant members can view risk override history'
  ) THEN
    CREATE POLICY "Tenant members can view risk override history"
      ON public.risk_rule_override_history
      FOR SELECT TO authenticated
      USING (tenant_id = public.get_user_tenant_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'risk_rule_override_history'
      AND policyname = 'Tenant members can manage risk override history'
  ) THEN
    CREATE POLICY "Tenant members can manage risk override history"
      ON public.risk_rule_override_history
      FOR ALL TO authenticated
      USING (tenant_id = public.get_user_tenant_id())
      WITH CHECK (tenant_id = public.get_user_tenant_id());
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.current_user_is_tenant_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.tenant_id = public.get_user_tenant_id()
      AND lower(COALESCE(p.role, 'member')) IN ('owner', 'admin')
      AND COALESCE(p.status, 'active') = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.seed_default_risk_matrix(p_tenant_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer := 0;
BEGIN
  IF p_tenant_id IS NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO public.risk_matrix_rules (
    tenant_id,
    resource,
    action,
    risk_level,
    policy,
    raci_required,
    requires_dual_approval,
    requires_2fa,
    source_guardrail_code,
    created_by,
    updated_by
  )
  SELECT
    p_tenant_id,
    s.resource,
    s.action,
    s.risk_level,
    s.policy,
    s.raci_required,
    s.requires_dual_approval,
    s.requires_2fa,
    s.source_guardrail_code,
    auth.uid(),
    auth.uid()
  FROM (
    VALUES
      ('Finance', 'View', 'low', 'Read-only access with masked PII fields in results.', 'C', false, false, 'pii_export'),
      ('Finance', 'Query', 'medium', 'Query operations are logged and monitored for anomalies.', 'R', false, false, 'off_hours'),
      ('Finance', 'Update', 'high', 'Write updates require approval from the Finance Manager.', 'R+A', true, false, 'destructive_write'),
      ('Finance', 'Delete', 'critical', 'Requires dual approval + 2FA and immutable audit trail before execution.', 'R+A', true, true, 'destructive_write'),
      ('Finance', 'Export', 'high', 'PII redaction enforced; bulk export requires approval workflow.', 'A', true, true, 'pii_export'),

      ('Inventory', 'View', 'low', 'Read-only inventory lookup.', 'C', false, false, 'off_hours'),
      ('Inventory', 'Query', 'low', 'Non-destructive inventory queries.', 'R', false, false, 'off_hours'),
      ('Inventory', 'Update', 'medium', 'Stock updates require manager responsibility.', 'R', false, false, 'off_hours'),
      ('Inventory', 'Delete', 'critical', 'Delete requires dual approval + 2FA + rollback readiness.', 'R+A', true, true, 'destructive_write'),
      ('Inventory', 'Export', 'medium', 'Bulk inventory export is logged and rate-limited.', 'C', false, false, 'pii_export'),

      ('HR', 'View', 'medium', 'HR records include sensitive employee fields.', 'C', false, false, 'pii_export'),
      ('HR', 'Query', 'medium', 'Restricted HR query scope by role.', 'R', false, false, 'off_hours'),
      ('HR', 'Update', 'high', 'HR updates require accountable approver.', 'R+A', true, false, 'destructive_write'),
      ('HR', 'Delete', 'critical', 'Employee record deletion requires dual approval + 2FA.', 'R+A', true, true, 'destructive_write'),
      ('HR', 'Export', 'high', 'HR export requires manager approval and masking.', 'A', true, true, 'pii_export'),

      ('Operations', 'View', 'low', 'Operational dashboards are read-only for most roles.', 'I', false, false, 'off_hours'),
      ('Operations', 'Execute', 'medium', 'Execution actions are policy checked before dispatch.', 'R', false, false, 'off_hours'),
      ('Operations', 'Update', 'medium', 'Workflow updates require responsible operator.', 'R', false, false, 'off_hours'),
      ('Operations', 'Delete', 'high', 'Operational deletes require approval with preview.', 'R+A', true, false, 'destructive_write'),

      ('System', 'View', 'medium', 'System metadata visibility is restricted.', 'C', false, false, 'off_hours'),
      ('System', 'Configure', 'high', 'Configuration changes require accountable admin.', 'A', true, true, 'destructive_write'),
      ('System', 'Execute', 'high', 'System action execution requires explicit policy allow.', 'A', true, true, 'destructive_write'),
      ('System', 'Delete', 'critical', 'System destructive actions require dual approval + 2FA.', 'A', true, true, 'destructive_write')
  ) AS s(resource, action, risk_level, policy, raci_required, requires_dual_approval, requires_2fa, source_guardrail_code)
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.risk_matrix_rules r
    WHERE r.tenant_id = p_tenant_id
      AND lower(r.resource) = lower(s.resource)
      AND lower(r.action) = lower(s.action)
  );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_guardrails_risk_dashboard(
  p_event_risk_filter text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role text := 'member';
  v_is_admin boolean := false;
  v_filter text := lower(trim(COALESCE(p_event_risk_filter, 'all')));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  IF v_filter NOT IN ('all', 'low', 'medium', 'high', 'critical') THEN
    v_filter := 'all';
  END IF;

  SELECT lower(COALESCE(p.role, 'member'))
  INTO v_role
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.tenant_id = v_tenant_id;

  v_is_admin := v_role IN ('owner', 'admin');

  IF NOT EXISTS (SELECT 1 FROM public.guardrails g WHERE g.tenant_id = v_tenant_id) THEN
    PERFORM public.seed_default_guardrails(v_tenant_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.risk_matrix_rules r WHERE r.tenant_id = v_tenant_id) THEN
    PERFORM public.seed_default_risk_matrix(v_tenant_id);
  END IF;

  RETURN jsonb_build_object(
    'profileRole', v_role,
    'isAdmin', v_is_admin,
    'summary', (
      SELECT jsonb_build_object(
        'critical', COUNT(*) FILTER (WHERE effective_risk = 'critical'),
        'high', COUNT(*) FILTER (WHERE effective_risk = 'high'),
        'medium', COUNT(*) FILTER (WHERE effective_risk = 'medium'),
        'low', COUNT(*) FILTER (WHERE effective_risk = 'low')
      )
      FROM (
        SELECT lower(COALESCE(r.override_risk_level, r.risk_level)) AS effective_risk
        FROM public.risk_matrix_rules r
        WHERE r.tenant_id = v_tenant_id
          AND r.enabled = true
      ) levels
    ),
    'resources', (
      SELECT COALESCE(jsonb_agg(x.resource ORDER BY x.resource), '[]'::jsonb)
      FROM (
        SELECT DISTINCT r.resource
        FROM public.risk_matrix_rules r
        WHERE r.tenant_id = v_tenant_id
          AND r.enabled = true
      ) x
    ),
    'actions', (
      SELECT COALESCE(jsonb_agg(x.action ORDER BY x.action), '[]'::jsonb)
      FROM (
        SELECT DISTINCT r.action
        FROM public.risk_matrix_rules r
        WHERE r.tenant_id = v_tenant_id
          AND r.enabled = true
      ) x
    ),
    'rules', (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', r.id,
            'resource', r.resource,
            'action', r.action,
            'riskLevel', lower(r.risk_level),
            'effectiveRiskLevel', lower(COALESCE(r.override_risk_level, r.risk_level)),
            'overrideRiskLevel', lower(r.override_risk_level),
            'policy', r.policy,
            'raciRequired', r.raci_required,
            'requiresDualApproval', r.requires_dual_approval,
            'requires2fa', r.requires_2fa,
            'enabled', r.enabled,
            'updatedAt', r.updated_at,
            'overrideMeta', CASE
              WHEN r.override_risk_level IS NULL THEN NULL
              ELSE jsonb_build_object(
                'justification', r.override_justification,
                'overriddenBy', r.overridden_by,
                'overriddenAt', r.overridden_at
              )
            END,
            'overrideHistory', COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object(
                  'id', h.id,
                  'previousRiskLevel', h.previous_risk_level,
                  'overrideRiskLevel', h.override_risk_level,
                  'justification', h.justification,
                  'actorName', COALESCE(NULLIF(trim(ap.full_name), ''), split_part(COALESCE(au.email, ''), '@', 1), 'Unknown user'),
                  'createdAt', h.created_at
                )
                ORDER BY h.created_at DESC
              )
              FROM (
                SELECT *
                FROM public.risk_rule_override_history h0
                WHERE h0.risk_rule_id = r.id
                ORDER BY h0.created_at DESC
                LIMIT 8
              ) h
              LEFT JOIN public.profiles ap ON ap.id = h.overridden_by
              LEFT JOIN auth.users au ON au.id = h.overridden_by
            ), '[]'::jsonb)
          )
          ORDER BY r.resource ASC, r.action ASC
        ),
        '[]'::jsonb
      )
      FROM public.risk_matrix_rules r
      WHERE r.tenant_id = v_tenant_id
        AND r.enabled = true
    ),
    'guardrails', (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', g.id,
            'code', g.code,
            'name', g.name,
            'description', g.description,
            'enabled', g.enabled,
            'riskLevel', lower(g.risk_level),
            'updatedAt', g.updated_at
          )
          ORDER BY g.created_at ASC
        ),
        '[]'::jsonb
      )
      FROM public.guardrails g
      WHERE g.tenant_id = v_tenant_id
    ),
    'recentEvents', (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', e.id,
            'riskLevel', e.risk_level,
            'status', e.status,
            'action', e.action,
            'resource', e.resource,
            'actorName', e.actor_name,
            'createdAt', e.created_at,
            'details', e.details
          )
          ORDER BY e.created_at DESC
        ),
        '[]'::jsonb
      )
      FROM (
        SELECT
          al.id,
          lower(COALESCE(al.risk_level, 'low')) AS risk_level,
          lower(COALESCE(al.status, 'unknown')) AS status,
          COALESCE(al.action, 'action') AS action,
          COALESCE(al.resource, 'resource') AS resource,
          COALESCE(NULLIF(trim(ap.full_name), ''), split_part(COALESCE(au.email, ''), '@', 1), 'Unknown user') AS actor_name,
          al.created_at,
          al.details
        FROM public.audit_logs al
        LEFT JOIN public.profiles ap ON ap.id = al.user_id
        LEFT JOIN auth.users au ON au.id = al.user_id
        WHERE al.tenant_id = v_tenant_id
          AND (
            (v_filter = 'all' AND lower(COALESCE(al.risk_level, 'low')) IN ('high', 'critical'))
            OR (v_filter IN ('low', 'medium', 'high', 'critical') AND lower(COALESCE(al.risk_level, 'low')) = v_filter)
          )
        ORDER BY al.created_at DESC
        LIMIT 40
      ) e
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_risk_rule_override(
  p_rule_id uuid,
  p_override_risk_level text,
  p_justification text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role text := 'member';
  v_override text := lower(trim(COALESCE(p_override_risk_level, '')));
  v_justification text := NULLIF(trim(COALESCE(p_justification, '')), '');
  v_rule public.risk_matrix_rules%ROWTYPE;
  v_previous text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_rule_id IS NULL THEN
    RAISE EXCEPTION 'ruleId is required';
  END IF;

  IF v_override NOT IN ('low', 'medium', 'high', 'critical') THEN
    RAISE EXCEPTION 'override risk level must be low, medium, high, or critical';
  END IF;

  IF v_justification IS NULL OR length(v_justification) < 8 THEN
    RAISE EXCEPTION 'Justification is required and must be at least 8 characters';
  END IF;

  SELECT lower(COALESCE(role, 'member'))
  INTO v_role
  FROM public.profiles
  WHERE id = auth.uid()
    AND tenant_id = v_tenant_id
    AND COALESCE(status, 'active') = 'active';

  IF v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only owner/admin can override risk levels';
  END IF;

  SELECT *
  INTO v_rule
  FROM public.risk_matrix_rules r
  WHERE r.id = p_rule_id
    AND r.tenant_id = v_tenant_id
  FOR UPDATE;

  IF v_rule.id IS NULL THEN
    RAISE EXCEPTION 'Risk rule not found';
  END IF;

  v_previous := lower(COALESCE(v_rule.override_risk_level, v_rule.risk_level));

  UPDATE public.risk_matrix_rules
  SET
    override_risk_level = v_override,
    override_justification = v_justification,
    overridden_by = auth.uid(),
    overridden_at = now(),
    updated_by = auth.uid()
  WHERE id = p_rule_id
    AND tenant_id = v_tenant_id;

  INSERT INTO public.risk_rule_override_history (
    tenant_id,
    risk_rule_id,
    previous_risk_level,
    override_risk_level,
    justification,
    overridden_by
  )
  VALUES (
    v_tenant_id,
    p_rule_id,
    v_previous,
    v_override,
    v_justification,
    auth.uid()
  );

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, risk_level, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'risk.override',
    COALESCE(v_rule.resource, 'risk_matrix_rules'),
    v_override,
    'success',
    jsonb_build_object(
      'rule_id', p_rule_id,
      'resource', v_rule.resource,
      'action', v_rule.action,
      'previous', v_previous,
      'override', v_override,
      'justification', v_justification
    )
  );

  RETURN (
    SELECT jsonb_build_object(
      'id', r.id,
      'resource', r.resource,
      'action', r.action,
      'riskLevel', lower(r.risk_level),
      'effectiveRiskLevel', lower(COALESCE(r.override_risk_level, r.risk_level)),
      'overrideRiskLevel', lower(r.override_risk_level),
      'policy', r.policy,
      'raciRequired', r.raci_required,
      'requiresDualApproval', r.requires_dual_approval,
      'requires2fa', r.requires_2fa,
      'updatedAt', r.updated_at
    )
    FROM public.risk_matrix_rules r
    WHERE r.id = p_rule_id
      AND r.tenant_id = v_tenant_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.current_user_is_tenant_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.seed_default_risk_matrix(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_guardrails_risk_dashboard(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_risk_rule_override(uuid, text, text) TO authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication
    WHERE pubname = 'supabase_realtime'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'risk_matrix_rules'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.risk_matrix_rules;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'risk_rule_override_history'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.risk_rule_override_history;
    END IF;
  END IF;
END;
$$;
