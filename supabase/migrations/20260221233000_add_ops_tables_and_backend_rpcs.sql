-- Operational backend coverage for remaining dashboard modules.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------
-- Access policy fixes for existing flows
-- ----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tenants'
      AND policyname = 'Tenant members can update tenant settings'
  ) THEN
    CREATE POLICY "Tenant members can update tenant settings"
      ON public.tenants
      FOR UPDATE TO authenticated
      USING (id = public.get_user_tenant_id())
      WITH CHECK (id = public.get_user_tenant_id());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'api_connections'
      AND policyname = 'Tenant members can delete connections'
  ) THEN
    CREATE POLICY "Tenant members can delete connections"
      ON public.api_connections
      FOR DELETE TO authenticated
      USING (tenant_id = public.get_user_tenant_id());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'chat_sessions'
      AND policyname = 'Users can update their sessions'
  ) THEN
    CREATE POLICY "Users can update their sessions"
      ON public.chat_sessions
      FOR UPDATE TO authenticated
      USING (tenant_id = public.get_user_tenant_id() AND user_id = auth.uid())
      WITH CHECK (tenant_id = public.get_user_tenant_id() AND user_id = auth.uid());
  END IF;
END;
$$;

-- ----------------------------------------
-- New tables
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS public.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_prefix text NOT NULL,
  key_hash text NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY['read'],
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key_prefix),
  UNIQUE (key_hash)
);
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.guardrails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  enabled boolean NOT NULL DEFAULT true,
  risk_level text NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
ALTER TABLE public.guardrails ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text,
  kind text NOT NULL DEFAULT 'info',
  link text,
  is_read boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS api_keys_tenant_created_idx
  ON public.api_keys (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS guardrails_tenant_enabled_idx
  ON public.guardrails (tenant_id, enabled);

CREATE INDEX IF NOT EXISTS notifications_tenant_read_idx
  ON public.notifications (tenant_id, is_read, created_at DESC);

DROP TRIGGER IF EXISTS guardrails_set_updated_at ON public.guardrails;
CREATE TRIGGER guardrails_set_updated_at
BEFORE UPDATE ON public.guardrails
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

-- ----------------------------------------
-- RLS for new tables
-- ----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'api_keys' AND policyname = 'Tenant members can view api keys'
  ) THEN
    CREATE POLICY "Tenant members can view api keys"
      ON public.api_keys
      FOR SELECT TO authenticated
      USING (tenant_id = public.get_user_tenant_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'api_keys' AND policyname = 'Tenant members can manage api keys'
  ) THEN
    CREATE POLICY "Tenant members can manage api keys"
      ON public.api_keys
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
    WHERE schemaname = 'public' AND tablename = 'guardrails' AND policyname = 'Tenant members can view guardrails'
  ) THEN
    CREATE POLICY "Tenant members can view guardrails"
      ON public.guardrails
      FOR SELECT TO authenticated
      USING (tenant_id = public.get_user_tenant_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'guardrails' AND policyname = 'Tenant members can manage guardrails'
  ) THEN
    CREATE POLICY "Tenant members can manage guardrails"
      ON public.guardrails
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
    WHERE schemaname = 'public' AND tablename = 'notifications' AND policyname = 'Tenant members can view notifications'
  ) THEN
    CREATE POLICY "Tenant members can view notifications"
      ON public.notifications
      FOR SELECT TO authenticated
      USING (
        tenant_id = public.get_user_tenant_id()
        AND (user_id IS NULL OR user_id = auth.uid())
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'notifications' AND policyname = 'Tenant members can update notifications'
  ) THEN
    CREATE POLICY "Tenant members can update notifications"
      ON public.notifications
      FOR UPDATE TO authenticated
      USING (
        tenant_id = public.get_user_tenant_id()
        AND (user_id IS NULL OR user_id = auth.uid())
      )
      WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        AND (user_id IS NULL OR user_id = auth.uid())
      );
  END IF;
END;
$$;

-- ----------------------------------------
-- RPCs for API keys, guardrails, approvals, nav counts
-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.seed_default_guardrails(p_tenant_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer := 0;
BEGIN
  INSERT INTO public.guardrails (
    tenant_id,
    code,
    name,
    description,
    enabled,
    risk_level,
    config,
    created_by
  )
  VALUES
    (
      p_tenant_id,
      'destructive_write',
      'Block destructive actions by default',
      'DELETE and force-update actions require explicit approval.',
      true,
      'critical',
      jsonb_build_object('requires_approval', true, 'blocked_actions', ARRAY['delete', 'truncate', 'drop']),
      auth.uid()
    ),
    (
      p_tenant_id,
      'pii_export',
      'Prevent PII exports',
      'Masks sensitive fields in bulk exports and analytics jobs.',
      true,
      'high',
      jsonb_build_object('mask_fields', true),
      auth.uid()
    ),
    (
      p_tenant_id,
      'off_hours',
      'Restrict off-hours automation',
      'Critical workflows pause outside approved business windows.',
      true,
      'medium',
      jsonb_build_object('window', '09:00-18:00', 'timezone', 'UTC'),
      auth.uid()
    )
  ON CONFLICT (tenant_id, code) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_guardrails()
RETURNS TABLE (
  id uuid,
  code text,
  name text,
  description text,
  enabled boolean,
  risk_level text,
  config jsonb,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.guardrails g
  WHERE g.tenant_id = v_tenant_id;

  IF v_count = 0 THEN
    PERFORM public.seed_default_guardrails(v_tenant_id);
  END IF;

  RETURN QUERY
    SELECT
      g.id,
      g.code,
      g.name,
      g.description,
      g.enabled,
      g.risk_level,
      g.config,
      g.updated_at
    FROM public.guardrails g
    WHERE g.tenant_id = v_tenant_id
    ORDER BY g.created_at ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_guardrail_enabled(
  p_guardrail_id uuid,
  p_enabled boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_updated integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  UPDATE public.guardrails
  SET enabled = p_enabled
  WHERE id = p_guardrail_id
    AND tenant_id = v_tenant_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated > 0 THEN
    INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
    VALUES (
      v_tenant_id,
      auth.uid(),
      'guardrail.toggle',
      'guardrails',
      'success',
      jsonb_build_object('guardrail_id', p_guardrail_id, 'enabled', p_enabled)
    );
  END IF;

  RETURN v_updated > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_api_key(
  p_name text,
  p_scopes text[] DEFAULT ARRAY['read']
)
RETURNS TABLE (
  id uuid,
  plain_key text,
  key_prefix text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_plain_key text;
  v_hash text;
  v_id uuid;
  v_created_at timestamptz;
  v_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  v_name := NULLIF(trim(COALESCE(p_name, '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Key name is required';
  END IF;

  v_plain_key := 'opsai_' || encode(gen_random_bytes(24), 'hex');
  key_prefix := left(v_plain_key, 16);
  v_hash := encode(digest(v_plain_key, 'sha256'), 'hex');

  INSERT INTO public.api_keys (
    tenant_id,
    name,
    key_prefix,
    key_hash,
    scopes,
    created_by
  )
  VALUES (
    v_tenant_id,
    v_name,
    key_prefix,
    v_hash,
    COALESCE(p_scopes, ARRAY['read']),
    auth.uid()
  )
  RETURNING api_keys.id, api_keys.created_at
  INTO v_id, v_created_at;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'api_key.create',
    v_name,
    'success',
    jsonb_build_object('key_id', v_id, 'scopes', p_scopes)
  );

  id := v_id;
  plain_key := v_plain_key;
  created_at := v_created_at;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_api_key(p_key_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_name text;
  v_updated integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  UPDATE public.api_keys
  SET revoked_at = COALESCE(revoked_at, now())
  WHERE id = p_key_id
    AND tenant_id = v_tenant_id
  RETURNING name INTO v_name;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated > 0 THEN
    INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
    VALUES (
      v_tenant_id,
      auth.uid(),
      'api_key.revoke',
      COALESCE(v_name, 'api_key'),
      'success',
      jsonb_build_object('key_id', p_key_id)
    );
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.decide_approval_request(
  p_request_id uuid,
  p_decision text
)
RETURNS TABLE (
  status text,
  decided_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_new_status text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  v_new_status := lower(trim(COALESCE(p_decision, '')));
  IF v_new_status NOT IN ('approved', 'denied') THEN
    RAISE EXCEPTION 'Decision must be approved or denied';
  END IF;

  UPDATE public.approval_requests ar
  SET
    status = v_new_status,
    decided_by = auth.uid(),
    decided_at = now()
  WHERE ar.id = p_request_id
    AND ar.tenant_id = v_tenant_id
    AND ar.status = 'pending'
  RETURNING ar.status, ar.decided_at
  INTO status, decided_at;

  IF status IS NULL THEN
    RAISE EXCEPTION 'Approval request not found or already decided';
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'approval.decide',
    'approval_requests',
    status,
    jsonb_build_object('request_id', p_request_id)
  );

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_nav_counts()
RETURNS TABLE (
  pending_approvals integer,
  unread_notifications integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT public.get_user_tenant_id() AS tenant_id
  )
  SELECT
    (
      SELECT COUNT(*)::int
      FROM public.approval_requests ar
      JOIN me ON me.tenant_id = ar.tenant_id
      WHERE ar.status = 'pending'
    ) AS pending_approvals,
    (
      SELECT COUNT(*)::int
      FROM public.notifications n
      JOIN me ON me.tenant_id = n.tenant_id
      WHERE n.is_read = false
        AND (n.user_id IS NULL OR n.user_id = auth.uid())
    ) AS unread_notifications;
$$;

GRANT EXECUTE ON FUNCTION public.seed_default_guardrails(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_guardrails() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_guardrail_enabled(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_api_key(text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_api_key(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_approval_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_nav_counts() TO authenticated;
