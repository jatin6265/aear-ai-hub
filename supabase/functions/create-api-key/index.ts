import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let name = "";
  let scopes: string[] = ["read"];
  let environment = "production";
  let expiresAt: string | null = null;

  try {
    const body = await req.json();
    name = String(body?.name ?? "").trim();
    scopes = Array.isArray(body?.scopes)
      ? body.scopes.map((scope: unknown) => String(scope).trim().toLowerCase()).filter(Boolean)
      : ["read"];
    environment = ["production", "development", "testing"].includes(String(body?.environment ?? "").trim().toLowerCase())
      ? String(body?.environment).trim().toLowerCase()
      : "production";
    expiresAt = body?.expiresAt ? String(body.expiresAt) : null;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!name) return errorResponse(400, "name is required");

  const { data, error } = await auth.supabase.rpc("create_api_key_v2", {
    p_name: name,
    p_scopes: scopes,
    p_environment: environment,
    p_expires_at: expiresAt,
  });

  if (error) return errorResponse(400, "Failed to create api key", error.message);

  const row = data?.[0];
  return jsonResponse(200, {
    ok: true,
    keyId: row?.id ?? null,
    key: row?.plain_key ?? null,
    keyPrefix: row?.key_prefix ?? null,
    createdAt: row?.created_at ?? null,
  });
});
