CREATE OR REPLACE FUNCTION public.gen_random_bytes(integer)
RETURNS bytea
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT extensions.gen_random_bytes($1);
$$;

CREATE OR REPLACE FUNCTION public.gen_random_uuid()
RETURNS uuid
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT extensions.gen_random_uuid();
$$;
