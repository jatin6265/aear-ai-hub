-- RAG hardening: embedding state tracking, stale detection, and reindex orchestration.

ALTER TABLE public.knowledge_document_chunks
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS embedding_state text NOT NULL DEFAULT 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'knowledge_document_chunks_embedding_state_check'
      AND conrelid = 'public.knowledge_document_chunks'::regclass
  ) THEN
    ALTER TABLE public.knowledge_document_chunks
      ADD CONSTRAINT knowledge_document_chunks_embedding_state_check
      CHECK (embedding_state IN ('pending', 'embedded', 'stale', 'error'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS knowledge_chunks_tenant_embedding_state_idx
  ON public.knowledge_document_chunks (tenant_id, embedding_state, updated_at DESC);

CREATE INDEX IF NOT EXISTS knowledge_chunks_tenant_embedded_at_idx
  ON public.knowledge_document_chunks (tenant_id, embedded_at DESC);

CREATE OR REPLACE FUNCTION public.set_knowledge_chunk_embedding_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_hash text := md5(COALESCE(NEW.content, ''));
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.content_hash := v_hash;
    IF NEW.embedding IS NOT NULL AND NEW.embedded_at IS NOT NULL THEN
      NEW.embedding_state := COALESCE(NEW.embedding_state, 'embedded');
    ELSE
      NEW.embedding_state := COALESCE(NEW.embedding_state, 'pending');
    END IF;
    NEW.updated_at := COALESCE(NEW.updated_at, now());
    RETURN NEW;
  END IF;

  IF (
      COALESCE(OLD.content_hash, '') <> ''
      AND COALESCE(OLD.content_hash, '') IS DISTINCT FROM v_hash
    )
    OR COALESCE(OLD.content, '') IS DISTINCT FROM COALESCE(NEW.content, '') THEN
    NEW.content_hash := v_hash;
    NEW.embedding := NULL;
    NEW.embedding_model := NULL;
    NEW.embedded_at := NULL;
    NEW.embedding_state := 'stale';
  ELSE
    NEW.content_hash := COALESCE(OLD.content_hash, v_hash);
    IF NEW.embedding IS NOT NULL AND NEW.embedded_at IS NOT NULL THEN
      NEW.embedding_state := COALESCE(NEW.embedding_state, 'embedded');
    ELSIF NEW.embedding_state IS NULL THEN
      NEW.embedding_state := COALESCE(OLD.embedding_state, 'pending');
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS knowledge_chunks_set_embedding_state ON public.knowledge_document_chunks;
CREATE TRIGGER knowledge_chunks_set_embedding_state
BEFORE INSERT OR UPDATE ON public.knowledge_document_chunks
FOR EACH ROW
EXECUTE FUNCTION public.set_knowledge_chunk_embedding_state();

UPDATE public.knowledge_document_chunks
SET
  content_hash = md5(COALESCE(content, '')),
  embedding_state = CASE
    WHEN embedding IS NOT NULL AND embedded_at IS NOT NULL THEN 'embedded'
    WHEN embedding_state IN ('pending', 'stale', 'error') THEN embedding_state
    ELSE 'pending'
  END,
  updated_at = COALESCE(updated_at, created_at, now());

CREATE OR REPLACE FUNCTION public.schedule_knowledge_embedding_reindex(
  p_document_id uuid DEFAULT NULL,
  p_tenant_id uuid DEFAULT NULL,
  p_force boolean DEFAULT false,
  p_limit integer DEFAULT 500
)
RETURNS TABLE (
  queued_count integer,
  stale_count integer,
  scanned_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_auth_user uuid := auth.uid();
  v_user_tenant uuid := public.get_user_tenant_id();
  v_tenant_id uuid := NULL;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 500), 5000));
BEGIN
  IF v_auth_user IS NULL AND v_role <> 'service_role' THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_auth_user IS NOT NULL THEN
    v_tenant_id := COALESCE(p_tenant_id, v_user_tenant);
    IF v_user_tenant IS NULL OR v_tenant_id IS DISTINCT FROM v_user_tenant THEN
      RAISE EXCEPTION 'Cross-tenant reindex is not allowed';
    END IF;
  ELSE
    v_tenant_id := p_tenant_id;
  END IF;

  IF v_tenant_id IS NULL AND p_document_id IS NOT NULL THEN
    SELECT kd.tenant_id
    INTO v_tenant_id
    FROM public.knowledge_documents kd
    WHERE kd.id = p_document_id;
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant context is required';
  END IF;

  IF p_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.knowledge_documents kd
    WHERE kd.id = p_document_id
      AND kd.tenant_id = v_tenant_id
  ) THEN
    RAISE EXCEPTION 'Document not found for tenant';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT
      kdc.id,
      kdc.document_id,
      kdc.content_hash,
      kdc.embedding_state
    FROM public.knowledge_document_chunks kdc
    JOIN public.knowledge_documents kd
      ON kd.id = kdc.document_id
     AND kd.tenant_id = kdc.tenant_id
    WHERE kdc.tenant_id = v_tenant_id
      AND (p_document_id IS NULL OR kdc.document_id = p_document_id)
      AND kd.status IN ('indexed', 'processing')
      AND (
        p_force
        OR kdc.embedding IS NULL
        OR kdc.embedded_at IS NULL
        OR kdc.embedding_state IN ('pending', 'stale', 'error')
      )
    ORDER BY
      CASE
        WHEN kdc.embedding_state IN ('stale', 'error') THEN 0
        WHEN kdc.embedding_state = 'pending' THEN 1
        ELSE 2
      END,
      COALESCE(kdc.embedded_at, 'epoch'::timestamptz) ASC,
      kdc.updated_at DESC
    LIMIT v_limit
  ),
  upserted AS (
    INSERT INTO public.embedding_jobs (
      tenant_id,
      source_type,
      source_id,
      status,
      priority,
      idempotency_key,
      payload,
      created_by
    )
    SELECT
      v_tenant_id,
      'knowledge_chunk',
      c.id,
      'queued',
      CASE
        WHEN p_force THEN 62
        WHEN c.embedding_state IN ('stale', 'error') THEN 60
        ELSE 55
      END,
      format('chunk:%s:%s', c.id, COALESCE(c.content_hash, 'nohash')),
      jsonb_build_object(
        'source', 'schedule_knowledge_embedding_reindex',
        'document_id', c.document_id,
        'force', p_force,
        'previous_state', c.embedding_state
      ),
      v_auth_user
    FROM candidates c
    ON CONFLICT (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
    DO UPDATE SET
      status = CASE
        WHEN embedding_jobs.status IN ('running') THEN embedding_jobs.status
        WHEN embedding_jobs.status = 'success' THEN embedding_jobs.status
        ELSE 'queued'
      END,
      scheduled_at = CASE
        WHEN embedding_jobs.status IN ('running', 'success') THEN embedding_jobs.scheduled_at
        ELSE now()
      END,
      priority = GREATEST(embedding_jobs.priority, EXCLUDED.priority),
      payload = embedding_jobs.payload || EXCLUDED.payload,
      updated_at = now()
    RETURNING source_id
  ),
  marked AS (
    UPDATE public.knowledge_document_chunks kdc
    SET
      embedding_state = CASE
        WHEN p_force THEN 'pending'
        WHEN kdc.embedding_state IN ('stale', 'error', 'pending') THEN 'pending'
        WHEN kdc.embedding IS NULL OR kdc.embedded_at IS NULL THEN 'pending'
        ELSE kdc.embedding_state
      END,
      updated_at = now()
    WHERE kdc.id IN (SELECT u.source_id FROM upserted u)
    RETURNING kdc.id
  )
  SELECT
    (SELECT COUNT(*)::integer FROM marked),
    (SELECT COUNT(*)::integer FROM candidates c WHERE c.embedding_state IN ('stale', 'error')),
    (SELECT COUNT(*)::integer FROM candidates);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_knowledge_embedding_health(
  p_tenant_id uuid DEFAULT NULL
)
RETURNS TABLE (
  tenant_id uuid,
  documents_total integer,
  chunks_total integer,
  embedded_chunks integer,
  pending_chunks integer,
  stale_chunks integer,
  error_chunks integer,
  coverage_pct integer,
  last_embedded_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_auth_user uuid := auth.uid();
  v_user_tenant uuid := public.get_user_tenant_id();
  v_tenant_id uuid := NULL;
BEGIN
  IF v_auth_user IS NULL AND v_role <> 'service_role' THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_auth_user IS NOT NULL THEN
    v_tenant_id := COALESCE(p_tenant_id, v_user_tenant);
    IF v_user_tenant IS NULL OR v_tenant_id IS DISTINCT FROM v_user_tenant THEN
      RAISE EXCEPTION 'Cross-tenant access is not allowed';
    END IF;
  ELSE
    v_tenant_id := p_tenant_id;
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant context is required';
  END IF;

  RETURN QUERY
  WITH docs AS (
    SELECT COUNT(*)::integer AS total
    FROM public.knowledge_documents kd
    WHERE kd.tenant_id = v_tenant_id
      AND kd.status IN ('indexed', 'processing')
  ),
  chunks AS (
    SELECT
      COUNT(*)::integer AS total,
      COUNT(*) FILTER (WHERE kdc.embedding_state = 'embedded')::integer AS embedded,
      COUNT(*) FILTER (WHERE kdc.embedding_state = 'pending')::integer AS pending,
      COUNT(*) FILTER (WHERE kdc.embedding_state = 'stale')::integer AS stale,
      COUNT(*) FILTER (WHERE kdc.embedding_state = 'error')::integer AS err,
      MAX(kdc.embedded_at) AS last_embedded_at
    FROM public.knowledge_document_chunks kdc
    WHERE kdc.tenant_id = v_tenant_id
  )
  SELECT
    v_tenant_id,
    docs.total,
    chunks.total,
    chunks.embedded,
    chunks.pending,
    chunks.stale,
    chunks.err,
    CASE
      WHEN chunks.total = 0 THEN 0
      ELSE ROUND((chunks.embedded::numeric / chunks.total::numeric) * 100)::integer
    END AS coverage_pct,
    chunks.last_embedded_at
  FROM docs, chunks;
END;
$$;

GRANT EXECUTE ON FUNCTION public.schedule_knowledge_embedding_reindex(uuid, uuid, boolean, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_knowledge_embedding_health(uuid) TO authenticated, service_role;
