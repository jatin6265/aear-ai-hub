-- API keys management backend for /dashboard/api-keys.

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'production',
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'api_keys_environment_check'
      AND conrelid = 'public.api_keys'::regclass
  ) THEN
    ALTER TABLE public.api_keys
      ADD CONSTRAINT api_keys_environment_check
      CHECK (environment IN ('production', 'development', 'testing'));
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.api_key_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  api_key_id uuid NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  method text NOT NULL,
  response_status integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.api_key_usage_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS api_key_usage_events_key_created_idx
  ON public.api_key_usage_events (api_key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS api_key_usage_events_tenant_created_idx
  ON public.api_key_usage_events (tenant_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'api_key_usage_events'
      AND policyname = 'Tenant members can view api key usage events'
  ) THEN
    CREATE POLICY "Tenant members can view api key usage events"
      ON public.api_key_usage_events
      FOR SELECT TO authenticated
      USING (tenant_id = public.get_user_tenant_id());
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_api_key_v2(
  p_name text,
  p_scopes text[] DEFAULT ARRAY['read'],
  p_environment text DEFAULT 'production',
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  plain_key text,
  key_prefix text,
  created_at timestamptz,
  environment text,
  expires_at timestamptz,
  scopes text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_name text;
  v_environment text := lower(trim(COALESCE(p_environment, 'production')));
  v_scope text;
  v_scopes text[] := ARRAY[]::text[];
  v_plain_key text;
  v_hash text;
  v_id uuid;
  v_created_at timestamptz;
  v_env_token text;
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

  IF v_environment NOT IN ('production', 'development', 'testing') THEN
    RAISE EXCEPTION 'Environment must be production, development, or testing';
  END IF;

  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'Expiry must be in the future';
  END IF;

  FOREACH v_scope IN ARRAY COALESCE(p_scopes, ARRAY['read']) LOOP
    v_scope := lower(trim(COALESCE(v_scope, '')));
    IF v_scope = '' THEN
      CONTINUE;
    END IF;
    IF v_scope NOT IN ('read', 'write', 'admin', 'billing') THEN
      RAISE EXCEPTION 'Invalid scope: %', v_scope;
    END IF;
    IF NOT (v_scope = ANY (v_scopes)) THEN
      v_scopes := array_append(v_scopes, v_scope);
    END IF;
  END LOOP;

  IF array_length(v_scopes, 1) IS NULL THEN
    v_scopes := ARRAY['read'];
  END IF;

  v_env_token := CASE v_environment
    WHEN 'production' THEN 'live'
    WHEN 'development' THEN 'dev'
    ELSE 'test'
  END;

  v_plain_key := format('ak_%s_%s', v_env_token, encode(gen_random_bytes(24), 'hex'));
  key_prefix := left(v_plain_key, 16);
  v_hash := encode(digest(v_plain_key, 'sha256'), 'hex');

  INSERT INTO public.api_keys (
    tenant_id,
    name,
    key_prefix,
    key_hash,
    scopes,
    created_by,
    environment,
    expires_at
  )
  VALUES (
    v_tenant_id,
    v_name,
    key_prefix,
    v_hash,
    v_scopes,
    auth.uid(),
    v_environment,
    p_expires_at
  )
  RETURNING api_keys.id, api_keys.created_at
  INTO v_id, v_created_at;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'api_key.create.v2',
    v_name,
    'success',
    jsonb_build_object(
      'key_id', v_id,
      'environment', v_environment,
      'scopes', v_scopes,
      'expires_at', p_expires_at
    )
  );

  id := v_id;
  plain_key := v_plain_key;
  created_at := v_created_at;
  environment := v_environment;
  expires_at := p_expires_at;
  scopes := v_scopes;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_api_keys_management_payload()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role text := 'member';
  v_can_manage boolean := false;
  v_keys jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  SELECT lower(COALESCE(p.role, 'member'))
  INTO v_role
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.tenant_id = v_tenant_id
  LIMIT 1;

  v_can_manage := v_role IN ('owner', 'admin');

  WITH usage_stats AS (
    SELECT
      e.api_key_id,
      COUNT(*)::integer AS requests_total,
      COUNT(*) FILTER (WHERE e.created_at >= date_trunc('day', now()))::integer AS requests_today,
      COALESCE(
        array_agg(DISTINCT e.endpoint ORDER BY e.endpoint)
          FILTER (WHERE e.endpoint IS NOT NULL AND e.endpoint <> ''),
        ARRAY[]::text[]
      ) AS endpoints_called
    FROM public.api_key_usage_events e
    WHERE e.tenant_id = v_tenant_id
    GROUP BY e.api_key_id
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', k.id,
        'name', k.name,
        'prefix', k.key_prefix,
        'scopes', COALESCE(k.scopes, ARRAY[]::text[]),
        'environment', COALESCE(k.environment, 'production'),
        'createdAt', k.created_at,
        'lastUsedAt', k.last_used_at,
        'expiresAt', k.expires_at,
        'revokedAt', k.revoked_at,
        'status',
          CASE
            WHEN k.revoked_at IS NOT NULL THEN 'revoked'
            WHEN k.expires_at IS NOT NULL AND k.expires_at <= now() THEN 'revoked'
            ELSE 'active'
          END,
        'usage', jsonb_build_object(
          'requestsToday', COALESCE(u.requests_today, 0),
          'requestsTotal', COALESCE(u.requests_total, 0),
          'endpointsCalled', COALESCE(u.endpoints_called, ARRAY[]::text[])
        )
      )
      ORDER BY k.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_keys
  FROM public.api_keys k
  LEFT JOIN usage_stats u ON u.api_key_id = k.id
  WHERE k.tenant_id = v_tenant_id;

  RETURN jsonb_build_object(
    'profileRole', v_role,
    'canManage', v_can_manage,
    'keys', v_keys
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_api_key_v2(text, text[], text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_api_keys_management_payload() TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'api_key_usage_events'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.api_key_usage_events';
  END IF;
END;
$$;
