CREATE OR REPLACE FUNCTION public.save_onboarding_company_setup(
  p_name text,
  p_region text,
  p_industry text DEFAULT NULL,
  p_company_size text DEFAULT NULL,
  p_primary_use_case text DEFAULT NULL,
  p_logo_url text DEFAULT NULL
)
RETURNS TABLE (
  tenant_id uuid,
  name text,
  region text,
  industry text,
  company_size text,
  primary_use_case text,
  logo_url text,
  onboarding_step smallint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_tenant_id uuid := public.get_user_tenant_id();
  v_saved_tenant_id uuid;
  v_saved_name text;
  v_saved_region text;
  v_saved_industry text;
  v_saved_company_size text;
  v_saved_primary_use_case text;
  v_saved_logo_url text;
  v_saved_onboarding_step smallint;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_user_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Workspace not provisioned for current user';
  END IF;

  UPDATE public.tenants AS t
  SET
    name = COALESCE(NULLIF(trim(p_name), ''), t.name),
    region = COALESCE(NULLIF(trim(p_region), ''), t.region),
    industry = COALESCE(NULLIF(trim(p_industry), ''), t.industry),
    company_size = COALESCE(NULLIF(trim(p_company_size), ''), t.company_size),
    primary_use_case = COALESCE(NULLIF(trim(p_primary_use_case), ''), t.primary_use_case),
    logo_url = COALESCE(NULLIF(trim(p_logo_url), ''), t.logo_url),
    onboarding_step = GREATEST(COALESCE(t.onboarding_step, 1), 2),
    updated_at = now()
  WHERE t.id = v_user_tenant_id
  RETURNING
    t.id,
    t.name,
    t.region,
    t.industry,
    t.company_size,
    t.primary_use_case,
    t.logo_url,
    t.onboarding_step
  INTO
    v_saved_tenant_id,
    v_saved_name,
    v_saved_region,
    v_saved_industry,
    v_saved_company_size,
    v_saved_primary_use_case,
    v_saved_logo_url,
    v_saved_onboarding_step;

  IF v_saved_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant row not found for current user';
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_saved_tenant_id,
    auth.uid(),
    'tenant.company_setup.update',
    'tenant',
    'success',
    jsonb_build_object(
      'industry', v_saved_industry,
      'company_size', v_saved_company_size,
      'primary_use_case', v_saved_primary_use_case,
      'region', v_saved_region
    )
  );

  RETURN QUERY
  SELECT
    v_saved_tenant_id,
    v_saved_name,
    v_saved_region,
    v_saved_industry,
    v_saved_company_size,
    v_saved_primary_use_case,
    v_saved_logo_url,
    v_saved_onboarding_step;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_onboarding_company_setup(text, text, text, text, text, text) TO authenticated;
