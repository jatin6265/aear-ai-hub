-- Team Invitations
CREATE TABLE public.team_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'manager', 'member', 'viewer')),
  token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.team_invitations ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX team_invitations_tenant_email_key
  ON public.team_invitations (tenant_id, email);

-- RLS Policies for team_invitations
CREATE POLICY "Tenant members can view invitations" ON public.team_invitations
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can create invitations" ON public.team_invitations
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.get_user_tenant_id());
