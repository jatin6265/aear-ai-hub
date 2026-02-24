-- Chat action proposal runtime metadata.

ALTER TABLE public.agent_action_runs
  ADD COLUMN IF NOT EXISTS action_summary text,
  ADD COLUMN IF NOT EXISTS action_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS executed_at timestamptz,
  ADD COLUMN IF NOT EXISTS undo_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS reverted_at timestamptz;

CREATE INDEX IF NOT EXISTS agent_action_runs_approval_idx
  ON public.agent_action_runs (approval_request_id);

CREATE INDEX IF NOT EXISTS agent_action_runs_undo_idx
  ON public.agent_action_runs (tenant_id, undo_expires_at DESC)
  WHERE undo_expires_at IS NOT NULL;
