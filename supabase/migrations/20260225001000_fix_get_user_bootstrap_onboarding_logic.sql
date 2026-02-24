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
    (
      COALESCE(t.onboarding_step, 1) < 4
      AND t.onboarding_completed_at IS NULL
    ) AS requires_onboarding,
    p.terms_accepted_at IS NOT NULL AS terms_accepted
  FROM public.profiles p
  JOIN public.tenants t ON t.id = p.tenant_id
  WHERE p.id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.get_user_bootstrap() TO authenticated;
