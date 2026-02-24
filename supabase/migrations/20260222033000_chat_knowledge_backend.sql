-- Chat RAG backend completion: chunk indexing, improved search, and per-session knowledge run persistence.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS public.knowledge_document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.knowledge_documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL DEFAULT 0,
  content text NOT NULL,
  token_count integer NOT NULL DEFAULT 0,
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', COALESCE(content, ''))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

ALTER TABLE public.knowledge_document_chunks ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS knowledge_document_chunks_tenant_doc_idx
  ON public.knowledge_document_chunks (tenant_id, document_id, chunk_index);

CREATE INDEX IF NOT EXISTS knowledge_document_chunks_tsv_idx
  ON public.knowledge_document_chunks USING gin (content_tsv);

CREATE INDEX IF NOT EXISTS knowledge_document_chunks_trgm_idx
  ON public.knowledge_document_chunks USING gin (content gin_trgm_ops);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'knowledge_document_chunks'
      AND policyname = 'Tenant members can view knowledge chunks'
  ) THEN
    CREATE POLICY "Tenant members can view knowledge chunks"
      ON public.knowledge_document_chunks
      FOR SELECT TO authenticated
      USING (tenant_id = public.get_user_tenant_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'knowledge_document_chunks'
      AND policyname = 'Tenant members can insert knowledge chunks'
  ) THEN
    CREATE POLICY "Tenant members can insert knowledge chunks"
      ON public.knowledge_document_chunks
      FOR INSERT TO authenticated
      WITH CHECK (tenant_id = public.get_user_tenant_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'knowledge_document_chunks'
      AND policyname = 'Tenant members can update knowledge chunks'
  ) THEN
    CREATE POLICY "Tenant members can update knowledge chunks"
      ON public.knowledge_document_chunks
      FOR UPDATE TO authenticated
      USING (tenant_id = public.get_user_tenant_id())
      WITH CHECK (tenant_id = public.get_user_tenant_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'knowledge_document_chunks'
      AND policyname = 'Tenant members can delete knowledge chunks'
  ) THEN
    CREATE POLICY "Tenant members can delete knowledge chunks"
      ON public.knowledge_document_chunks
      FOR DELETE TO authenticated
      USING (tenant_id = public.get_user_tenant_id());
  END IF;
END;
$$;

-- Backfill one chunk from current excerpt so search works immediately before documents are re-indexed.
INSERT INTO public.knowledge_document_chunks (
  tenant_id,
  document_id,
  chunk_index,
  content,
  token_count
)
SELECT
  kd.tenant_id,
  kd.id,
  0,
  LEFT(
    regexp_replace(COALESCE(kd.excerpt, kd.title), '\\s+', ' ', 'g'),
    1400
  ) AS content,
  GREATEST(
    1,
    COALESCE(
      array_length(
        regexp_split_to_array(
          LEFT(regexp_replace(COALESCE(kd.excerpt, kd.title), '\\s+', ' ', 'g'), 1400),
          '\\s+'
        ),
        1
      ),
      1
    )
  )::int AS token_count
FROM public.knowledge_documents kd
WHERE kd.status IN ('indexed', 'processing')
  AND COALESCE(NULLIF(trim(kd.excerpt), ''), NULLIF(trim(kd.title), '')) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.knowledge_document_chunks kdc
    WHERE kdc.document_id = kd.id
  );

CREATE TABLE IF NOT EXISTS public.chat_knowledge_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  prompt text NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('High confidence', 'Medium confidence', 'Based on limited data')),
  source_count integer NOT NULL DEFAULT 0,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.chat_knowledge_runs ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS chat_knowledge_runs_tenant_session_created_idx
  ON public.chat_knowledge_runs (tenant_id, session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS chat_knowledge_runs_user_created_idx
  ON public.chat_knowledge_runs (requested_by, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'chat_knowledge_runs'
      AND policyname = 'Users can view knowledge runs in their sessions'
  ) THEN
    CREATE POLICY "Users can view knowledge runs in their sessions"
      ON public.chat_knowledge_runs
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
      AND tablename = 'chat_knowledge_runs'
      AND policyname = 'Users can insert knowledge runs'
  ) THEN
    CREATE POLICY "Users can insert knowledge runs"
      ON public.chat_knowledge_runs
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

CREATE OR REPLACE FUNCTION public.search_knowledge_documents(
  p_query text,
  p_limit int DEFAULT 5
)
RETURNS TABLE (
  id uuid,
  title text,
  file_type text,
  source_type text,
  external_url text,
  storage_path text,
  excerpt text,
  relevance int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH params AS (
    SELECT
      public.get_user_tenant_id() AS tenant_id,
      NULLIF(trim(COALESCE(p_query, '')), '') AS q,
      GREATEST(1, LEAST(COALESCE(p_limit, 5), 10)) AS lim
  ),
  q_ctx AS (
    SELECT
      p.tenant_id,
      p.q,
      p.lim,
      CASE WHEN p.q IS NULL THEN NULL ELSE plainto_tsquery('simple', p.q) END AS tsq
    FROM params p
  ),
  docs AS (
    SELECT
      kd.id,
      kd.tenant_id,
      kd.title,
      kd.file_type,
      kd.source_type,
      kd.external_url,
      kd.storage_path,
      kd.excerpt,
      kd.created_at
    FROM public.knowledge_documents kd
    JOIN q_ctx qc ON qc.tenant_id = kd.tenant_id
    WHERE kd.status = 'indexed'
  ),
  scored AS (
    SELECT
      d.id,
      d.title,
      d.file_type,
      d.source_type,
      d.external_url,
      d.storage_path,
      d.created_at,
      COALESCE(kdc.chunk_index, 0) AS chunk_index,
      COALESCE(NULLIF(trim(kdc.content), ''), NULLIF(trim(d.excerpt), ''), d.title, 'No indexed snippet available yet.') AS candidate_excerpt,
      CASE
        WHEN qc.q IS NULL THEN 50::numeric
        ELSE (
          GREATEST(
            COALESCE(ts_rank_cd(kdc.content_tsv, qc.tsq), 0) * 80,
            COALESCE(similarity(lower(COALESCE(kdc.content, d.excerpt, d.title)), lower(qc.q)), 0) * 100
          )
          + CASE
              WHEN lower(d.title) LIKE '%' || lower(qc.q) || '%' THEN 12
              ELSE 0
            END
        )::numeric
      END AS raw_score,
      CASE
        WHEN qc.q IS NULL THEN true
        ELSE (
          lower(d.title) LIKE '%' || lower(qc.q) || '%'
          OR COALESCE(kdc.content_tsv @@ qc.tsq, false)
          OR COALESCE(similarity(lower(COALESCE(kdc.content, d.excerpt, d.title)), lower(qc.q)), 0) > 0.07
        )
      END AS is_match
    FROM docs d
    JOIN q_ctx qc ON true
    LEFT JOIN public.knowledge_document_chunks kdc
      ON kdc.document_id = d.id
     AND kdc.tenant_id = d.tenant_id
  ),
  ranked AS (
    SELECT
      s.*,
      ROW_NUMBER() OVER (
        PARTITION BY s.id
        ORDER BY s.raw_score DESC, s.chunk_index ASC
      ) AS rn
    FROM scored s
    WHERE s.is_match
  )
  SELECT
    r.id,
    r.title,
    r.file_type,
    r.source_type,
    r.external_url,
    r.storage_path,
    LEFT(regexp_replace(r.candidate_excerpt, '\\s+', ' ', 'g'), 420) AS excerpt,
    LEAST(100, GREATEST(0, ROUND(r.raw_score)::int)) AS relevance
  FROM ranked r
  JOIN q_ctx qc ON true
  WHERE r.rn = 1
  ORDER BY
    CASE WHEN qc.q IS NULL THEN 0 ELSE 1 END DESC,
    r.raw_score DESC,
    r.created_at DESC
  LIMIT (SELECT lim FROM q_ctx LIMIT 1);
$$;

CREATE OR REPLACE FUNCTION public.get_chat_knowledge_runs(
  p_session_id uuid,
  p_limit int DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  prompt text,
  confidence text,
  source_count integer,
  sources jsonb,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    r.id,
    r.prompt,
    r.confidence,
    r.source_count,
    r.sources,
    r.created_at
  FROM public.chat_knowledge_runs r
  JOIN public.chat_sessions s
    ON s.id = r.session_id
  WHERE r.session_id = p_session_id
    AND r.tenant_id = public.get_user_tenant_id()
    AND s.user_id = auth.uid()
  ORDER BY r.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100));
$$;

GRANT EXECUTE ON FUNCTION public.search_knowledge_documents(text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_chat_knowledge_runs(uuid, int) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'knowledge_document_chunks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.knowledge_document_chunks;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'chat_knowledge_runs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_knowledge_runs;
  END IF;
END;
$$;
