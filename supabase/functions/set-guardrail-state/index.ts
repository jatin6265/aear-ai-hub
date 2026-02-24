import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let guardrailId = "";
  let enabled = false;
  try {
    const body = await req.json();
    guardrailId = String(body?.guardrailId ?? "").trim();
    enabled = Boolean(body?.enabled);
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!guardrailId) return errorResponse(400, "guardrailId is required");

  const { data, error } = await auth.supabase.rpc("set_guardrail_enabled", {
    p_guardrail_id: guardrailId,
    p_enabled: enabled,
  });

  if (error) return errorResponse(400, "Failed to update guardrail", error.message);

  return jsonResponse(200, {
    ok: true,
    updated: Boolean(data),
  });
});
