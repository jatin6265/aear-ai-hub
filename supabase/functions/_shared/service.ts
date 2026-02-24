import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { errorResponse } from "./http.ts";

export function getServiceClient() {
  // Prefer canonical runtime secrets; keep VITE_* only as fallback for legacy deployments.
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("VITE_SUPABASE_URL");
  const canonicalServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const viteServiceRoleKey = Deno.env.get("VITE_SUPABASE_SERVICE_ROLE_KEY");
  const serviceRoleKey = canonicalServiceRoleKey ?? viteServiceRoleKey;

  if (
    viteServiceRoleKey &&
    canonicalServiceRoleKey &&
    viteServiceRoleKey !== canonicalServiceRoleKey
  ) {
    console.warn(
      "SUPABASE service role keys differ; selected canonical SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  if (!supabaseUrl || !serviceRoleKey) {
    return {
      ok: false as const,
      response: errorResponse(
        500,
        "Missing Supabase service keys (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)",
      ),
    };
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return {
    ok: true as const,
    supabase,
  };
}

export function requireWorkerToken(req: Request) {
  const expected = Deno.env.get("CONNECTOR_WORKER_TOKEN") ?? Deno.env.get("VITE_CONNECTOR_WORKER_TOKEN");
  if (!expected) {
    return {
      ok: false as const,
      response: errorResponse(500, "CONNECTOR_WORKER_TOKEN is not configured"),
    };
  }

  const fromHeader = req.headers.get("x-worker-token") ?? "";
  if (fromHeader && fromHeader === expected) {
    return { ok: true as const };
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (token === expected) {
    return { ok: true as const };
  }

  return {
    ok: false as const,
    response: errorResponse(401, "Invalid worker token"),
  };
}
