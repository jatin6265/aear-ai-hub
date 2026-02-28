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

  const token = String(body.token ?? "").trim();
  const fullName = String(body.fullName ?? body.full_name ?? "").trim();
  if (!token) return errorResponse(400, "token is required");

  const { data, error } = await auth.supabase.rpc("accept_team_invitation_token", {
    p_token: token,
    p_full_name: fullName || null,
  });

  if (error) return errorResponse(400, "Could not accept invitation", error.message);
  return jsonResponse(200, { ok: true, data: data?.[0] ?? null, error: null });
});
