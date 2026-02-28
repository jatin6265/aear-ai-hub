-- Phase 1 hybrid memory search contract.
-- Provides doc-aligned `hybrid_search(query_embedding, tenant_id, match_count, similarity_threshold)`
-- with optional query text for lexical scoring.

CREATE INDEX IF NOT EXISTS embeddings_content_tsv_idx
  ON public.embeddings
  USING gin (to_tsvector('simple', coalesce(content, '')));

CREATE INDEX IF NOT EXISTS context_events_content_tsv_idx
  ON public.context_events
  USING gin (to_tsvector('simple', coalesce(content, '')));

CREATE OR REPLACE FUNCTION public.hybrid_search(
  p_query_embedding vector(1536),
  p_tenant_id uuid DEFAULT NULL,
  p_match_count int DEFAULT 10,
  p_similarity_threshold numeric DEFAULT 0.45,
  p_query_text text DEFAULT NULL
)
RETURNS TABLE (
  content text,
  metadata jsonb,
  similarity numeric,
  source_kind text,
  source_id text,
  occurred_at timestamptz,
  keyword_score numeric,
  recency_score numeric,
  final_score numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH args AS (
    SELECT
      COALESCE(p_tenant_id, public.get_user_tenant_id()) AS tenant_id,
      GREATEST(1, LEAST(COALESCE(p_match_count, 10), 50)) AS lim,
      LEAST(1, GREATEST(0, COALESCE(p_similarity_threshold, 0.45))) AS min_similarity,
      NULLIF(trim(COALESCE(p_query_text, '')), '') AS q,
      CASE
        WHEN NULLIF(trim(COALESCE(p_query_text, '')), '') IS NULL THEN NULL
        ELSE plainto_tsquery('simple', trim(COALESCE(p_query_text, '')))
      END AS tsq
  ),
  semantic_hits AS (
    SELECT
      e.content,
      e.metadata,
      COALESCE(
        CASE
          WHEN p_query_embedding IS NULL OR e.embedding IS NULL THEN 0::numeric
          ELSE (1 - (e.embedding <=> p_query_embedding))::numeric
        END,
        0::numeric
      ) AS similarity,
      e.source_kind,
      COALESCE(e.source_id, e.id::text) AS source_id,
      e.created_at AS occurred_at,
      COALESCE(
        CASE
          WHEN a.tsq IS NULL THEN 0::numeric
          ELSE ts_rank_cd(to_tsvector('simple', coalesce(e.content, '')), a.tsq)::numeric
        END,
        0::numeric
      ) AS keyword_score,
      (1 / (1 + GREATEST(0, EXTRACT(EPOCH FROM (now() - e.created_at)) / 86400 / 3)))::numeric AS recency_score
    FROM public.embeddings e
    JOIN args a ON a.tenant_id = e.tenant_id
    WHERE
      (
        p_query_embedding IS NULL
        OR e.embedding IS NULL
        OR (1 - (e.embedding <=> p_query_embedding))::numeric >= a.min_similarity
      )
      AND (
        a.q IS NULL
        OR coalesce(e.content, '') ILIKE '%' || a.q || '%'
        OR to_tsvector('simple', coalesce(e.content, '')) @@ a.tsq
      )
  ),
  timeline_hits AS (
    SELECT
      ce.content,
      ce.metadata || jsonb_build_object('event_type', ce.event_type, 'source_type', ce.source_type) AS metadata,
      COALESCE(
        CASE
          WHEN a.q IS NULL THEN 0.35::numeric
          WHEN coalesce(ce.content, '') ILIKE '%' || a.q || '%' THEN 0.55::numeric
          ELSE 0.25::numeric
        END,
        0.25::numeric
      ) AS similarity,
      COALESCE(ce.source_type, 'event') AS source_kind,
      COALESCE(ce.source_id, ce.id::text) AS source_id,
      ce.occurred_at,
      COALESCE(
        CASE
          WHEN a.tsq IS NULL THEN 0::numeric
          ELSE ts_rank_cd(to_tsvector('simple', coalesce(ce.content, '')), a.tsq)::numeric
        END,
        0::numeric
      ) AS keyword_score,
      (1 / (1 + GREATEST(0, EXTRACT(EPOCH FROM (now() - ce.occurred_at)) / 86400 / 3)))::numeric AS recency_score
    FROM public.context_events ce
    JOIN args a ON a.tenant_id = ce.tenant_id
    WHERE (
      a.q IS NULL
      OR coalesce(ce.content, '') ILIKE '%' || a.q || '%'
      OR to_tsvector('simple', coalesce(ce.content, '')) @@ a.tsq
    )
  ),
  combined AS (
    SELECT * FROM semantic_hits
    UNION ALL
    SELECT * FROM timeline_hits
  )
  SELECT
    c.content,
    c.metadata,
    c.similarity,
    c.source_kind,
    c.source_id,
    c.occurred_at,
    c.keyword_score,
    c.recency_score,
    (0.65 * c.similarity + 0.25 * LEAST(1, c.keyword_score) + 0.10 * c.recency_score)::numeric AS final_score
  FROM combined c
  ORDER BY final_score DESC, c.occurred_at DESC NULLS LAST
  LIMIT (SELECT lim FROM args);
$$;

GRANT EXECUTE ON FUNCTION public.hybrid_search(vector, uuid, int, numeric, text) TO authenticated, service_role;
