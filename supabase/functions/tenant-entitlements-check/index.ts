import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let capability = "";
  let requested = 1;

  try {
    const body = await req.json();
    capability = String(body?.capability ?? "").trim().toLowerCase();
    requested = Number(body?.requested ?? 1);
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!capability) return errorResponse(400, "capability is required");

  const { data, error } = await auth.supabase.rpc("tenant_entitlements_check", {
    p_capability: capability,
    p_requested: Number.isFinite(requested) ? requested : 1,
  });

  if (error) return errorResponse(400, "Entitlement check failed", error.message);

  const row = data?.[0];
  if (!row) return errorResponse(500, "Entitlement check returned no result");

  return jsonResponse(200, {
    ok: true,
    capability: row.capability,
    allowed: row.allowed,
    reason: row.reason,
    hardLimit: row.hard_limit,
    softLimit: row.soft_limit,
    currentUsage: row.current_usage,
    requested: row.requested,
  });
});
