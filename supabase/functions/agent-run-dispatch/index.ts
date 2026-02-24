import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

type DispatchRequest = {
  agentId?: string;
  input?: Record<string, unknown>;
  sessionId?: string | null;
  triggerType?: "manual" | "event" | "schedule" | "webhook" | "api";
  estimatedCredits?: number;
  priority?: number;
  idempotencyKey?: string | null;
  invokedVia?: string;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let body: DispatchRequest;
  try {
    body = (await req.json()) as DispatchRequest;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const agentId = String(body.agentId ?? "").trim();
  if (!agentId) return errorResponse(400, "agentId is required");

  const estimatedCredits = Number(body.estimatedCredits ?? 10);
  const priority = Number(body.priority ?? 50);

  const { data, error } = await auth.supabase.rpc("enqueue_agent_run", {
    p_agent_id: agentId,
    p_input: body.input ?? {},
    p_session_id: body.sessionId ? String(body.sessionId) : null,
    p_trigger_type: body.triggerType ?? "manual",
    p_estimated_credits: Number.isFinite(estimatedCredits) ? estimatedCredits : 10,
    p_priority: Number.isFinite(priority) ? priority : 50,
    p_idempotency_key: body.idempotencyKey ? String(body.idempotencyKey) : null,
    p_invoked_via: String(body.invokedVia ?? "app"),
  });

  if (error) return errorResponse(400, "Failed to enqueue agent run", error.message);

  const row = data?.[0];
  if (!row) return errorResponse(500, "Run enqueue returned no payload");

  return jsonResponse(200, {
    ok: true,
    runId: row.run_id,
    jobId: row.job_id,
    reservationId: row.reservation_id,
    status: row.status,
  });
});
