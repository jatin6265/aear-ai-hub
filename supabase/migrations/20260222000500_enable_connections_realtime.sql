-- Ensure realtime feed is enabled for connections status updates.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'api_connections'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.api_connections;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'connection_sync_runs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.connection_sync_runs;
  END IF;
END;
$$;

