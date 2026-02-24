import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

function shouldUseQueueFallback(error: { code?: string | null; message?: string | null } | null) {
  if (!error) return true;
  const code = String(error.code ?? "");
  const message = String(error.message ?? "").toLowerCase();
  return (
    code === "PGRST202" ||
    code === "42702" ||
    message.includes("could not find the function") ||
    (message.includes("tenant_id") && message.includes("ambiguous"))
  );
}

function clampPriority(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(100, Math.round(value)));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let operation = "enqueue_connection";
  let connectionId = "";
  let jobType = "schema_discovery";
  let triggerReason = "manual";
  let priority = 50;
  let limit = 25;
  let idempotencyKey: string | null = null;
  let payload: Record<string, unknown> = {};

  try {
    const body = await req.json();
    operation = String(body?.operation ?? "enqueue_connection").trim().toLowerCase();
    connectionId = String(body?.connectionId ?? "").trim();
    jobType = String(body?.jobType ?? "schema_discovery").trim().toLowerCase();
    triggerReason = String(body?.triggerReason ?? "manual").trim().toLowerCase();
    priority = Number(body?.priority ?? 50);
    limit = Number(body?.limit ?? 25);
    idempotencyKey = body?.idempotencyKey ? String(body.idempotencyKey).trim() : null;
    payload = body?.payload && typeof body.payload === "object" ? body.payload : {};
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (operation === "schedule_due") {
    const { data, error } = await auth.supabase.rpc("enqueue_due_connector_sync_jobs", {
      p_limit: Number.isFinite(limit) ? limit : 25,
      p_trigger_reason: triggerReason || "scheduled_manual",
    });

    if (error) return errorResponse(400, "Could not enqueue due connector sync jobs", error.message);

    const jobs = (data ?? []).map((row) => ({
      jobId: row.job_id,
      tenantId: row.tenant_id,
      connectionId: row.connection_id,
      syncFrequency: row.sync_frequency,
      queue: row.queue,
      scheduledAt: row.scheduled_at,
    }));

    return jsonResponse(200, {
      ok: true,
      operation: "schedule_due",
      queuedCount: jobs.length,
      jobs,
    });
  }

  if (!connectionId) return errorResponse(400, "connectionId is required");

  const { data: connection, error: connectionError } = await auth.supabase
    .from("api_connections")
    .select("id, tenant_id")
    .eq("id", connectionId)
    .maybeSingle();

  if (connectionError) return errorResponse(400, "Could not load connection", connectionError.message);
  if (!connection) return errorResponse(404, "Connection not found");

  const safePriority = clampPriority(priority, 50);

  const rpcEnqueue = await auth.supabase.rpc("enqueue_connector_sync", {
    p_connection_id: connectionId,
    p_job_type: jobType,
    p_trigger_reason: triggerReason,
    p_priority: safePriority,
    p_idempotency_key: idempotencyKey,
    p_payload: payload,
  });

  if (!rpcEnqueue.error && rpcEnqueue.data?.[0]?.job_id) {
    const row = rpcEnqueue.data[0];
    return jsonResponse(200, {
      ok: true,
      jobId: row.job_id,
      status: row.status,
      queue: row.queue,
      scheduledAt: row.scheduled_at,
      mode: "rpc",
    });
  }

  const rpcMessage = rpcEnqueue.error?.message ?? "RPC enqueue returned no job id";
  if (!shouldUseQueueFallback(rpcEnqueue.error)) {
    return errorResponse(400, "Could not enqueue connector sync", rpcMessage);
  }

  const queueRow = {
    tenant_id: connection.tenant_id,
    connection_id: connection.id,
    job_type: jobType,
    queue: "connector-sync",
    status: "queued",
    priority: safePriority,
    idempotency_key: idempotencyKey,
    trigger_reason: triggerReason,
    payload: payload ?? {},
    triggered_by: auth.user.id,
  };

  let fallbackJob:
    | { id: string; status: string | null; queue: string | null; scheduled_at: string | null }
    | null = null;

  const fallbackInsert = await auth.supabase
    .from("connector_jobs")
    .insert(queueRow)
    .select("id,status,queue,scheduled_at")
    .single();

  if (!fallbackInsert.error && fallbackInsert.data?.id) {
    fallbackJob = fallbackInsert.data;
  } else if (fallbackInsert.error?.code === "23505" && idempotencyKey) {
    const existing = await auth.supabase
      .from("connector_jobs")
      .select("id,status,queue,scheduled_at")
      .eq("tenant_id", connection.tenant_id)
      .eq("idempotency_key", idempotencyKey)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!existing.error && existing.data?.id) {
      fallbackJob = existing.data;
    } else {
      return errorResponse(
        400,
        "Could not enqueue connector sync",
        `${rpcMessage}. Fallback queue lookup failed: ${existing.error?.message ?? "existing job not found"}`,
      );
    }
  } else if (fallbackInsert.error || !fallbackInsert.data?.id) {
    return errorResponse(
      400,
      "Could not enqueue connector sync",
      `${rpcMessage}. Fallback queue insert failed: ${fallbackInsert.error?.message ?? "unknown error"}`,
    );
  }

  if (!fallbackJob?.id) {
    return errorResponse(500, "Could not enqueue connector sync", "Fallback queue returned no job id");
  }

  await auth.supabase
    .from("api_connections")
    .update({
      status: "pending",
      analysis_started_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", connection.id)
    .eq("tenant_id", connection.tenant_id);

  return jsonResponse(200, {
    ok: true,
    jobId: fallbackJob.id,
    status: fallbackJob.status,
    queue: fallbackJob.queue,
    scheduledAt: fallbackJob.scheduled_at,
    mode: "fallback_insert",
    warning: `enqueue_connector_sync RPC failed (${rpcMessage}). Used direct queue fallback.`,
  });
});
