-- RACI role management backend: role metadata, member assignment, and template application.

ALTER TABLE public.raci_roles
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS icon text NOT NULL DEFAULT '👤';

CREATE TABLE IF NOT EXISTS public.raci_role_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.raci_roles(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, profile_id)
);

ALTER TABLE public.raci_role_members ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS raci_role_members_tenant_role_idx
  ON public.raci_role_members (tenant_id, role_id, created_at DESC);

CREATE INDEX IF NOT EXISTS raci_role_members_tenant_profile_idx
  ON public.raci_role_members (tenant_id, profile_id);

DROP POLICY IF EXISTS "Tenant members can view raci role members" ON public.raci_role_members;
CREATE POLICY "Tenant members can view raci role members"
  ON public.raci_role_members FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage raci role members" ON public.raci_role_members;
CREATE POLICY "Tenant members can manage raci role members"
  ON public.raci_role_members FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

CREATE OR REPLACE FUNCTION public.raci_default_role_icon(p_role_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN lower(COALESCE(p_role_name, '')) ~ '(finance|account|billing|cfo|revenue)' THEN '💰'
    WHEN lower(COALESCE(p_role_name, '')) ~ '(operation|ops|supply|warehouse)' THEN '⚙️'
    WHEN lower(COALESCE(p_role_name, '')) ~ '(hr|human|people|talent)' THEN '📦'
    WHEN lower(COALESCE(p_role_name, '')) ~ '(security|it|infra|admin)' THEN '🛡️'
    WHEN lower(COALESCE(p_role_name, '')) ~ '(suite|executive|board|ceo|cto|vp)' THEN '📊'
    ELSE '👤'
  END;
$$;

-- Backfill existing rows to mapped icons.
UPDATE public.raci_roles rr
SET icon = public.raci_default_role_icon(rr.name)
WHERE COALESCE(trim(rr.icon), '') = ''
   OR rr.icon = '👤';

CREATE OR REPLACE FUNCTION public.list_raci_role_templates()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_array(
    jsonb_build_object(
      'key', 'finance_manager',
      'name', 'Finance Manager',
      'icon', '💰',
      'description', 'Owns financial operations and approval workflows.',
      'defaults', jsonb_build_array(
        jsonb_build_object('resource', 'financial_data', 'action', 'execute', 'raciType', 'R'),
        jsonb_build_object('resource', 'financial_data', 'action', 'approve', 'raciType', 'A'),
        jsonb_build_object('resource', 'operations_workflows', 'action', 'execute', 'raciType', 'C'),
        jsonb_build_object('resource', 'system_settings', 'action', 'execute', 'raciType', 'I')
      )
    ),
    jsonb_build_object(
      'key', 'operations_lead',
      'name', 'Operations Lead',
      'icon', '⚙️',
      'description', 'Leads operational execution and process outcomes.',
      'defaults', jsonb_build_array(
        jsonb_build_object('resource', 'operations_workflows', 'action', 'execute', 'raciType', 'R'),
        jsonb_build_object('resource', 'inventory', 'action', 'execute', 'raciType', 'A'),
        jsonb_build_object('resource', 'financial_data', 'action', 'execute', 'raciType', 'C'),
        jsonb_build_object('resource', 'system_settings', 'action', 'execute', 'raciType', 'I')
      )
    ),
    jsonb_build_object(
      'key', 'hr_manager',
      'name', 'HR Manager',
      'icon', '📦',
      'description', 'Manages workforce data and HR-sensitive operations.',
      'defaults', jsonb_build_array(
        jsonb_build_object('resource', 'hr_records', 'action', 'execute', 'raciType', 'R'),
        jsonb_build_object('resource', 'hr_records', 'action', 'approve', 'raciType', 'A'),
        jsonb_build_object('resource', 'operations_workflows', 'action', 'execute', 'raciType', 'C'),
        jsonb_build_object('resource', 'system_settings', 'action', 'execute', 'raciType', 'I')
      )
    ),
    jsonb_build_object(
      'key', 'it_admin',
      'name', 'IT Admin',
      'icon', '🛡️',
      'description', 'Maintains platform controls, security and system access.',
      'defaults', jsonb_build_array(
        jsonb_build_object('resource', 'system_settings', 'action', 'execute', 'raciType', 'A'),
        jsonb_build_object('resource', 'operations_workflows', 'action', 'execute', 'raciType', 'R'),
        jsonb_build_object('resource', 'inventory', 'action', 'execute', 'raciType', 'C'),
        jsonb_build_object('resource', 'financial_data', 'action', 'execute', 'raciType', 'I')
      )
    ),
    jsonb_build_object(
      'key', 'c_suite',
      'name', 'C-Suite',
      'icon', '📊',
      'description', 'Executive stakeholders with accountability across key domains.',
      'defaults', jsonb_build_array(
        jsonb_build_object('resource', 'financial_data', 'action', 'approve', 'raciType', 'A'),
        jsonb_build_object('resource', 'operations_workflows', 'action', 'approve', 'raciType', 'A'),
        jsonb_build_object('resource', 'hr_records', 'action', 'execute', 'raciType', 'I'),
        jsonb_build_object('resource', 'system_settings', 'action', 'execute', 'raciType', 'C')
      )
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.get_raci_role_management_payload()
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
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  PERFORM public.ensure_raci_editor_defaults();

  SELECT jsonb_build_object(
    'roles', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', rr.id,
          'name', rr.name,
          'displayName', rr.display_name,
          'description', rr.description,
          'icon', COALESCE(NULLIF(trim(rr.icon), ''), public.raci_default_role_icon(rr.name)),
          'memberCount', COALESCE(member_stats.member_count, 0),
          'memberIds', COALESCE(member_stats.member_ids, '[]'::jsonb),
          'members', COALESCE(member_stats.members, '[]'::jsonb),
          'responsibleCount', COALESCE(permission_stats.responsible_count, 0),
          'accountableCount', COALESCE(permission_stats.accountable_count, 0),
          'permissionPreview', COALESCE(permission_stats.permission_preview, '[]'::jsonb)
        )
        ORDER BY rr.display_order ASC, rr.display_name ASC
      )
      FROM public.raci_roles rr
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::integer AS member_count,
          COALESCE(jsonb_agg(p.id), '[]'::jsonb) AS member_ids,
          COALESCE(jsonb_agg(
            jsonb_build_object(
              'id', p.id,
              'fullName', COALESCE(NULLIF(trim(p.full_name), ''), au.email, 'User ' || left(p.id::text, 8)),
              'avatarUrl', p.avatar_url,
              'email', au.email
            )
            ORDER BY COALESCE(NULLIF(trim(p.full_name), ''), au.email, p.id::text)
          ), '[]'::jsonb) AS members
        FROM public.raci_role_members rrm
        JOIN public.profiles p
          ON p.id = rrm.profile_id
         AND p.tenant_id = v_tenant_id
        LEFT JOIN auth.users au
          ON au.id = p.id
        WHERE rrm.tenant_id = v_tenant_id
          AND rrm.role_id = rr.id
      ) member_stats ON true
      LEFT JOIN LATERAL (
        WITH role_rules AS (
          SELECT
            rm.resource,
            COALESCE(rm.action, 'execute') AS action,
            rm.raci_type
          FROM public.raci_matrix rm
          WHERE rm.tenant_id = v_tenant_id
            AND lower(trim(rm.role_name)) = lower(trim(rr.name))
        ),
        preview_rules AS (
          SELECT rr2.resource, rr2.action, rr2.raci_type
          FROM role_rules rr2
          ORDER BY rr2.resource ASC, rr2.action ASC
          LIMIT 12
        )
        SELECT
          COUNT(*) FILTER (WHERE role_rules.raci_type = 'R')::integer AS responsible_count,
          COUNT(*) FILTER (WHERE role_rules.raci_type = 'A')::integer AS accountable_count,
          COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'resource', pr.resource,
                'action', pr.action,
                'raciType', pr.raci_type
              )
            )
            FROM preview_rules pr
          ), '[]'::jsonb) AS permission_preview
        FROM role_rules
      ) permission_stats ON true
      WHERE rr.tenant_id = v_tenant_id
    ), '[]'::jsonb),
    'members', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'fullName', COALESCE(NULLIF(trim(p.full_name), ''), au.email, 'User ' || left(p.id::text, 8)),
          'avatarUrl', p.avatar_url,
          'email', au.email,
          'defaultRole', p.role
        )
        ORDER BY COALESCE(NULLIF(trim(p.full_name), ''), au.email, p.id::text)
      )
      FROM public.profiles p
      LEFT JOIN auth.users au
        ON au.id = p.id
      WHERE p.tenant_id = v_tenant_id
    ), '[]'::jsonb),
    'templates', public.list_raci_role_templates()
  )
  INTO v_payload;

  RETURN COALESCE(v_payload, '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_raci_role_management(
  p_role_name text,
  p_description text DEFAULT NULL,
  p_icon text DEFAULT NULL,
  p_member_ids uuid[] DEFAULT '{}'::uuid[],
  p_previous_role_name text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role_name text := lower(trim(COALESCE(p_role_name, '')));
  v_previous_role_name text := lower(trim(COALESCE(p_previous_role_name, '')));
  v_description text := NULLIF(trim(COALESCE(p_description, '')), '');
  v_icon text := NULLIF(trim(COALESCE(p_icon, '')), '');
  v_role_id uuid;
  v_next_order integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  IF v_role_name = '' THEN
    RAISE EXCEPTION 'Role name is required';
  END IF;

  PERFORM public.ensure_raci_editor_defaults();

  IF v_previous_role_name <> '' AND v_previous_role_name <> v_role_name THEN
    PERFORM public.rename_raci_role(v_previous_role_name, v_role_name);
  END IF;

  SELECT COALESCE(MAX(display_order), 90) + 10
  INTO v_next_order
  FROM public.raci_roles rr
  WHERE rr.tenant_id = v_tenant_id;

  INSERT INTO public.raci_roles (tenant_id, name, display_name, display_order, description, icon)
  VALUES (
    v_tenant_id,
    v_role_name,
    public.raci_format_display_name(v_role_name),
    v_next_order,
    v_description,
    COALESCE(v_icon, public.raci_default_role_icon(v_role_name))
  )
  ON CONFLICT (tenant_id, (lower(name))) DO NOTHING;

  UPDATE public.raci_roles rr
  SET
    description = v_description,
    icon = COALESCE(v_icon, rr.icon, public.raci_default_role_icon(v_role_name)),
    display_name = public.raci_format_display_name(v_role_name),
    updated_at = now()
  WHERE rr.tenant_id = v_tenant_id
    AND lower(trim(rr.name)) = v_role_name
  RETURNING rr.id INTO v_role_id;

  IF v_role_id IS NULL THEN
    SELECT rr.id
    INTO v_role_id
    FROM public.raci_roles rr
    WHERE rr.tenant_id = v_tenant_id
      AND lower(trim(rr.name)) = v_role_name
    LIMIT 1;
  END IF;

  DELETE FROM public.raci_role_members rrm
  WHERE rrm.tenant_id = v_tenant_id
    AND rrm.role_id = v_role_id;

  IF COALESCE(array_length(p_member_ids, 1), 0) > 0 THEN
    INSERT INTO public.raci_role_members (tenant_id, role_id, profile_id)
    SELECT
      v_tenant_id,
      v_role_id,
      p.id
    FROM public.profiles p
    WHERE p.tenant_id = v_tenant_id
      AND p.id = ANY (p_member_ids)
    ON CONFLICT (role_id, profile_id) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'roleId', v_role_id,
    'roleName', v_role_name
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_raci_role_template(
  p_template_key text,
  p_member_ids uuid[] DEFAULT '{}'::uuid[],
  p_role_name text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_template_key text := lower(trim(COALESCE(p_template_key, '')));
  v_role_name text;
  v_description text;
  v_icon text;
  v_rules jsonb := '[]'::jsonb;
  v_rule jsonb;
  v_applied integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  CASE v_template_key
    WHEN 'finance_manager' THEN
      v_role_name := 'finance_manager';
      v_description := 'Owns financial operations and approval workflows.';
      v_icon := '💰';
      v_rules := '[
        {"resource":"financial_data","action":"execute","raciType":"R"},
        {"resource":"financial_data","action":"approve","raciType":"A"},
        {"resource":"operations_workflows","action":"execute","raciType":"C"},
        {"resource":"system_settings","action":"execute","raciType":"I"}
      ]'::jsonb;
    WHEN 'operations_lead' THEN
      v_role_name := 'operations_lead';
      v_description := 'Leads operational execution and process outcomes.';
      v_icon := '⚙️';
      v_rules := '[
        {"resource":"operations_workflows","action":"execute","raciType":"R"},
        {"resource":"inventory","action":"execute","raciType":"A"},
        {"resource":"financial_data","action":"execute","raciType":"C"},
        {"resource":"system_settings","action":"execute","raciType":"I"}
      ]'::jsonb;
    WHEN 'hr_manager' THEN
      v_role_name := 'hr_manager';
      v_description := 'Manages workforce data and HR-sensitive operations.';
      v_icon := '📦';
      v_rules := '[
        {"resource":"hr_records","action":"execute","raciType":"R"},
        {"resource":"hr_records","action":"approve","raciType":"A"},
        {"resource":"operations_workflows","action":"execute","raciType":"C"},
        {"resource":"system_settings","action":"execute","raciType":"I"}
      ]'::jsonb;
    WHEN 'it_admin' THEN
      v_role_name := 'it_admin';
      v_description := 'Maintains platform controls, security and system access.';
      v_icon := '🛡️';
      v_rules := '[
        {"resource":"system_settings","action":"execute","raciType":"A"},
        {"resource":"operations_workflows","action":"execute","raciType":"R"},
        {"resource":"inventory","action":"execute","raciType":"C"},
        {"resource":"financial_data","action":"execute","raciType":"I"}
      ]'::jsonb;
    WHEN 'c_suite' THEN
      v_role_name := 'c_suite';
      v_description := 'Executive stakeholders with accountability across key domains.';
      v_icon := '📊';
      v_rules := '[
        {"resource":"financial_data","action":"approve","raciType":"A"},
        {"resource":"operations_workflows","action":"approve","raciType":"A"},
        {"resource":"hr_records","action":"execute","raciType":"I"},
        {"resource":"system_settings","action":"execute","raciType":"C"}
      ]'::jsonb;
    ELSE
      RAISE EXCEPTION 'Unsupported RACI role template';
  END CASE;

  IF trim(COALESCE(p_role_name, '')) <> '' THEN
    v_role_name := lower(trim(p_role_name));
  END IF;

  PERFORM public.upsert_raci_role_management(
    p_role_name := v_role_name,
    p_description := v_description,
    p_icon := v_icon,
    p_member_ids := p_member_ids,
    p_previous_role_name := NULL
  );

  FOR v_rule IN
    SELECT value
    FROM jsonb_array_elements(v_rules)
  LOOP
    PERFORM public.add_raci_rule_resource(
      p_resource_key := COALESCE(v_rule ->> 'resource', ''),
      p_action := COALESCE(v_rule ->> 'action', 'execute'),
      p_category := NULL
    );

    PERFORM public.set_raci_cell(
      p_resource_key := COALESCE(v_rule ->> 'resource', ''),
      p_action := COALESCE(v_rule ->> 'action', 'execute'),
      p_role_name := v_role_name,
      p_raci_type := COALESCE(v_rule ->> 'raciType', '-')
    );

    v_applied := v_applied + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'templateKey', v_template_key,
    'roleName', v_role_name,
    'rulesApplied', v_applied
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.raci_default_role_icon(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_raci_role_templates() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_raci_role_management_payload() TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_raci_role_management(text, text, text, uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_raci_role_template(text, uuid[], text) TO authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'raci_role_members'
  ) THEN
    NULL;
  ELSE
    ALTER PUBLICATION supabase_realtime ADD TABLE public.raci_role_members;
  END IF;
END;
$$;
