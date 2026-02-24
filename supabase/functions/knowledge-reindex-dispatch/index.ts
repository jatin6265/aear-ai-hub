import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let documentId: string | null = null;
  let force = false;
  let limit = 800;

  try {
    const body = await req.json();
    documentId = body?.documentId ? String(body.documentId).trim() : null;
    force = Boolean(body?.force);
    limit = Number(body?.limit ?? 800);
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 5000)) : 800;

  const { data: scheduleData, error: scheduleError } = await auth.supabase.rpc("schedule_knowledge_embedding_reindex", {
    p_document_id: documentId,
    p_tenant_id: null,
    p_force: force,
    p_limit: boundedLimit,
  });

  if (scheduleError) {
    return errorResponse(400, "Could not schedule knowledge reindex", scheduleError.message);
  }

  const { data: healthData, error: healthError } = await auth.supabase.rpc("get_knowledge_embedding_health", {
    p_tenant_id: null,
  });

  if (healthError) {
    return errorResponse(400, "Could not load embedding health", healthError.message);
  }

  const schedule = scheduleData?.[0] ?? { queued_count: 0, stale_count: 0, scanned_count: 0 };
  const health = healthData?.[0] ?? null;

  return jsonResponse(200, {
    ok: true,
    documentId,
    queuedCount: Number(schedule.queued_count ?? 0),
    staleCount: Number(schedule.stale_count ?? 0),
    scannedCount: Number(schedule.scanned_count ?? 0),
    health: health
      ? {
          documentsTotal: Number(health.documents_total ?? 0),
          chunksTotal: Number(health.chunks_total ?? 0),
          embeddedChunks: Number(health.embedded_chunks ?? 0),
          pendingChunks: Number(health.pending_chunks ?? 0),
          staleChunks: Number(health.stale_chunks ?? 0),
          errorChunks: Number(health.error_chunks ?? 0),
          coveragePct: Number(health.coverage_pct ?? 0),
          lastEmbeddedAt: health.last_embedded_at ? String(health.last_embedded_at) : null,
        }
      : null,
  });
});
