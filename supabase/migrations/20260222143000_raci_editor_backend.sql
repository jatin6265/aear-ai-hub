-- RACI matrix visual editor backend contract.

CREATE TABLE IF NOT EXISTS public.raci_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  display_name text NOT NULL,
  display_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.raci_roles ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS raci_roles_tenant_name_uidx
  ON public.raci_roles (tenant_id, lower(name));

CREATE INDEX IF NOT EXISTS raci_roles_tenant_order_idx
  ON public.raci_roles (tenant_id, display_order, display_name);

CREATE TABLE IF NOT EXISTS public.raci_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  resource_key text NOT NULL,
  resource_label text NOT NULL,
  action text NOT NULL DEFAULT 'execute',
  category text NOT NULL DEFAULT 'System',
  display_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, resource_key, action)
);

ALTER TABLE public.raci_resources ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS raci_resources_tenant_category_idx
  ON public.raci_resources (tenant_id, category, display_order, resource_label);

ALTER TABLE public.raci_matrix
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'raci_matrix_type_check'
      AND conrelid = 'public.raci_matrix'::regclass
  ) THEN
    ALTER TABLE public.raci_matrix
      ADD CONSTRAINT raci_matrix_type_check
      CHECK (raci_type IN ('R', 'A', 'C', 'I'));
  END IF;
END;
$$;

WITH dedup AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, resource, action, lower(role_name)
      ORDER BY updated_at DESC, id DESC
    ) AS rn
  FROM public.raci_matrix
)
DELETE FROM public.raci_matrix rm
USING dedup d
WHERE rm.id = d.id
  AND d.rn > 1;

DROP INDEX IF EXISTS public.raci_matrix_unique_assignment_idx;

CREATE UNIQUE INDEX IF NOT EXISTS raci_matrix_cell_uidx
  ON public.raci_matrix (tenant_id, resource, action, lower(role_name));

CREATE INDEX IF NOT EXISTS raci_matrix_tenant_resource_idx
  ON public.raci_matrix (tenant_id, resource, action, updated_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'set_updated_at_timestamp'
      AND pg_function_is_visible(oid)
  ) THEN
    DROP TRIGGER IF EXISTS raci_roles_set_updated_at ON public.raci_roles;
    CREATE TRIGGER raci_roles_set_updated_at
    BEFORE UPDATE ON public.raci_roles
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS raci_resources_set_updated_at ON public.raci_resources;
    CREATE TRIGGER raci_resources_set_updated_at
    BEFORE UPDATE ON public.raci_resources
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS raci_matrix_set_updated_at ON public.raci_matrix;
    CREATE TRIGGER raci_matrix_set_updated_at
    BEFORE UPDATE ON public.raci_matrix
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_timestamp();
  END IF;
END;
$$;

DROP POLICY IF EXISTS "Tenant members can view raci roles" ON public.raci_roles;
CREATE POLICY "Tenant members can view raci roles"
  ON public.raci_roles FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage raci roles" ON public.raci_roles;
CREATE POLICY "Tenant members can manage raci roles"
  ON public.raci_roles FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can view raci resources" ON public.raci_resources;
CREATE POLICY "Tenant members can view raci resources"
  ON public.raci_resources FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage raci resources" ON public.raci_resources;
CREATE POLICY "Tenant members can manage raci resources"
  ON public.raci_resources FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

CREATE OR REPLACE FUNCTION public.raci_format_display_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT initcap(replace(trim(COALESCE(p_name, '')), '_', ' '));
$$;

CREATE OR REPLACE FUNCTION public.raci_infer_category(p_resource_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN lower(COALESCE(p_resource_key, '')) ~ '(finance|invoice|payment|revenue|ledger|tax|budget)'
      THEN 'Financial Data'
    WHEN lower(COALESCE(p_resource_key, '')) ~ '(inventory|stock|warehouse|sku|supply)'
      THEN 'Inventory'
    WHEN lower(COALESCE(p_resource_key, '')) ~ '(employee|hr|payroll|candidate|leave)'
      THEN 'HR'
    WHEN lower(COALESCE(p_resource_key, '')) ~ '(ops|operation|workflow|sync|job|ticket|incident)'
      THEN 'Operations'
    ELSE 'System'
  END;
$$;

CREATE OR REPLACE FUNCTION public.ensure_raci_editor_defaults()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  INSERT INTO public.raci_roles (tenant_id, name, display_name, display_order)
  SELECT
    v_tenant_id,
    role_name,
    public.raci_format_display_name(role_name),
    order_index
  FROM (
    SELECT role_name, MIN(order_index) AS order_index
    FROM (
      SELECT lower(trim(p.role)) AS role_name, 1000 AS order_index
      FROM public.profiles p
      WHERE p.tenant_id = v_tenant_id
        AND trim(COALESCE(p.role, '')) <> ''
      UNION ALL SELECT 'admin', 10
      UNION ALL SELECT 'manager', 20
      UNION ALL SELECT 'member', 30
      UNION ALL SELECT 'viewer', 40
    ) seed
    WHERE trim(COALESCE(role_name, '')) <> ''
    GROUP BY role_name
  ) normalized
  ON CONFLICT (tenant_id, (lower(name))) DO NOTHING;

  INSERT INTO public.raci_resources (tenant_id, resource_key, resource_label, action, category, display_order)
  SELECT
    v_tenant_id,
    key_name,
    public.raci_format_display_name(key_name),
    'execute',
    category_name,
    order_index
  FROM (
    VALUES
      ('financial_data', 'Financial Data', 10),
      ('inventory', 'Inventory', 20),
      ('hr_records', 'HR', 30),
      ('operations_workflows', 'Operations', 40),
      ('system_settings', 'System', 50)
  ) default_resources(key_name, category_name, order_index)
  ON CONFLICT (tenant_id, resource_key, action) DO NOTHING;

  INSERT INTO public.raci_resources (tenant_id, resource_key, resource_label, action, category, display_order)
  SELECT
    v_tenant_id,
    lower(trim(rm.resource)) AS resource_key,
    public.raci_format_display_name(rm.resource) AS resource_label,
    lower(trim(COALESCE(rm.action, 'execute'))) AS action,
    public.raci_infer_category(rm.resource) AS category,
    200
  FROM public.raci_matrix rm
  WHERE rm.tenant_id = v_tenant_id
    AND trim(COALESCE(rm.resource, '')) <> ''
  GROUP BY lower(trim(rm.resource)), lower(trim(COALESCE(rm.action, 'execute'))), public.raci_format_display_name(rm.resource), public.raci_infer_category(rm.resource)
  ON CONFLICT (tenant_id, resource_key, action) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_raci_editor_payload()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_payload jsonb;
BEGIN
  PERFORM public.ensure_raci_editor_defaults();

  SELECT jsonb_build_object(
    'roles', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'name', rr.name,
          'displayName', rr.display_name,
          'displayOrder', rr.display_order,
          'rulesCount', COALESCE(role_stats.rule_count, 0)
        )
        ORDER BY rr.display_order ASC, rr.display_name ASC
      )
      FROM public.raci_roles rr
      LEFT JOIN (
        SELECT lower(trim(rm.role_name)) AS role_name, COUNT(*)::integer AS rule_count
        FROM public.raci_matrix rm
        WHERE rm.tenant_id = v_tenant_id
        GROUP BY lower(trim(rm.role_name))
      ) role_stats
        ON role_stats.role_name = lower(trim(rr.name))
      WHERE rr.tenant_id = v_tenant_id
    ), '[]'::jsonb),
    'resources', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'resourceKey', rr.resource_key,
          'resourceLabel', rr.resource_label,
          'action', rr.action,
          'category', rr.category,
          'displayOrder', rr.display_order
        )
        ORDER BY
          CASE rr.category
            WHEN 'Financial Data' THEN 1
            WHEN 'Inventory' THEN 2
            WHEN 'HR' THEN 3
            WHEN 'Operations' THEN 4
            ELSE 5
          END,
          rr.display_order ASC,
          rr.resource_label ASC
      )
      FROM public.raci_resources rr
      WHERE rr.tenant_id = v_tenant_id
    ), '[]'::jsonb),
    'cells', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'resourceKey', lower(trim(rm.resource)),
          'action', lower(trim(COALESCE(rm.action, 'execute'))),
          'roleName', lower(trim(rm.role_name)),
          'raciType', rm.raci_type
        )
      )
      FROM public.raci_matrix rm
      WHERE rm.tenant_id = v_tenant_id
    ), '[]'::jsonb)
  )
  INTO v_payload;

  RETURN COALESCE(v_payload, '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_raci_cell(
  p_resource_key text,
  p_action text,
  p_role_name text,
  p_raci_type text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_resource_key text := lower(trim(COALESCE(p_resource_key, '')));
  v_action text := lower(trim(COALESCE(p_action, 'execute')));
  v_role_name text := lower(trim(COALESCE(p_role_name, '')));
  v_raci_type text := upper(trim(COALESCE(p_raci_type, '')));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_resource_key = '' OR v_role_name = '' THEN
    RAISE EXCEPTION 'Resource and role are required';
  END IF;

  PERFORM public.ensure_raci_editor_defaults();

  INSERT INTO public.raci_roles (tenant_id, name, display_name, display_order)
  VALUES (v_tenant_id, v_role_name, public.raci_format_display_name(v_role_name), 500)
  ON CONFLICT (tenant_id, (lower(name))) DO NOTHING;

  INSERT INTO public.raci_resources (tenant_id, resource_key, resource_label, action, category, display_order)
  VALUES (
    v_tenant_id,
    v_resource_key,
    public.raci_format_display_name(v_resource_key),
    v_action,
    public.raci_infer_category(v_resource_key),
    500
  )
  ON CONFLICT (tenant_id, resource_key, action) DO NOTHING;

  IF v_raci_type = '' OR v_raci_type = '-' THEN
    DELETE FROM public.raci_matrix rm
    WHERE rm.tenant_id = v_tenant_id
      AND lower(trim(rm.resource)) = v_resource_key
      AND lower(trim(COALESCE(rm.action, 'execute'))) = v_action
      AND lower(trim(rm.role_name)) = v_role_name;
    RETURN;
  END IF;

  IF v_raci_type NOT IN ('R', 'A', 'C', 'I') THEN
    RAISE EXCEPTION 'Invalid RACI type';
  END IF;

  INSERT INTO public.raci_matrix (tenant_id, resource, action, role_name, raci_type)
  VALUES (v_tenant_id, v_resource_key, v_action, v_role_name, v_raci_type)
  ON CONFLICT (tenant_id, resource, action, (lower(role_name)))
  DO UPDATE SET
    raci_type = EXCLUDED.raci_type,
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.add_raci_role(
  p_role_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role_name text := lower(trim(COALESCE(p_role_name, '')));
  v_next_order integer := 100;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_role_name = '' THEN
    RAISE EXCEPTION 'Role name is required';
  END IF;

  SELECT COALESCE(MAX(display_order), 90) + 10
  INTO v_next_order
  FROM public.raci_roles
  WHERE tenant_id = v_tenant_id;

  INSERT INTO public.raci_roles (tenant_id, name, display_name, display_order)
  VALUES (v_tenant_id, v_role_name, public.raci_format_display_name(v_role_name), v_next_order)
  ON CONFLICT (tenant_id, (lower(name))) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.rename_raci_role(
  p_old_role_name text,
  p_new_role_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_old_role text := lower(trim(COALESCE(p_old_role_name, '')));
  v_new_role text := lower(trim(COALESCE(p_new_role_name, '')));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_old_role = '' OR v_new_role = '' THEN
    RAISE EXCEPTION 'Old and new role names are required';
  END IF;

  IF v_old_role = v_new_role THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.raci_roles rr
    WHERE rr.tenant_id = v_tenant_id
      AND lower(trim(rr.name)) = v_new_role
  ) THEN
    RAISE EXCEPTION 'Role already exists';
  END IF;

  UPDATE public.raci_roles rr
  SET
    name = v_new_role,
    display_name = public.raci_format_display_name(v_new_role),
    updated_at = now()
  WHERE rr.tenant_id = v_tenant_id
    AND lower(trim(rr.name)) = v_old_role;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Role not found';
  END IF;

  UPDATE public.raci_matrix rm
  SET
    role_name = v_new_role,
    updated_at = now()
  WHERE rm.tenant_id = v_tenant_id
    AND lower(trim(rm.role_name)) = v_old_role;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_raci_role(
  p_role_name text,
  p_force boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role_name text := lower(trim(COALESCE(p_role_name, '')));
  v_rule_count integer := 0;
  v_deleted integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_role_name = '' THEN
    RAISE EXCEPTION 'Role name is required';
  END IF;

  SELECT COUNT(*)::integer
  INTO v_rule_count
  FROM public.raci_matrix rm
  WHERE rm.tenant_id = v_tenant_id
    AND lower(trim(rm.role_name)) = v_role_name;

  IF v_rule_count > 0 AND NOT p_force THEN
    RAISE EXCEPTION 'Role has active rules';
  END IF;

  DELETE FROM public.raci_matrix rm
  WHERE rm.tenant_id = v_tenant_id
    AND lower(trim(rm.role_name)) = v_role_name;

  DELETE FROM public.raci_roles rr
  WHERE rr.tenant_id = v_tenant_id
    AND lower(trim(rr.name)) = v_role_name;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.add_raci_rule_resource(
  p_resource_key text,
  p_action text DEFAULT 'execute',
  p_category text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_resource_key text := lower(trim(COALESCE(p_resource_key, '')));
  v_action text := lower(trim(COALESCE(p_action, 'execute')));
  v_category text := trim(COALESCE(p_category, ''));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_resource_key = '' THEN
    RAISE EXCEPTION 'Resource key is required';
  END IF;

  IF v_category = '' THEN
    v_category := public.raci_infer_category(v_resource_key);
  END IF;

  INSERT INTO public.raci_resources (tenant_id, resource_key, resource_label, action, category, display_order)
  VALUES (
    v_tenant_id,
    v_resource_key,
    public.raci_format_display_name(v_resource_key),
    v_action,
    v_category,
    500
  )
  ON CONFLICT (tenant_id, resource_key, action)
  DO UPDATE SET
    category = EXCLUDED.category,
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.import_raci_rules_csv_rows(
  p_rows jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row jsonb;
  v_count integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF jsonb_typeof(COALESCE(p_rows, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Rows payload must be an array';
  END IF;

  FOR v_row IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb))
  LOOP
    PERFORM public.add_raci_rule_resource(
      p_resource_key := COALESCE(v_row ->> 'resource', ''),
      p_action := COALESCE(v_row ->> 'action', 'execute'),
      p_category := COALESCE(v_row ->> 'category', NULL)
    );

    PERFORM public.add_raci_role(COALESCE(v_row ->> 'role', ''));

    PERFORM public.set_raci_cell(
      p_resource_key := COALESCE(v_row ->> 'resource', ''),
      p_action := COALESCE(v_row ->> 'action', 'execute'),
      p_role_name := COALESCE(v_row ->> 'role', ''),
      p_raci_type := COALESCE(v_row ->> 'raciType', '-')
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_raci_matrix_rules()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT public.get_user_tenant_id() AS tenant_id
  ),
  resources AS (
    SELECT
      rr.resource_key,
      rr.resource_label,
      rr.action,
      rr.category
    FROM public.raci_resources rr
    JOIN me ON me.tenant_id = rr.tenant_id
  ),
  assignment_rollup AS (
    SELECT
      r.resource_key,
      r.resource_label,
      r.action,
      r.category,
      COUNT(rm.id)::integer AS assignment_count,
      COUNT(*) FILTER (WHERE rm.raci_type = 'R')::integer AS r_count,
      COUNT(*) FILTER (WHERE rm.raci_type = 'A')::integer AS a_count
    FROM resources r
    LEFT JOIN public.raci_matrix rm
      ON rm.tenant_id = (SELECT tenant_id FROM me)
     AND lower(trim(rm.resource)) = r.resource_key
     AND lower(trim(COALESCE(rm.action, 'execute'))) = lower(trim(r.action))
    GROUP BY r.resource_key, r.resource_label, r.action, r.category
  ),
  issues AS (
    SELECT
      ar.resource_key,
      ar.resource_label,
      ar.action,
      ar.category,
      CASE
        WHEN ar.assignment_count = 0 THEN 'No RACI assigned'
        WHEN ar.r_count = 0 THEN 'No Responsible assigned'
        WHEN ar.a_count = 0 THEN 'Responsible exists without Accountable'
        WHEN ar.r_count > 0 AND ar.a_count > 0 THEN NULL
        ELSE 'Invalid RACI assignment'
      END AS issue
    FROM assignment_rollup ar
  ),
  issue_rows AS (
    SELECT *
    FROM issues
    WHERE issue IS NOT NULL
  ),
  compliant AS (
    SELECT COUNT(*)::integer AS compliant_count
    FROM issues
    WHERE issue IS NULL
  ),
  total AS (
    SELECT COUNT(*)::integer AS total_count
    FROM assignment_rollup
  )
  SELECT jsonb_build_object(
    'totalResources', COALESCE((SELECT total_count FROM total), 0),
    'compliantResources', COALESCE((SELECT compliant_count FROM compliant), 0),
    'issuesCount', COALESCE((SELECT COUNT(*)::integer FROM issue_rows), 0),
    'issues', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'resourceKey', ir.resource_key,
          'resourceLabel', ir.resource_label,
          'action', ir.action,
          'category', ir.category,
          'issue', ir.issue
        )
      )
      FROM issue_rows ir
    ), '[]'::jsonb)
  );
$$;

GRANT EXECUTE ON FUNCTION public.raci_format_display_name(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.raci_infer_category(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_raci_editor_defaults() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_raci_editor_payload() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_raci_cell(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_raci_role(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rename_raci_role(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_raci_role(text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_raci_rule_resource(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.import_raci_rules_csv_rows(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_raci_matrix_rules() TO authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'raci_roles'
  ) THEN
    NULL;
  ELSE
    ALTER PUBLICATION supabase_realtime ADD TABLE public.raci_roles;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'raci_resources'
  ) THEN
    NULL;
  ELSE
    ALTER PUBLICATION supabase_realtime ADD TABLE public.raci_resources;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'raci_matrix'
  ) THEN
    NULL;
  ELSE
    ALTER PUBLICATION supabase_realtime ADD TABLE public.raci_matrix;
  END IF;
END;
$$;
