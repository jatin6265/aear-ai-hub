import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let approvalId = "";
  let decision = "";

  try {
    const body = await req.json();
    approvalId = String(body?.approvalId ?? "").trim();
    decision = String(body?.decision ?? "").trim().toLowerCase();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!approvalId || !decision) return errorResponse(400, "approvalId and decision are required");

  const { data, error } = await auth.supabase.rpc("decide_approval_request", {
    p_request_id: approvalId,
    p_decision: decision,
  });

  if (error) return errorResponse(400, "Failed to decide approval", error.message);

  const row = data?.[0] ?? null;
  return jsonResponse(200, {
    ok: true,
    status: row?.status ?? null,
    decidedAt: row?.decided_at ?? null,
  });
});
