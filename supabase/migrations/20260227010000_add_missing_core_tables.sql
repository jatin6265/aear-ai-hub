-- Migration: Add missing core tables from OpsAI Build Plan Phase 1 (B11, B12)
-- Tables: mcp_servers, context_events, ingestion_queue

-- B11: MCP Servers Registry
-- Stores configurations for external Model Context Protocol servers.
CREATE TABLE IF NOT EXISTS public.mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE, -- NULL means global/system server
  name text NOT NULL,
  description text,
  url text NOT NULL,
  auth_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'error', 'connecting')),
  last_ping_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.mcp_servers ENABLE ROW LEVEL SECURITY;

-- B12: Realtime Context Events
-- Stores chronological company context for "Event Timeline Memory".
CREATE TABLE IF NOT EXISTS public.context_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  source_type text NOT NULL, -- 'slack', 'email', 'webhook', 'manual'
  source_id text, -- ID in the external system
  event_type text NOT NULL, -- 'message', 'file_upload', 'status_change'
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.context_events ENABLE ROW LEVEL SECURITY;

-- B12: Ingestion Queue
-- Temporary storage for data chunks before processing/embedding.
CREATE TABLE IF NOT EXISTS public.ingestion_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  source_kind text NOT NULL, -- 'document', 'communication', 'structured'
  source_ref uuid NOT NULL, -- Reference to the specific connection or document
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' 
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  retry_count integer NOT NULL DEFAULT 0,
  last_error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ingestion_queue ENABLE ROW LEVEL SECURITY;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS mcp_servers_tenant_idx ON public.mcp_servers (tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS context_events_tenant_occurred_idx ON public.context_events (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ingestion_queue_status_tenant_idx ON public.ingestion_queue (status, tenant_id);

-- RLS Policies (Phase 2 - B17, B18)

-- MCP Servers: Users can see global servers or their own tenant's servers
CREATE POLICY "Users can view relevant mcp_servers" ON public.mcp_servers
  FOR SELECT TO authenticated
  USING (tenant_id IS NULL OR tenant_id = (SELECT tenant_id FROM public.profiles WHERE id = auth.uid()));

-- Context Events: Tenant isolation
CREATE POLICY "Users can view their tenant context_events" ON public.context_events
  FOR SELECT TO authenticated
  USING (tenant_id = (SELECT tenant_id FROM public.profiles WHERE id = auth.uid()));

-- Ingestion Queue: Only service role or admins should really touch this, 
-- but let's add tenant isolation for completeness if needed.
CREATE POLICY "Users can view their tenant ingestion_queue" ON public.ingestion_queue
  FOR SELECT TO authenticated
  USING (tenant_id = (SELECT tenant_id FROM public.profiles WHERE id = auth.uid()));

-- Triggers for updated_at
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at_timestamp') THEN
    CREATE TRIGGER mcp_servers_set_updated_at
    BEFORE UPDATE ON public.mcp_servers
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();

    CREATE TRIGGER ingestion_queue_set_updated_at
    BEFORE UPDATE ON public.ingestion_queue
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();
  END IF;
END $$;
