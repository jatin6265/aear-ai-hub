import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getServiceClient, requireWorkerToken } from "../_shared/service.ts";

function normalizeStatus(value: string) {
  const normalized = value.trim().toLowerCase();
  if (["queued", "running", "success", "error", "dead_letter", "cancelled"].includes(normalized)) {
    return normalized;
  }
  return "error";
}

function retryDelaySeconds(attemptCount: number) {
  const exponential = 15 * Math.pow(2, Math.max(0, attemptCount - 1));
  return Math.min(900, Math.round(exponential));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const workerAuth = requireWorkerToken(req);
  if (!workerAuth.ok) return workerAuth.response;

  const service = getServiceClient();
  if (!service.ok) return service.response;

  let deliveryId = "";
  let status = "error";
  let workerId = "webhook-worker";
  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let errorMessage: string | null = null;

  try {
    const body = await req.json();
    deliveryId = String(body?.deliveryId ?? "").trim();
    status = normalizeStatus(String(body?.status ?? "error"));
    workerId = String(body?.workerId ?? "webhook-worker").trim() || "webhook-worker";
    responseStatus = body?.responseStatus ? Number(body.responseStatus) : null;
    responseBody = body?.responseBody ? String(body.responseBody) : null;
    errorMessage = body?.error ? String(body.error) : null;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!deliveryId) return errorResponse(400, "deliveryId is required");

  const { data: delivery, error: deliveryError } = await service.supabase
    .from("webhook_deliveries")
    .select("id, tenant_id, attempt_count, max_attempts, status, payload")
    .eq("id", deliveryId)
    .maybeSingle();

  if (deliveryError) return errorResponse(400, "Could not load webhook delivery", deliveryError.message);
  if (!delivery) return errorResponse(404, "Webhook delivery not found");

  const now = new Date().toISOString();
  const nextAttempt = status === "error" ? Number(delivery.attempt_count ?? 0) + 1 : Number(delivery.attempt_count ?? 0);
  const maxAttempts = Number(delivery.max_attempts ?? 6);
  const shouldRetry = status === "error" && nextAttempt < maxAttempts;
  const finalStatus = shouldRetry ? "queued" : status === "error" && nextAttempt >= maxAttempts ? "dead_letter" : status;
  const retryAt = shouldRetry ? new Date(Date.now() + retryDelaySeconds(nextAttempt) * 1000).toISOString() : null;

  const { error: updateError } = await service.supabase
    .from("webhook_deliveries")
    .update({
      status: finalStatus,
      attempt_count: nextAttempt,
      last_error: errorMessage,
      updated_at: now,
      started_at: delivery.status === "queued" ? now : undefined,
      finished_at: ["success", "cancelled", "dead_letter"].includes(finalStatus) ? now : null,
      scheduled_at: retryAt,
      payload: {
        ...(delivery.payload ?? {}),
        last_attempt: {
          at: now,
          worker_id: workerId,
          response_status: responseStatus,
          response_body: responseBody,
          error: errorMessage,
          status: finalStatus,
        },
      },
    })
    .eq("id", delivery.id);

  if (updateError) return errorResponse(400, "Could not update webhook delivery", updateError.message);

  return jsonResponse(200, {
    ok: true,
    deliveryId,
    status: finalStatus,
    retryAt,
    attemptCount: nextAttempt,
  });
});
