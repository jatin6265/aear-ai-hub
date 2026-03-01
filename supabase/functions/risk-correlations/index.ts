import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  try {
    const { data, error } = await auth.supabase.rpc("get_cross_domain_risk_correlations", {
      p_tenant_id: auth.tenantId,
    });

    if (error) return errorResponse(400, "Failed to compute risk correlations", error.message);

    return jsonResponse(200, { ok: true, correlations: data });
  } catch (err) {
    return errorResponse(500, "Unexpected error", err instanceof Error ? err.message : String(err));
  }
});
