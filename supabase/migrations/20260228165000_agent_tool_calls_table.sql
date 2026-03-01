-- Creates a queryable per-tool-call audit table.
--
-- Previously tool runs were stored only as a JSON blob inside agent_runs.output,
-- which can't be indexed, queried, or charted per tool/tenant efficiently.
-- This table gives every tool call a first-class row with FK to the run.
--
-- Inserts happen from agentLoop.ts after execution completes (batch insert).

CREATE TABLE IF NOT EXISTS public.agent_tool_calls (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  run_id       uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  turn_index   int  NOT NULL DEFAULT 0,
  tool_name    text NOT NULL,
  arguments    jsonb NOT NULL DEFAULT '{}',
  result       jsonb,
  ok           boolean NOT NULL DEFAULT false,
  error_message text,
  duration_ms  int,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Index for fetching all calls in a run (most common query).
CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_run_id
  ON public.agent_tool_calls(run_id);

-- Index for per-tenant tool usage analytics (e.g. "which tools are called most?").
CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_tenant_tool
  ON public.agent_tool_calls(tenant_id, tool_name, created_at DESC);

ALTER TABLE public.agent_tool_calls ENABLE ROW LEVEL SECURITY;

-- Tenant members can read their own runs' tool calls.
CREATE POLICY "tenant_members_can_view_tool_calls"
  ON public.agent_tool_calls FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id());

-- Service role has full access (worker inserts).
GRANT ALL ON public.agent_tool_calls TO service_role;
GRANT SELECT ON public.agent_tool_calls TO authenticated;
