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

  const sourceId = String(body.sourceId ?? body.source_id ?? body.documentId ?? "").trim();
  const sourceType = String(body.sourceType ?? body.source_type ?? "document_reindex").trim();
  if (!sourceId && sourceType !== "tenant_reindex") {
    return errorResponse(400, "sourceId is required");
  }

  const proxied = await invokeFunction(req, "knowledge-embed-worker-dispatch", {
    sourceType,
    sourceId,
    tenantId: body.tenantId ?? null,
    priority: Number(body.priority ?? 50),
    force: Boolean(body.force ?? false),
    payload: body.payload && typeof body.payload === "object" ? body.payload : {},
  });

  if (!proxied.ok) return errorResponse(proxied.status, proxied.error ?? "Embed content failed", proxied.data);
  return jsonResponse(200, { ok: true, data: proxied.data, error: null });
});
