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

  let connectionId = "";
  let triggerReason = "manual_fallback";
  let priority = 70;
  let idempotencyKey: string | null = null;
  let payload: Record<string, unknown> = {};

  try {
    const body = await req.json();
    connectionId = String(body?.connectionId ?? "").trim();
    triggerReason = String(body?.triggerReason ?? "manual_fallback").trim().toLowerCase();
    priority = Number(body?.priority ?? 70);
    idempotencyKey = body?.idempotencyKey ? String(body.idempotencyKey).trim() : null;
    payload = body?.payload && typeof body.payload === "object" ? body.payload : {};
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!connectionId) return errorResponse(400, "connectionId is required");

  const { data: connection, error: connectionError } = await auth.supabase
    .from("api_connections")
    .select("id, tenant_id")
    .eq("id", connectionId)
    .maybeSingle();

  if (connectionError) return errorResponse(400, "Could not load connection", connectionError.message);
  if (!connection) return errorResponse(404, "Connection not found");

  const startedAt = new Date().toISOString();

  await auth.supabase
    .from("api_connections")
    .update({
      status: "syncing",
      analysis_started_at: startedAt,
      last_error: null,
    })
    .eq("id", connection.id)
    .eq("tenant_id", connection.tenant_id);

  const { data: runningSync } = await auth.supabase
    .from("connection_sync_runs")
    .select("id")
    .eq("tenant_id", connection.tenant_id)
    .eq("connection_id", connection.id)
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let runningSyncId: string | null = runningSync?.id ?? null;

  if (runningSync?.id) {
    await auth.supabase
      .from("connection_sync_runs")
      .update({
        details: {
          stage: "schema_discovery_queued",
          source: "run-schema-discovery",
        },
      })
      .eq("id", runningSync.id);
  } else {
    const insertedSync = await auth.supabase
      .from("connection_sync_runs")
      .insert({
      tenant_id: connection.tenant_id,
      connection_id: connection.id,
      triggered_by: auth.user.id,
      status: "running",
      started_at: startedAt,
      details: {
        stage: "schema_discovery_queued",
        source: "run-schema-discovery",
      },
    })
      .select("id")
      .single();
    if (!insertedSync.error && insertedSync.data?.id) {
      runningSyncId = insertedSync.data.id;
    }
  }

  const derivedIdempotencyKey =
    idempotencyKey && idempotencyKey.length > 0
      ? idempotencyKey
      : `${connection.id}:${triggerReason}:${new Date().toISOString()}`;

  const safePriority = clampPriority(priority, 70);
  const rpcEnqueue = await auth.supabase.rpc("enqueue_connector_sync", {
    p_connection_id: connection.id,
    p_job_type: "schema_discovery",
    p_trigger_reason: triggerReason,
    p_priority: safePriority,
    p_idempotency_key: derivedIdempotencyKey,
    p_payload: {
      source: "run-schema-discovery",
      ...payload,
    },
  });

  let jobRecord:
    | { job_id: string; status: string | null; queue: string | null; scheduled_at: string | null }
    | null = null;
  let enqueueWarning: string | null = null;

  if (!rpcEnqueue.error && rpcEnqueue.data?.[0]?.job_id) {
    const row = rpcEnqueue.data[0];
    jobRecord = {
      job_id: String(row.job_id),
      status: row.status ?? null,
      queue: row.queue ?? null,
      scheduled_at: row.scheduled_at ?? null,
    };
  } else {
    const rpcMessage = rpcEnqueue.error?.message ?? "RPC enqueue returned no job id";
    if (shouldUseQueueFallback(rpcEnqueue.error)) {
      const queueRow = {
        tenant_id: connection.tenant_id,
        connection_id: connection.id,
        job_type: "schema_discovery",
        queue: "connector-sync",
        status: "queued",
        priority: safePriority,
        idempotency_key: derivedIdempotencyKey,
        trigger_reason: triggerReason,
        payload: {
          source: "run-schema-discovery",
          ...payload,
        },
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
      } else if (fallbackInsert.error?.code === "23505" && derivedIdempotencyKey) {
        const existing = await auth.supabase
          .from("connector_jobs")
          .select("id,status,queue,scheduled_at")
          .eq("tenant_id", connection.tenant_id)
          .eq("idempotency_key", derivedIdempotencyKey)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!existing.error && existing.data?.id) {
          fallbackJob = existing.data;
        } else {
          const message = `${rpcMessage}. Fallback queue lookup failed: ${existing.error?.message ?? "existing job not found"}`;
          if (runningSyncId) {
            await auth.supabase
              .from("connection_sync_runs")
              .update({
                status: "error",
                finished_at: new Date().toISOString(),
                error_message: message,
                details: {
                  stage: "schema_discovery_failed",
                  source: "run-schema-discovery",
                  queue_error: message,
                },
              })
              .eq("id", runningSyncId);
          }
          await auth.supabase
            .from("api_connections")
            .update({
              status: "error",
              health: "degraded",
              last_error: message,
            })
            .eq("id", connection.id)
            .eq("tenant_id", connection.tenant_id);
          return errorResponse(400, "Could not queue schema discovery", message);
        }
      } else {
        const message = `${rpcMessage}. Fallback queue insert failed: ${fallbackInsert.error?.message ?? "unknown error"}`;
        if (runningSyncId) {
          await auth.supabase
            .from("connection_sync_runs")
            .update({
              status: "error",
              finished_at: new Date().toISOString(),
              error_message: message,
              details: {
                stage: "schema_discovery_failed",
                source: "run-schema-discovery",
                queue_error: message,
              },
            })
            .eq("id", runningSyncId);
        }
        await auth.supabase
          .from("api_connections")
          .update({
            status: "error",
            health: "degraded",
            last_error: message,
          })
          .eq("id", connection.id)
          .eq("tenant_id", connection.tenant_id);
        return errorResponse(400, "Could not queue schema discovery", message);
      }

      if (!fallbackJob?.id) {
        return errorResponse(500, "Could not queue schema discovery", "Fallback queue returned no job id");
      }

      jobRecord = {
        job_id: fallbackJob.id,
        status: fallbackJob.status ?? null,
        queue: fallbackJob.queue ?? null,
        scheduled_at: fallbackJob.scheduled_at ?? null,
      };
      enqueueWarning = `enqueue_connector_sync RPC failed (${rpcMessage}). Used direct queue fallback.`;
    } else {
      const message = rpcMessage;
      if (runningSyncId) {
        await auth.supabase
          .from("connection_sync_runs")
          .update({
            status: "error",
            finished_at: new Date().toISOString(),
            error_message: message,
            details: {
              stage: "schema_discovery_failed",
              source: "run-schema-discovery",
              queue_error: message,
            },
          })
          .eq("id", runningSyncId);
      }
      await auth.supabase
        .from("api_connections")
        .update({
          status: "error",
          health: "degraded",
          last_error: message,
        })
        .eq("id", connection.id)
        .eq("tenant_id", connection.tenant_id);
      return errorResponse(400, "Could not queue schema discovery", message);
    }
  }

  if (!jobRecord?.job_id) return errorResponse(500, "Schema discovery queued without job id");

  return jsonResponse(200, {
    ok: true,
    mode: "queued",
    jobId: jobRecord.job_id,
    status: jobRecord.status ?? "queued",
    queue: jobRecord.queue ?? "connector-sync",
    scheduledAt: jobRecord.scheduled_at ?? null,
    message: "Schema discovery queued for background worker execution.",
    warning: enqueueWarning,
  });
});
