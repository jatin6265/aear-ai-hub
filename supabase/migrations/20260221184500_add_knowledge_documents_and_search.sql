-- Knowledge documents metadata for RAG
CREATE TABLE public.knowledge_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
  uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  title text NOT NULL,
  file_name text NOT NULL,
  file_type text NOT NULL,
  source_type text NOT NULL DEFAULT 'upload',
  storage_path text,
  external_url text,
  excerpt text,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'indexed', 'error')),
  indexed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.knowledge_documents ENABLE ROW LEVEL SECURITY;

CREATE INDEX knowledge_documents_tenant_idx ON public.knowledge_documents (tenant_id, created_at DESC);
CREATE INDEX knowledge_documents_status_idx ON public.knowledge_documents (tenant_id, status);

-- RLS policies
CREATE POLICY "Tenant members can view knowledge documents" ON public.knowledge_documents
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Tenant members can insert knowledge documents" ON public.knowledge_documents
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.get_user_tenant_id() AND uploaded_by = auth.uid());

CREATE POLICY "Tenant members can update knowledge documents" ON public.knowledge_documents
  FOR UPDATE TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

-- Storage bucket for uploaded docs
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'knowledge-documents',
  'knowledge-documents',
  false,
  52428800,
  ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown'
  ]::text[]
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Tenant members can upload knowledge files" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'knowledge-documents'
    AND (storage.foldername(name))[1] = public.get_user_tenant_id()::text
    AND owner = auth.uid()
  );

CREATE POLICY "Tenant members can read knowledge files" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'knowledge-documents'
    AND (storage.foldername(name))[1] = public.get_user_tenant_id()::text
  );

CREATE POLICY "Tenant members can update knowledge files" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'knowledge-documents'
    AND (storage.foldername(name))[1] = public.get_user_tenant_id()::text
  );

CREATE POLICY "Tenant members can delete knowledge files" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'knowledge-documents'
    AND (storage.foldername(name))[1] = public.get_user_tenant_id()::text
  );

-- Lightweight search RPC for RAG source retrieval
CREATE OR REPLACE FUNCTION public.search_knowledge_documents(p_query text, p_limit int DEFAULT 5)
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
  WITH scored AS (
    SELECT
      kd.id,
      kd.title,
      kd.file_type,
      kd.source_type,
      kd.external_url,
      kd.storage_path,
      COALESCE(kd.excerpt, 'No indexed snippet available yet.') AS excerpt,
      (
        CASE
          WHEN COALESCE(NULLIF(trim(p_query), ''), '') = '' THEN 50
          WHEN lower(kd.title) LIKE '%' || lower(p_query) || '%' THEN 60
          ELSE 0
        END
        + CASE
          WHEN lower(COALESCE(kd.excerpt, '')) LIKE '%' || lower(p_query) || '%' THEN 40
          ELSE 0
        END
      )::int AS relevance
    FROM public.knowledge_documents kd
    WHERE kd.tenant_id = public.get_user_tenant_id()
      AND kd.status = 'indexed'
  )
  SELECT
    scored.id,
    scored.title,
    scored.file_type,
    scored.source_type,
    scored.external_url,
    scored.storage_path,
    scored.excerpt,
    scored.relevance
  FROM scored
  WHERE COALESCE(NULLIF(trim(p_query), ''), '') = '' OR scored.relevance > 0
  ORDER BY scored.relevance DESC, scored.title ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 5), 10));
$$;

GRANT EXECUTE ON FUNCTION public.search_knowledge_documents(text, int) TO authenticated;
