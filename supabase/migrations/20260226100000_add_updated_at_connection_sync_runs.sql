-- Add missing updated_at on connection_sync_runs to unblock diagnostics queries
ALTER TABLE public.connection_sync_runs
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now() NOT NULL;

-- Backfill existing rows with the best available timestamp
UPDATE public.connection_sync_runs
SET updated_at = COALESCE(updated_at, finished_at, started_at, now());

-- Ensure updated_at stays fresh on updates
DROP TRIGGER IF EXISTS connection_sync_runs_set_updated_at ON public.connection_sync_runs;
CREATE TRIGGER connection_sync_runs_set_updated_at
  BEFORE UPDATE ON public.connection_sync_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at_timestamp();
