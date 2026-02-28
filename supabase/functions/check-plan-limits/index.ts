import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const capability = String(body.capability ?? "").trim().toLowerCase();
  const requested = Number.isFinite(Number(body.requested)) ? Number(body.requested) : 1;

  if (!capability) return errorResponse(400, "capability is required");

  const { data, error } = await auth.supabase.rpc("tenant_entitlements_check", {
    p_capability: capability,
    p_requested: requested,
  });

  if (error) return errorResponse(400, "Plan limit check failed", error.message);

  const row = data?.[0] ?? null;
  return jsonResponse(200, { ok: true, data: row, error: null });
});
