-- Prompt 1/3 backend hardening: profile metadata + provisioning RPCs
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.set_updated_at_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_set_updated_at ON public.profiles;
CREATE TRIGGER profiles_set_updated_at
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

CREATE OR REPLACE FUNCTION public.provision_user_workspace(
  p_company_name text DEFAULT NULL,
  p_full_name text DEFAULT NULL,
  p_terms_accepted boolean DEFAULT false
)
RETURNS TABLE (
  tenant_id uuid,
  role text,
  full_name text,
  tenant_name text,
  tenant_status text,
  tenant_plan text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_email text;
  v_domain_label text;
  v_company text;
  v_full_name text;
  v_base_slug text;
  v_slug text;
  v_tenant_id uuid;
  v_role text;
  v_tenant_name text;
  v_tenant_status text;
  v_tenant_plan text;
  v_attempt int := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  v_full_name := NULLIF(trim(COALESCE(p_full_name, '')), '');

  SELECT email INTO v_email
  FROM auth.users
  WHERE id = v_user_id;

  v_domain_label := split_part(split_part(COALESCE(v_email, ''), '@', 2), '.', 1);
  v_company := NULLIF(trim(COALESCE(p_company_name, '')), '');

  IF v_company IS NULL THEN
    v_company := initcap(replace(replace(NULLIF(v_domain_label, ''), '-', ' '), '_', ' '));
  END IF;

  IF v_company IS NULL THEN
    v_company := 'New Workspace';
  END IF;

  INSERT INTO public.profiles (id, full_name, role)
  VALUES (v_user_id, v_full_name, 'owner')
  ON CONFLICT (id) DO NOTHING;

  SELECT p.tenant_id, p.role
  INTO v_tenant_id, v_role
  FROM public.profiles p
  WHERE p.id = v_user_id
  FOR UPDATE;

  IF v_tenant_id IS NULL THEN
    v_base_slug := lower(regexp_replace(v_company, '[^a-zA-Z0-9]+', '-', 'g'));
    v_base_slug := regexp_replace(v_base_slug, '(^-+|-+$)', '', 'g');

    IF v_base_slug = '' THEN
      v_base_slug := 'workspace';
    END IF;

    LOOP
      v_slug := v_base_slug || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 6);
      BEGIN
        INSERT INTO public.tenants (name, slug)
        VALUES (v_company, v_slug)
        RETURNING id, name, status, plan
        INTO v_tenant_id, v_tenant_name, v_tenant_status, v_tenant_plan;

        EXIT;
      EXCEPTION
        WHEN unique_violation THEN
          v_attempt := v_attempt + 1;
          IF v_attempt > 20 THEN
            RAISE EXCEPTION 'Unable to generate unique workspace slug';
          END IF;
      END;
    END LOOP;

    INSERT INTO public.subscriptions (tenant_id, plan, status, trial_ends_at)
    VALUES (v_tenant_id, 'starter', 'trial', now() + interval '14 days')
    ON CONFLICT (tenant_id) DO NOTHING;

    UPDATE public.profiles
    SET
      tenant_id = v_tenant_id,
      role = 'owner',
      full_name = COALESCE(v_full_name, full_name),
      terms_accepted_at = COALESCE(terms_accepted_at, CASE WHEN p_terms_accepted THEN now() ELSE NULL END)
    WHERE id = v_user_id
    RETURNING role, full_name
    INTO v_role, full_name;

    tenant_id := v_tenant_id;
    tenant_name := v_tenant_name;
    tenant_status := v_tenant_status;
    tenant_plan := v_tenant_plan;
    role := v_role;
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE public.profiles
  SET
    full_name = COALESCE(v_full_name, full_name),
    terms_accepted_at = COALESCE(terms_accepted_at, CASE WHEN p_terms_accepted THEN now() ELSE NULL END)
  WHERE id = v_user_id
  RETURNING role, full_name
  INTO v_role, full_name;

  SELECT t.name, t.status, t.plan
  INTO v_tenant_name, v_tenant_status, v_tenant_plan
  FROM public.tenants t
  WHERE t.id = v_tenant_id;

  tenant_id := v_tenant_id;
  tenant_name := v_tenant_name;
  tenant_status := v_tenant_status;
  tenant_plan := v_tenant_plan;
  role := v_role;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.provision_user_workspace(text, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_user_bootstrap()
RETURNS TABLE (
  tenant_id uuid,
  role text,
  tenant_name text,
  tenant_status text,
  tenant_plan text,
  has_connections boolean,
  requires_onboarding boolean,
  terms_accepted boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.tenant_id,
    p.role,
    t.name,
    t.status,
    t.plan,
    EXISTS (
      SELECT 1 FROM public.api_connections c WHERE c.tenant_id = p.tenant_id
    ) AS has_connections,
    NOT EXISTS (
      SELECT 1 FROM public.api_connections c WHERE c.tenant_id = p.tenant_id
    ) AS requires_onboarding,
    p.terms_accepted_at IS NOT NULL AS terms_accepted
  FROM public.profiles p
  JOIN public.tenants t ON t.id = p.tenant_id
  WHERE p.id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.get_user_bootstrap() TO authenticated;
