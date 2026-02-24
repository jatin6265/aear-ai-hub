import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let sourceType = "document";
  let sourceId = "";
  let tenantId: string | null = null;
  let priority = 50;
  let force = false;
  let limit = 500;
  let idempotencyKey: string | null = null;
  let payload: Record<string, unknown> = {};

  try {
    const body = await req.json();
    sourceType = String(body?.sourceType ?? "document").trim().toLowerCase();
    sourceId = String(body?.sourceId ?? "").trim();
    tenantId = body?.tenantId ? String(body.tenantId).trim() : null;
    priority = Number(body?.priority ?? 50);
    force = Boolean(body?.force);
    limit = Number(body?.limit ?? 500);
    idempotencyKey = body?.idempotencyKey ? String(body.idempotencyKey).trim() : null;
    payload = body?.payload && typeof body.payload === "object" ? body.payload : {};
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (sourceType === "tenant_reindex") {
    const { data, error } = await auth.supabase.rpc("schedule_knowledge_embedding_reindex", {
      p_document_id: null,
      p_tenant_id: tenantId,
      p_force: force,
      p_limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 5000)) : 500,
    });

    if (error) return errorResponse(400, "Could not schedule tenant reindex", error.message);
    const row = data?.[0] ?? { queued_count: 0, stale_count: 0, scanned_count: 0 };
    return jsonResponse(200, {
      ok: true,
      mode: "tenant_reindex",
      queuedCount: Number(row.queued_count ?? 0),
      staleCount: Number(row.stale_count ?? 0),
      scannedCount: Number(row.scanned_count ?? 0),
    });
  }

  if (sourceType === "document" || sourceType === "document_reindex") {
    if (!sourceId) return errorResponse(400, "sourceId is required for document reindex");
    const { data, error } = await auth.supabase.rpc("schedule_knowledge_embedding_reindex", {
      p_document_id: sourceId,
      p_tenant_id: tenantId,
      p_force: force,
      p_limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 5000)) : 500,
    });

    if (error) return errorResponse(400, "Could not schedule document reindex", error.message);
    const row = data?.[0] ?? { queued_count: 0, stale_count: 0, scanned_count: 0 };
    return jsonResponse(200, {
      ok: true,
      mode: "document_reindex",
      sourceId,
      queuedCount: Number(row.queued_count ?? 0),
      staleCount: Number(row.stale_count ?? 0),
      scannedCount: Number(row.scanned_count ?? 0),
    });
  }

  if (!sourceId) return errorResponse(400, "sourceId is required");

  const { data, error } = await auth.supabase.rpc("create_embedding_job", {
    p_source_type: sourceType,
    p_source_id: sourceId,
    p_priority: Number.isFinite(priority) ? priority : 50,
    p_idempotency_key: idempotencyKey,
    p_payload: payload,
  });

  if (error) return errorResponse(400, "Could not enqueue embedding job", error.message);

  const row = data?.[0];
  if (!row?.job_id) return errorResponse(500, "Embedding enqueue response missing job id");

  return jsonResponse(200, {
    ok: true,
    jobId: row.job_id,
    status: row.status,
    scheduledAt: row.scheduled_at,
  });
});
