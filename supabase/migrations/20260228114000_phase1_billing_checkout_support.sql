-- Phase 1 billing provider abstraction support (Stripe + Razorpay).

CREATE TABLE IF NOT EXISTS public.checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('stripe', 'razorpay')),
  provider_session_id text NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'completed', 'failed', 'expired')),
  amount_cents integer,
  currency text NOT NULL DEFAULT 'usd',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_session_id)
);

ALTER TABLE public.checkout_sessions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS checkout_sessions_tenant_created_idx
  ON public.checkout_sessions (tenant_id, created_at DESC);

DROP POLICY IF EXISTS "Tenant members can view checkout sessions" ON public.checkout_sessions;
CREATE POLICY "Tenant members can view checkout sessions"
  ON public.checkout_sessions FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Tenant members can manage checkout sessions" ON public.checkout_sessions;
CREATE POLICY "Tenant members can manage checkout sessions"
  ON public.checkout_sessions FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id())
  WITH CHECK (tenant_id = public.get_user_tenant_id());

DROP POLICY IF EXISTS "Service role can manage checkout sessions" ON public.checkout_sessions;
CREATE POLICY "Service role can manage checkout sessions"
  ON public.checkout_sessions FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'set_updated_at_timestamp'
      AND pg_function_is_visible(oid)
  ) THEN
    DROP TRIGGER IF EXISTS checkout_sessions_set_updated_at ON public.checkout_sessions;
    CREATE TRIGGER checkout_sessions_set_updated_at
    BEFORE UPDATE ON public.checkout_sessions
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at_timestamp();
  END IF;
END $$;

