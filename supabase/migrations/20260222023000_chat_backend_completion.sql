-- Chat backend completion: session recency, persisted feedback, strict RLS, and helper RPCs.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.chat_sessions
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS chat_sessions_tenant_user_updated_idx
  ON public.chat_sessions (tenant_id, user_id, updated_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx
  ON public.chat_messages (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS chat_messages_session_role_created_idx
  ON public.chat_messages (session_id, role, created_at DESC);

-- Backfill session recency from existing messages.
UPDATE public.chat_sessions s
SET updated_at = COALESCE(
  (
    SELECT MAX(m.created_at)
    FROM public.chat_messages m
    WHERE m.session_id = s.id
  ),
  s.created_at
);

DROP TRIGGER IF EXISTS chat_sessions_set_updated_at ON public.chat_sessions;
CREATE TRIGGER chat_sessions_set_updated_at
BEFORE UPDATE ON public.chat_sessions
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

CREATE OR REPLACE FUNCTION public.on_chat_message_insert_touch_session()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_clean text;
BEGIN
  UPDATE public.chat_sessions
  SET updated_at = GREATEST(COALESCE(updated_at, created_at), NEW.created_at)
  WHERE id = NEW.session_id;

  IF NEW.role = 'user' THEN
    v_clean := btrim(regexp_replace(COALESCE(NEW.content, ''), '\s+', ' ', 'g'));

    IF v_clean <> '' THEN
      UPDATE public.chat_sessions
      SET title = CASE
        WHEN char_length(v_clean) > 54 THEN left(v_clean, 51) || '...'
        ELSE v_clean
      END
      WHERE id = NEW.session_id
        AND (
          title IS NULL
          OR btrim(title) = ''
          OR title = 'New chat'
        );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_messages_touch_session_after_insert ON public.chat_messages;
CREATE TRIGGER chat_messages_touch_session_after_insert
AFTER INSERT ON public.chat_messages
FOR EACH ROW
EXECUTE FUNCTION public.on_chat_message_insert_touch_session();

-- Tighten chat visibility to user-owned sessions only.
DROP POLICY IF EXISTS "Users can view their sessions" ON public.chat_sessions;
CREATE POLICY "Users can view their sessions"
  ON public.chat_sessions
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.get_user_tenant_id()
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS "Users can view messages in their sessions" ON public.chat_messages;
CREATE POLICY "Users can view messages in their sessions"
  ON public.chat_messages
  FOR SELECT TO authenticated
  USING (
    session_id IN (
      SELECT s.id
      FROM public.chat_sessions s
      WHERE s.tenant_id = public.get_user_tenant_id()
        AND s.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can insert messages" ON public.chat_messages;
CREATE POLICY "Users can insert messages"
  ON public.chat_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    session_id IN (
      SELECT s.id
      FROM public.chat_sessions s
      WHERE s.tenant_id = public.get_user_tenant_id()
        AND s.user_id = auth.uid()
    )
  );

CREATE TABLE IF NOT EXISTS public.chat_message_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES public.chat_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feedback text NOT NULL CHECK (feedback IN ('up', 'down')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);

ALTER TABLE public.chat_message_feedback ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS chat_message_feedback_session_idx
  ON public.chat_message_feedback (session_id, user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS chat_message_feedback_tenant_idx
  ON public.chat_message_feedback (tenant_id, user_id, created_at DESC);

DROP TRIGGER IF EXISTS chat_message_feedback_set_updated_at ON public.chat_message_feedback;
CREATE TRIGGER chat_message_feedback_set_updated_at
BEFORE UPDATE ON public.chat_message_feedback
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'chat_message_feedback'
      AND policyname = 'Users can view their chat feedback'
  ) THEN
    CREATE POLICY "Users can view their chat feedback"
      ON public.chat_message_feedback
      FOR SELECT TO authenticated
      USING (
        tenant_id = public.get_user_tenant_id()
        AND user_id = auth.uid()
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
      AND tablename = 'chat_message_feedback'
      AND policyname = 'Users can insert chat feedback'
  ) THEN
    CREATE POLICY "Users can insert chat feedback"
      ON public.chat_message_feedback
      FOR INSERT TO authenticated
      WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        AND user_id = auth.uid()
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
      AND tablename = 'chat_message_feedback'
      AND policyname = 'Users can update chat feedback'
  ) THEN
    CREATE POLICY "Users can update chat feedback"
      ON public.chat_message_feedback
      FOR UPDATE TO authenticated
      USING (
        tenant_id = public.get_user_tenant_id()
        AND user_id = auth.uid()
      )
      WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        AND user_id = auth.uid()
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'chat_message_feedback'
      AND policyname = 'Users can delete chat feedback'
  ) THEN
    CREATE POLICY "Users can delete chat feedback"
      ON public.chat_message_feedback
      FOR DELETE TO authenticated
      USING (
        tenant_id = public.get_user_tenant_id()
        AND user_id = auth.uid()
      );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_chat_sessions(
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  id uuid,
  title text,
  created_at timestamptz,
  updated_at timestamptz,
  last_message_at timestamptz,
  last_message_preview text,
  message_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      s.id,
      COALESCE(NULLIF(btrim(s.title), ''), 'New chat') AS title,
      s.created_at,
      COALESCE(s.updated_at, s.created_at) AS updated_at,
      lm.created_at AS last_message_at,
      COALESCE(lm.preview, '') AS last_message_preview,
      COALESCE(mc.total, 0)::integer AS message_count
    FROM public.chat_sessions s
    LEFT JOIN LATERAL (
      SELECT
        m.created_at,
        LEFT(
          btrim(
            regexp_replace(
              regexp_replace(
                COALESCE(m.content, ''),
                '<!--AEAR_SQL_RESULT:[^>]+-->',
                '',
                'g'
              ),
              '<!--AEAR_KNOWLEDGE_RESULT:[^>]+-->',
              '',
              'g'
            )
          ),
          180
        ) AS preview
      FROM public.chat_messages m
      WHERE m.session_id = s.id
      ORDER BY m.created_at DESC
      LIMIT 1
    ) lm ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS total
      FROM public.chat_messages m
      WHERE m.session_id = s.id
    ) mc ON true
    WHERE s.tenant_id = public.get_user_tenant_id()
      AND s.user_id = auth.uid()
  )
  SELECT
    b.id,
    b.title,
    b.created_at,
    b.updated_at,
    b.last_message_at,
    b.last_message_preview,
    b.message_count
  FROM base b
  WHERE (
    COALESCE(p_search, '') = ''
    OR b.title ILIKE ('%' || p_search || '%')
    OR b.last_message_preview ILIKE ('%' || p_search || '%')
  )
  ORDER BY COALESCE(b.updated_at, b.last_message_at, b.created_at) DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 200));
$$;

CREATE OR REPLACE FUNCTION public.get_chat_context_summary(
  p_session_id uuid
)
RETURNS TABLE (
  active_agents text[],
  queried_source_ids uuid[],
  queried_source_names text[],
  actions_taken integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_allowed boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.chat_sessions s
    WHERE s.id = p_session_id
      AND s.tenant_id = v_tenant_id
      AND s.user_id = auth.uid()
  ) INTO v_allowed;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  RETURN QUERY
  WITH session_messages AS (
    SELECT m.*
    FROM public.chat_messages m
    WHERE m.session_id = p_session_id
  ),
  full_text AS (
    SELECT lower(COALESCE(string_agg(content, ' '), '')) AS full_text
    FROM session_messages
  ),
  matched_sources AS (
    SELECT c.id, c.name
    FROM public.api_connections c, full_text ft
    WHERE c.tenant_id = v_tenant_id
      AND c.is_archived = false
      AND ft.full_text <> ''
      AND position(lower(c.name) in ft.full_text) > 0
    ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC
    LIMIT 4
  ),
  has_data_queries AS (
    SELECT EXISTS (
      SELECT 1
      FROM session_messages m
      WHERE m.content LIKE '%<!--AEAR_SQL_RESULT:%'
         OR m.content LIKE '%<!--AEAR_KNOWLEDGE_RESULT:%'
    ) AS has_data
  ),
  fallback_sources AS (
    SELECT c.id, c.name
    FROM public.api_connections c
    WHERE c.tenant_id = v_tenant_id
      AND c.is_archived = false
    ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC
    LIMIT 4
  ),
  selected_sources AS (
    SELECT id, name
    FROM matched_sources
    UNION ALL
    SELECT f.id, f.name
    FROM fallback_sources f
    WHERE (SELECT COUNT(*) FROM matched_sources) = 0
      AND (SELECT has_data FROM has_data_queries)
  ),
  agent_rollup AS (
    SELECT COALESCE(array_agg(DISTINCT COALESCE(tool_used, 'AEAR Core')), ARRAY[]::text[]) AS active_agents
    FROM session_messages
    WHERE role = 'assistant'
  ),
  action_rollup AS (
    SELECT COUNT(*)::integer AS actions_taken
    FROM session_messages
    WHERE role = 'assistant'
      AND (
        risk_level IS NOT NULL
        OR content LIKE '%<!--AEAR_SQL_RESULT:%'
        OR content LIKE '%<!--AEAR_KNOWLEDGE_RESULT:%'
      )
  )
  SELECT
    COALESCE((SELECT ar.active_agents FROM agent_rollup ar), ARRAY[]::text[]) AS active_agents,
    COALESCE((SELECT array_agg(ss.id) FROM selected_sources ss), ARRAY[]::uuid[]) AS queried_source_ids,
    COALESCE((SELECT array_agg(ss.name) FROM selected_sources ss), ARRAY[]::text[]) AS queried_source_names,
    COALESCE((SELECT ac.actions_taken FROM action_rollup ac), 0) AS actions_taken;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_chat_message_feedback(
  p_message_id uuid,
  p_feedback text DEFAULT NULL
)
RETURNS TABLE (
  message_id uuid,
  feedback text,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_session_id uuid;
  v_feedback text;
  v_updated_at timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT s.id
  INTO v_session_id
  FROM public.chat_messages m
  JOIN public.chat_sessions s ON s.id = m.session_id
  WHERE m.id = p_message_id
    AND s.tenant_id = v_tenant_id
    AND s.user_id = auth.uid()
  LIMIT 1;

  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'Message not found';
  END IF;

  IF p_feedback IS NULL OR btrim(p_feedback) = '' THEN
    DELETE FROM public.chat_message_feedback f
    WHERE f.message_id = p_message_id
      AND f.user_id = auth.uid();

    message_id := p_message_id;
    feedback := NULL;
    updated_at := now();
    RETURN NEXT;
    RETURN;
  END IF;

  v_feedback := lower(btrim(p_feedback));
  IF v_feedback NOT IN ('up', 'down') THEN
    RAISE EXCEPTION 'feedback must be up or down';
  END IF;

  INSERT INTO public.chat_message_feedback (
    tenant_id,
    session_id,
    message_id,
    user_id,
    feedback
  )
  VALUES (
    v_tenant_id,
    v_session_id,
    p_message_id,
    auth.uid(),
    v_feedback
  )
  ON CONFLICT (message_id, user_id)
  DO UPDATE SET
    feedback = EXCLUDED.feedback,
    updated_at = now()
  RETURNING chat_message_feedback.updated_at INTO v_updated_at;

  message_id := p_message_id;
  feedback := v_feedback;
  updated_at := v_updated_at;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_chat_feedback_map(
  p_session_id uuid
)
RETURNS TABLE (
  message_id uuid,
  feedback text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    f.message_id,
    f.feedback
  FROM public.chat_message_feedback f
  JOIN public.chat_sessions s ON s.id = f.session_id
  WHERE f.session_id = p_session_id
    AND s.tenant_id = public.get_user_tenant_id()
    AND s.user_id = auth.uid()
    AND f.user_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.get_chat_sessions(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_chat_context_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_chat_message_feedback(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_chat_feedback_map(uuid) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'chat_sessions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_sessions;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'chat_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'chat_message_feedback'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_message_feedback;
  END IF;
END;
$$;
