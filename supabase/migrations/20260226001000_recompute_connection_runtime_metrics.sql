-- Recompute connection runtime metrics from authoritative tables.
-- Prevents stale/optimistic UI states when schema rows are empty.

CREATE OR REPLACE FUNCTION public.recompute_connection_runtime_metrics(
  p_connection_id uuid DEFAULT NULL
)
RETURNS TABLE (
  connection_id uuid,
  schema_entities_count integer,
  embeddings_indexed integer,
  schema_detected boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := COALESCE(auth.role(), '');
  v_tenant_id uuid := public.get_user_tenant_id();
BEGIN
  IF v_role <> 'service_role' AND v_role <> '' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Authentication required';
    END IF;

    IF v_tenant_id IS NULL THEN
      RAISE EXCEPTION 'No tenant found for authenticated user';
    END IF;
  END IF;

  RETURN QUERY
  WITH target_connections AS (
    SELECT c.id, c.tenant_id, c.status
    FROM public.api_connections c
    WHERE c.is_archived = false
      AND (p_connection_id IS NULL OR c.id = p_connection_id)
      AND (v_role IN ('service_role', '') OR c.tenant_id = v_tenant_id)
  ),
  entity_counts AS (
    SELECT
      ce.connection_id,
      COUNT(*)::integer AS entity_count
    FROM public.connection_entities ce
    JOIN target_connections tc
      ON tc.id = ce.connection_id
     AND tc.tenant_id = ce.tenant_id
    GROUP BY ce.connection_id
  ),
  embedding_counts AS (
    SELECT
      tc.id AS connection_id,
      COUNT(kc.id) FILTER (WHERE kc.embedding IS NOT NULL)::integer AS embedded_count
    FROM target_connections tc
    LEFT JOIN public.knowledge_documents kd
      ON kd.tenant_id = tc.tenant_id
     AND kd.source_type = 'connection_schema'
     AND kd.storage_path LIKE format('connector-schema/%s/%%', tc.id::text)
    LEFT JOIN public.knowledge_document_chunks kc
      ON kc.tenant_id = tc.tenant_id
     AND kc.document_id = kd.id
    GROUP BY tc.id
  ),
  updated AS (
    UPDATE public.api_connections c
    SET
      schema_entities_count = COALESCE(ec.entity_count, 0),
      schema_tables_count = COALESCE(ec.entity_count, 0),
      schema_detected = COALESCE(ec.entity_count, 0) > 0,
      embeddings_indexed = COALESCE(emb.embedded_count, 0),
      status = CASE
        WHEN COALESCE(ec.entity_count, 0) > 0 AND c.status IN ('pending', 'syncing') THEN 'active'
        WHEN COALESCE(ec.entity_count, 0) = 0 AND c.status = 'active' THEN 'pending'
        ELSE c.status
      END,
      health = CASE
        WHEN COALESCE(ec.entity_count, 0) = 0 AND c.status = 'active' THEN 'degraded'
        ELSE c.health
      END,
      updated_at = now()
    FROM target_connections tc
    LEFT JOIN entity_counts ec ON ec.connection_id = tc.id
    LEFT JOIN embedding_counts emb ON emb.connection_id = tc.id
    WHERE c.id = tc.id
      AND c.tenant_id = tc.tenant_id
    RETURNING c.id, c.schema_entities_count, c.embeddings_indexed, c.schema_detected
  )
  SELECT
    u.id,
    u.schema_entities_count,
    u.embeddings_indexed,
    u.schema_detected
  FROM updated u;
END;
$$;

GRANT EXECUTE ON FUNCTION public.recompute_connection_runtime_metrics(uuid) TO authenticated, service_role;

-- Backfill current rows once after deployment.
SELECT * FROM public.recompute_connection_runtime_metrics(NULL);
