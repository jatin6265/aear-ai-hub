import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let agentId = "";
  let enabled = true;
  try {
    const body = await req.json();
    agentId = String(body?.agentId ?? "").trim();
    enabled = Boolean(body?.enabled);
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!agentId) return errorResponse(400, "agentId is required");

  const { data, error } = await auth.supabase.rpc("set_agent_enabled", {
    p_agent_id: agentId,
    p_enabled: enabled,
  });
  if (error) return errorResponse(400, "Failed to update agent status", error.message);

  const row = data?.[0] ?? null;
  return jsonResponse(200, {
    ok: true,
    agent: row,
  });
});
