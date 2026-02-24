-- Backend hardening for schema detail route:
-- - allow re-discovery cleanup deletes
-- - enable realtime feeds for schema browser tables

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'connection_entities'
      AND policyname = 'Tenant members can delete entities'
  ) THEN
    CREATE POLICY "Tenant members can delete entities"
      ON public.connection_entities
      FOR DELETE TO authenticated
      USING (tenant_id = public.get_user_tenant_id());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'connection_columns'
      AND policyname = 'Tenant members can delete entity columns'
  ) THEN
    CREATE POLICY "Tenant members can delete entity columns"
      ON public.connection_columns
      FOR DELETE TO authenticated
      USING (tenant_id = public.get_user_tenant_id());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'connection_relationships'
      AND policyname = 'Tenant members can delete relationships'
  ) THEN
    CREATE POLICY "Tenant members can delete relationships"
      ON public.connection_relationships
      FOR DELETE TO authenticated
      USING (tenant_id = public.get_user_tenant_id());
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
      AND tablename = 'connection_entities'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.connection_entities;
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
      AND tablename = 'connection_columns'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.connection_columns;
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
      AND tablename = 'connection_relationships'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.connection_relationships;
  END IF;
END;
$$;
