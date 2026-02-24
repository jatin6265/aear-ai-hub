import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let keyId = "";
  try {
    const body = await req.json();
    keyId = String(body?.keyId ?? "").trim();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!keyId) return errorResponse(400, "keyId is required");

  const { data, error } = await auth.supabase.rpc("revoke_api_key", {
    p_key_id: keyId,
  });

  if (error) return errorResponse(400, "Failed to revoke api key", error.message);

  return jsonResponse(200, {
    ok: true,
    revoked: Boolean(data),
  });
});
