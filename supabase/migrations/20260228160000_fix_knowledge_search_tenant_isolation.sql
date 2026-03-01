-- Fix: search_knowledge_documents_hybrid — add explicit p_tenant_id parameter.
--
-- The original function used get_user_tenant_id() which returns NULL when called
-- from service_role context (connector worker). This caused the tenant JOIN to
-- produce an empty result set on every worker-side fallback retrieval call.
--
-- This migration replaces the function with an identical version that accepts an
-- optional p_tenant_id uuid. When provided it is used directly; when NULL it falls
-- back to get_user_tenant_id() for backward-compat with authenticated client calls.
--
-- The retriever.ts searchKnowledgeFallback path already passes p_query_embedding;
-- it must now also pass p_tenant_id (handled in companion code change).

CREATE OR REPLACE FUNCTION public.search_knowledge_documents_hybrid(
  p_query text,
  p_query_embedding vector(1536) DEFAULT NULL,
  p_limit int DEFAULT 5,
  p_vector_weight numeric DEFAULT 0.65,
  p_lexical_weight numeric DEFAULT 0.35,
  p_tenant_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  title text,
  file_type text,
  source_type text,
  external_url text,
  storage_path text,
  excerpt text,
  relevance int,
  score_breakdown jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH params AS (
    SELECT
      COALESCE(p_tenant_id, public.get_user_tenant_id()) AS tenant_id,
      NULLIF(trim(COALESCE(p_query, '')), '') AS q,
      GREATEST(1, LEAST(COALESCE(p_limit, 5), 20)) AS lim,
      LEAST(1, GREATEST(0, COALESCE(p_vector_weight, 0.65))) AS vector_w,
      LEAST(1, GREATEST(0, COALESCE(p_lexical_weight, 0.35))) AS lexical_w
  ),
  q_ctx AS (
    SELECT
      p.tenant_id,
      p.q,
      p.lim,
      p.vector_w,
      p.lexical_w,
      CASE WHEN p.q IS NULL THEN NULL ELSE plainto_tsquery('simple', p.q) END AS tsq
    FROM params p
    -- Guard: if tenant_id resolved to NULL, return nothing (both for safety and correctness).
    WHERE p.tenant_id IS NOT NULL
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
        WHEN qc.q IS NULL THEN 0.5::numeric
        ELSE GREATEST(
          COALESCE(ts_rank_cd(kdc.content_tsv, qc.tsq), 0),
          COALESCE(similarity(lower(COALESCE(kdc.content, d.excerpt, d.title)), lower(qc.q)), 0)
        )
      END AS lexical_score,
      CASE
        WHEN p_query_embedding IS NULL OR kdc.embedding IS NULL THEN 0::numeric
        ELSE (1 - (kdc.embedding <=> p_query_embedding))::numeric
      END AS vector_score,
      qc.vector_w,
      qc.lexical_w,
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
      (COALESCE(s.vector_score, 0) * s.vector_w + COALESCE(s.lexical_score, 0) * s.lexical_w) AS hybrid_score,
      ROW_NUMBER() OVER (
        PARTITION BY s.id
        ORDER BY
          (COALESCE(s.vector_score, 0) * s.vector_w + COALESCE(s.lexical_score, 0) * s.lexical_w) DESC,
          s.chunk_index ASC
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
    LEFT(regexp_replace(r.candidate_excerpt, '\s+', ' ', 'g'), 420) AS excerpt,
    LEAST(100, GREATEST(0, ROUND(r.hybrid_score * 100)::int)) AS relevance,
    jsonb_build_object(
      'hybrid', ROUND(r.hybrid_score::numeric, 6),
      'vector', ROUND(COALESCE(r.vector_score, 0)::numeric, 6),
      'lexical', ROUND(COALESCE(r.lexical_score, 0)::numeric, 6),
      'weights', jsonb_build_object('vector', r.vector_w, 'lexical', r.lexical_w)
    ) AS score_breakdown
  FROM ranked r
  WHERE r.rn = 1
  ORDER BY r.hybrid_score DESC, r.created_at DESC
  LIMIT (SELECT lim FROM q_ctx LIMIT 1);
$$;

-- Grant to both authenticated users and service_role explicitly.
GRANT EXECUTE ON FUNCTION public.search_knowledge_documents_hybrid(text, vector, int, numeric, numeric, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_knowledge_documents_hybrid(text, vector, int, numeric, numeric, uuid) TO service_role;
