import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { invokeFunction } from "../_shared/function-proxy.ts";

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

  const connectionId = String(body.connectionId ?? body.connection_id ?? "").trim();
  if (!connectionId) return errorResponse(400, "connectionId is required");

  const proxied = await invokeFunction(req, "connector-sync-dispatch", {
    connectionId,
    triggerReason: String(body.triggerReason ?? "manual_discovery"),
    priority: Number(body.priority ?? 70),
    payload: body.payload && typeof body.payload === "object" ? body.payload : {},
  });

  if (!proxied.ok) return errorResponse(proxied.status, proxied.error ?? "Could not discover connection", proxied.data);
  return jsonResponse(200, { ok: true, data: proxied.data, error: null });
});
