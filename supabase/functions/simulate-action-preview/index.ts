import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

type RequestBody = {
  action?: string;
  resource?: string;
  riskLevel?: string;
  simulation?: Record<string, unknown> | null;
  params?: Record<string, unknown> | null;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const action = String(body.action ?? "").trim() || null;
  const resource = String(body.resource ?? "").trim() || null;
  const riskLevel = String(body.riskLevel ?? "medium").trim().toLowerCase() || "medium";
  const simulation = body.simulation && typeof body.simulation === "object" ? body.simulation : {};
  const params = body.params && typeof body.params === "object" ? body.params : {};

  const { data, error } = await auth.supabase.rpc("simulate_action_preview", {
    p_action: action,
    p_resource: resource,
    p_risk_level: riskLevel,
    p_existing_preview: simulation,
    p_params: params,
  });

  if (error) return errorResponse(400, "Failed to simulate preview", error.message);

  return jsonResponse(200, {
    ok: true,
    preview: data ?? null,
  });
});
