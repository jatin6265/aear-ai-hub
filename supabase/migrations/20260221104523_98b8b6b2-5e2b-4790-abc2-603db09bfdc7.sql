
-- Tenants
CREATE TABLE public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  plan text NOT NULL DEFAULT 'starter',
  status text NOT NULL DEFAULT 'trial',
  region text NOT NULL DEFAULT 'us-east',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

-- Profiles
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE,
  full_name text,
  role text NOT NULL DEFAULT 'member',
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- API Connections
CREATE TABLE public.api_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  base_url text,
  status text NOT NULL DEFAULT 'pending',
  schema_detected boolean NOT NULL DEFAULT false,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.api_connections ENABLE ROW LEVEL SECURITY;

-- Chat Sessions
CREATE TABLE public.chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  title text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;

-- Chat Messages
CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES public.chat_sessions(id) ON DELETE CASCADE NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  tool_used text,
  risk_level text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

-- RACI Matrix
CREATE TABLE public.raci_matrix (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
  resource text NOT NULL,
  action text NOT NULL,
  role_name text NOT NULL,
  raci_type text NOT NULL CHECK (raci_type IN ('R','A','C','I'))
);
ALTER TABLE public.raci_matrix ENABLE ROW LEVEL SECURITY;

-- Audit Logs
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  resource text NOT NULL,
  risk_level text,
  status text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Approval Requests
CREATE TABLE public.approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
  requested_by uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  action text NOT NULL,
  resource text NOT NULL,
  params jsonb,
  simulation_preview jsonb,
  risk_level text,
  status text NOT NULL DEFAULT 'pending',
  decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;

-- Subscriptions
CREATE TABLE public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid UNIQUE REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
  plan text NOT NULL DEFAULT 'starter',
  status text NOT NULL DEFAULT 'trial',
  trial_ends_at timestamptz,
  current_period_end timestamptz
);
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Usage Events
CREATE TABLE public.usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
  metric_type text NOT NULL,
  quantity numeric NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;

-- Helper function to get user's tenant_id
CREATE OR REPLACE FUNCTION public.get_user_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM public.profiles WHERE id = auth.uid()
$$;

-- RLS Policies for tenants
CREATE POLICY "Users can view their own tenant" ON public.tenants
  FOR SELECT TO authenticated
  USING (id = public.get_user_tenant_id());

-- RLS Policies for profiles
CREATE POLICY "Users can view profiles in their tenant" ON public.profiles
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Users can update their own profile" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid());

CREATE POLICY "Users can insert their own profile" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());

-- RLS Policies for api_connections
CREATE POLICY "Tenant members can view connections" ON public.api_connections
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can insert connections" ON public.api_connections
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can update connections" ON public.api_connections
  FOR UPDATE TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

-- RLS Policies for chat_sessions
CREATE POLICY "Users can view their sessions" ON public.chat_sessions
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Users can create sessions" ON public.chat_sessions
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.get_user_tenant_id() AND user_id = auth.uid());

-- RLS Policies for chat_messages
CREATE POLICY "Users can view messages in their sessions" ON public.chat_messages
  FOR SELECT TO authenticated
  USING (session_id IN (SELECT id FROM public.chat_sessions WHERE tenant_id = public.get_user_tenant_id()));

CREATE POLICY "Users can insert messages" ON public.chat_messages
  FOR INSERT TO authenticated
  WITH CHECK (session_id IN (SELECT id FROM public.chat_sessions WHERE user_id = auth.uid()));

-- RLS Policies for raci_matrix
CREATE POLICY "Tenant members can view RACI" ON public.raci_matrix
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can manage RACI" ON public.raci_matrix
  FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

-- RLS Policies for audit_logs
CREATE POLICY "Tenant members can view audit logs" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can insert audit logs" ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.get_user_tenant_id());

-- RLS Policies for approval_requests
CREATE POLICY "Tenant members can view approvals" ON public.approval_requests
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can create approvals" ON public.approval_requests
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.get_user_tenant_id() AND requested_by = auth.uid());

CREATE POLICY "Tenant members can update approvals" ON public.approval_requests
  FOR UPDATE TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

-- RLS Policies for subscriptions
CREATE POLICY "Tenant members can view subscription" ON public.subscriptions
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

-- RLS Policies for usage_events
CREATE POLICY "Tenant members can view usage" ON public.usage_events
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can insert usage" ON public.usage_events
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.get_user_tenant_id());

-- Trigger to auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (NEW.id, NEW.raw_user_meta_data ->> 'full_name');
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
