-- Data source cascade delete: when a connection is deleted, clean up linked
-- knowledge documents, their chunks, and related context events.

-- 1. Add source_connection_id FK to knowledge_documents (nullable, SET NULL on delete)
ALTER TABLE public.knowledge_documents
  ADD COLUMN IF NOT EXISTS source_connection_id uuid
    REFERENCES public.api_connections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS knowledge_documents_source_connection_idx
  ON public.knowledge_documents (source_connection_id)
  WHERE source_connection_id IS NOT NULL;

-- 2. Backfill source_connection_id from context_events metadata where we have a
--    matching document_id linkage via the connection_id stored in metadata.
--    This is best-effort; knowledge documents without a clear link stay NULL.
UPDATE public.knowledge_documents kd
SET source_connection_id = ce.resource_id::uuid
FROM (
  SELECT DISTINCT
    (metadata->>'document_id')::uuid AS document_id,
    (metadata->>'connection_id')::uuid AS resource_id
  FROM public.context_events
  WHERE metadata->>'connection_id' IS NOT NULL
    AND metadata->>'document_id' IS NOT NULL
    AND (metadata->>'connection_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND (metadata->>'document_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
) ce
WHERE kd.id = ce.document_id
  AND kd.source_connection_id IS NULL;

-- 3. Create a BEFORE DELETE trigger on api_connections to cascade-delete
--    knowledge data and context events.
CREATE OR REPLACE FUNCTION public.cascade_delete_connection_knowledge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Delete embedding chunks for documents linked to this connection
  DELETE FROM public.knowledge_document_chunks
  WHERE document_id IN (
    SELECT id
    FROM public.knowledge_documents
    WHERE source_connection_id = OLD.id
  );

  -- Delete linked knowledge documents
  DELETE FROM public.knowledge_documents
  WHERE source_connection_id = OLD.id;

  -- Delete context events that recorded events for this connection
  DELETE FROM public.context_events
  WHERE metadata->>'connection_id' = OLD.id::text;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS api_connections_cascade_delete_knowledge ON public.api_connections;
CREATE TRIGGER api_connections_cascade_delete_knowledge
BEFORE DELETE ON public.api_connections
FOR EACH ROW
EXECUTE FUNCTION public.cascade_delete_connection_knowledge();
