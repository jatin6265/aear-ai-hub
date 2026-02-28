-- Backend support for chat SQL result cards: execution persistence + history RPC.

CREATE TABLE IF NOT EXISTS public.chat_sql_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES public.api_connections(id) ON DELETE SET NULL,
  agent text NOT NULL DEFAULT 'OpsAI Core',
  prompt text NOT NULL,
  sql_query text NOT NULL,
  execution_ms integer NOT NULL DEFAULT 0,
  success boolean NOT NULL DEFAULT false,
  error text,
  result_columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  result_rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count integer NOT NULL DEFAULT 0,
  explanation text,
  follow_ups text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.chat_sql_runs ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS chat_sql_runs_tenant_session_created_idx
  ON public.chat_sql_runs (tenant_id, session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS chat_sql_runs_user_created_idx
  ON public.chat_sql_runs (requested_by, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'chat_sql_runs'
      AND policyname = 'Users can view their SQL runs'
  ) THEN
    CREATE POLICY "Users can view their SQL runs"
      ON public.chat_sql_runs
      FOR SELECT TO authenticated
      USING (
        tenant_id = public.get_user_tenant_id()
        AND session_id IN (
          SELECT s.id
          FROM public.chat_sessions s
          WHERE s.tenant_id = public.get_user_tenant_id()
            AND s.user_id = auth.uid()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'chat_sql_runs'
      AND policyname = 'Users can insert SQL runs'
  ) THEN
    CREATE POLICY "Users can insert SQL runs"
      ON public.chat_sql_runs
      FOR INSERT TO authenticated
      WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        AND requested_by = auth.uid()
        AND session_id IN (
          SELECT s.id
          FROM public.chat_sessions s
          WHERE s.tenant_id = public.get_user_tenant_id()
            AND s.user_id = auth.uid()
        )
      );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_chat_sql_runs(
  p_session_id uuid,
  p_limit integer DEFAULT 30
)
RETURNS TABLE (
  id uuid,
  connection_id uuid,
  agent text,
  prompt text,
  sql_query text,
  execution_ms integer,
  success boolean,
  error text,
  row_count integer,
  explanation text,
  follow_ups text[],
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    r.id,
    r.connection_id,
    r.agent,
    r.prompt,
    r.sql_query,
    r.execution_ms,
    r.success,
    r.error,
    r.row_count,
    r.explanation,
    r.follow_ups,
    r.created_at
  FROM public.chat_sql_runs r
  JOIN public.chat_sessions s ON s.id = r.session_id
  WHERE r.session_id = p_session_id
    AND r.tenant_id = public.get_user_tenant_id()
    AND s.user_id = auth.uid()
  ORDER BY r.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 100));
$$;

GRANT EXECUTE ON FUNCTION public.get_chat_sql_runs(uuid, integer) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'chat_sql_runs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_sql_runs;
  END IF;
END;
$$;
