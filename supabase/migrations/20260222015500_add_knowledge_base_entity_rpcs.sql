-- Knowledge Base backend RPCs for entity search, stats, and recent query feed.

CREATE OR REPLACE FUNCTION public.get_knowledge_entities(
  p_query text DEFAULT NULL,
  p_filter text DEFAULT 'all',
  p_limit int DEFAULT 200
)
RETURNS TABLE (
  entity_id uuid,
  connection_id uuid,
  connection_name text,
  entity_name text,
  entity_group text,
  description text,
  key_fields text[],
  sensitivity text,
  row_count bigint,
  last_updated timestamptz,
  embedding_coverage numeric,
  source_kind text,
  relationship_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT public.get_user_tenant_id() AS tenant_id
  ),
  normalized AS (
    SELECT
      lower(COALESCE(NULLIF(trim(p_filter), ''), 'all')) AS filter_value,
      lower(COALESCE(NULLIF(trim(p_query), ''), '')) AS query_value,
      GREATEST(1, LEAST(COALESCE(p_limit, 200), 500)) AS row_limit
  ),
  entity_rows AS (
    SELECT
      ce.id AS entity_id,
      ce.connection_id,
      ac.name AS connection_name,
      ce.name AS entity_name,
      ce.entity_group,
      COALESCE(ce.description, 'No description available yet.') AS description,
      COALESCE(
        (
          SELECT array_agg(inner_cols.name ORDER BY inner_cols.position_index, inner_cols.name)
          FROM (
            SELECT
              cc.name,
              COALESCE(cc.position_index, 0) AS position_index
            FROM public.connection_columns cc
            WHERE cc.tenant_id = ce.tenant_id
              AND cc.entity_id = ce.id
            ORDER BY COALESCE(cc.position_index, 0), cc.name
            LIMIT 4
          ) AS inner_cols
        ),
        ARRAY[]::text[]
      ) AS key_fields,
      ce.sensitivity,
      ce.row_count,
      ce.updated_at AS last_updated,
      ce.embedding_coverage,
      ce.source_kind,
      (
        SELECT COUNT(*)::int
        FROM public.connection_relationships cr
        WHERE cr.tenant_id = ce.tenant_id
          AND cr.connection_id = ce.connection_id
          AND (cr.source_entity_id = ce.id OR cr.target_entity_id = ce.id)
      ) AS relationship_count
    FROM public.connection_entities ce
    JOIN public.api_connections ac
      ON ac.id = ce.connection_id
     AND ac.tenant_id = ce.tenant_id
    JOIN me
      ON me.tenant_id = ce.tenant_id
  ),
  document_rows AS (
    SELECT
      kd.id AS entity_id,
      NULL::uuid AS connection_id,
      'Knowledge Documents'::text AS connection_name,
      kd.title AS entity_name,
      'config'::text AS entity_group,
      COALESCE(kd.excerpt, 'Indexed document in your knowledge base.') AS description,
      ARRAY['title', 'source_type', 'file_type']::text[] AS key_fields,
      'normal'::text AS sensitivity,
      1::bigint AS row_count,
      COALESCE(kd.indexed_at, kd.created_at) AS last_updated,
      CASE WHEN kd.status = 'indexed' THEN 100::numeric ELSE 25::numeric END AS embedding_coverage,
      'document'::text AS source_kind,
      0::int AS relationship_count
    FROM public.knowledge_documents kd
    JOIN me
      ON me.tenant_id = kd.tenant_id
  ),
  combined AS (
    SELECT * FROM entity_rows
    UNION ALL
    SELECT * FROM document_rows
  )
  SELECT
    c.entity_id,
    c.connection_id,
    c.connection_name,
    c.entity_name,
    c.entity_group,
    c.description,
    c.key_fields,
    c.sensitivity,
    c.row_count,
    c.last_updated,
    c.embedding_coverage,
    c.source_kind,
    c.relationship_count
  FROM combined c
  CROSS JOIN normalized n
  WHERE (
      n.filter_value = 'all'
      OR (n.filter_value = 'tables' AND c.source_kind IN ('table', 'endpoint'))
      OR (n.filter_value = 'documents' AND c.source_kind = 'document')
      OR (n.filter_value = 'entities' AND c.source_kind <> 'document')
      OR (n.filter_value = 'relationships' AND c.relationship_count > 0)
    )
    AND (
      n.query_value = ''
      OR lower(c.entity_name) LIKE '%' || n.query_value || '%'
      OR lower(c.connection_name) LIKE '%' || n.query_value || '%'
      OR lower(c.description) LIKE '%' || n.query_value || '%'
      OR EXISTS (
        SELECT 1
        FROM unnest(c.key_fields) AS k(field_name)
        WHERE lower(k.field_name) LIKE '%' || n.query_value || '%'
      )
    )
  ORDER BY c.embedding_coverage DESC, c.last_updated DESC NULLS LAST, c.entity_name ASC
  LIMIT (SELECT row_limit FROM normalized);
$$;

CREATE OR REPLACE FUNCTION public.get_knowledge_stats()
RETURNS TABLE (
  total_entities integer,
  embeddings_vectors bigint,
  documents_indexed integer,
  coverage_pct integer,
  storage_gb numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT public.get_user_tenant_id() AS tenant_id
  ),
  entity_stats AS (
    SELECT
      COUNT(*)::int AS total_entities,
      COALESCE(SUM((ce.row_count * ce.embedding_coverage) / 100.0), 0)::bigint AS derived_vectors,
      COALESCE(AVG(ce.embedding_coverage), 0)::numeric AS avg_coverage
    FROM public.connection_entities ce
    JOIN me ON me.tenant_id = ce.tenant_id
  ),
  connection_rollup AS (
    SELECT
      COALESCE(SUM(ac.embeddings_indexed), 0)::bigint AS embeddings_indexed
    FROM public.api_connections ac
    JOIN me ON me.tenant_id = ac.tenant_id
  ),
  doc_stats AS (
    SELECT
      COUNT(*) FILTER (WHERE kd.status = 'indexed')::int AS documents_indexed,
      COALESCE(SUM(length(COALESCE(kd.excerpt, ''))), 0)::bigint AS text_bytes
    FROM public.knowledge_documents kd
    JOIN me ON me.tenant_id = kd.tenant_id
  )
  SELECT
    es.total_entities,
    CASE
      WHEN cr.embeddings_indexed > 0 THEN cr.embeddings_indexed
      ELSE es.derived_vectors
    END AS embeddings_vectors,
    ds.documents_indexed,
    ROUND(es.avg_coverage)::int AS coverage_pct,
    ROUND(
      (
        (
          (
            CASE WHEN cr.embeddings_indexed > 0 THEN cr.embeddings_indexed ELSE es.derived_vectors END
          ) * 1536 * 4
        ) + ds.text_bytes
      )::numeric / 1024 / 1024 / 1024,
      3
    )::numeric AS storage_gb
  FROM entity_stats es
  CROSS JOIN connection_rollup cr
  CROSS JOIN doc_stats ds;
$$;

CREATE OR REPLACE FUNCTION public.get_knowledge_recent_queries(p_limit int DEFAULT 8)
RETURNS TABLE (
  id uuid,
  content text,
  created_at timestamptz
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
    m.id,
    m.content,
    m.created_at
  FROM public.chat_messages m
  JOIN public.chat_sessions s
    ON s.id = m.session_id
  JOIN me
    ON me.tenant_id = s.tenant_id
  WHERE lower(m.role) = 'user'
    AND COALESCE(NULLIF(trim(m.content), ''), '') <> ''
  ORDER BY m.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 8), 20));
$$;

GRANT EXECUTE ON FUNCTION public.get_knowledge_entities(text, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_knowledge_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_knowledge_recent_queries(int) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'knowledge_documents'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.knowledge_documents;
  END IF;
END;
$$;
