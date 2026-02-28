/**
 * webhook-slack: Receives Slack Events API payloads and queues them for ingestion.
 *
 * Handles:
 * - URL verification challenge
 * - message events → ingestion_queue
 * - HMAC signature verification
 *
 * Build Rule: Governance rule 2 — never run processing here. Return 200 fast, queue for worker.
 */
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getServiceClient } from "../_shared/service.ts";
import { errorResponse, jsonResponse } from "../_shared/http.ts";

async function verifySlackSignature(req: Request, rawBody: string): Promise<boolean> {
  const signingSecret = Deno.env.get("SLACK_SIGNING_SECRET") ?? "";
  if (!signingSecret) {
    console.warn("SLACK_SIGNING_SECRET not set — skipping signature verification");
    return true;
  }

  const timestamp = req.headers.get("x-slack-request-timestamp") ?? "";
  const slackSignature = req.headers.get("x-slack-signature") ?? "";

  // Reject requests older than 5 minutes to prevent replay attacks
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > 300) {
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sigBasestring));
  const computed = "v0=" + Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (computed.length !== slackSignature.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ slackSignature.charCodeAt(i);
  }
  return diff === 0;
}

serve(async (req) => {
  if (req.method === "GET") {
    return jsonResponse(200, { status: "ok", service: "webhook-slack" });
  }

  if (req.method !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  const rawBody = await req.text();

  // Verify Slack signature
  const isValid = await verifySlackSignature(req, rawBody);
  if (!isValid) {
    return errorResponse(401, "Invalid Slack signature");
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "Invalid JSON");
  }

  // Handle URL verification challenge (Slack sends this when you configure the webhook URL)
  if (payload.type === "url_verification") {
    return jsonResponse(200, { challenge: payload.challenge });
  }

  // Handle event_callback
  if (payload.type !== "event_callback") {
    return jsonResponse(200, { status: "ignored", reason: "not an event_callback" });
  }

  const event = payload.event as Record<string, unknown> | undefined;
  if (!event) {
    return jsonResponse(200, { status: "ignored", reason: "no event" });
  }

  // Only process message events (skip bot messages to avoid loops)
  const eventType = String(event.type ?? "");
  const supportedTypes = ["message", "message.channels", "message.groups", "message.im"];
  if (!supportedTypes.includes(eventType)) {
    return jsonResponse(200, { status: "ignored", reason: `event type ${eventType} not processed` });
  }

  // Skip bot messages
  if (event.bot_id || event.subtype === "bot_message") {
    return jsonResponse(200, { status: "ignored", reason: "bot message" });
  }

  // Get the service client to write to ingestion_queue
  const service = getServiceClient();
  if (!service.ok) return service.response;

  // Find the tenant associated with this Slack team
  const teamId = String(payload.team_id ?? "");
  const { data: integrations } = await service.supabase
    .from("tenant_integrations")
    .select("tenant_id")
    .eq("integration_slug", "slack")
    .eq("status", "active")
    .limit(1);

  // If no integration found, still accept the event (return 200 to Slack)
  // but don't queue it
  if (!integrations || integrations.length === 0) {
    console.warn(`No active Slack integration found for team ${teamId}`);
    return jsonResponse(200, { status: "ok", queued: false });
  }

  const tenantId = (integrations[0] as Record<string, unknown>).tenant_id as string;

  // Queue the event for async processing by the ingestion worker
  const { error: queueError } = await service.supabase
    .from("ingestion_queue")
    .insert({
      tenant_id: tenantId,
      source_kind: "slack_message",
      source_ref: tenantId, // Use tenant_id as ref for Slack events
      payload: {
        team_id: teamId,
        channel: event.channel,
        user: event.user,
        text: event.text,
        ts: event.ts,
        thread_ts: event.thread_ts,
        event_type: eventType,
      },
      status: "pending",
    });

  if (queueError) {
    console.error("Failed to queue Slack event:", queueError.message);
    // Still return 200 to Slack to prevent retries
    return jsonResponse(200, { status: "ok", queued: false, error: queueError.message });
  }

  // Log context event
  await service.supabase.from("context_events").insert({
    tenant_id: tenantId,
    source_type: "slack",
    source_id: String(event.channel ?? ""),
    event_type: "message_received",
    content: String(event.text ?? ""),
    metadata: {
      user: event.user,
      ts: event.ts,
      channel: event.channel,
      team_id: teamId,
    },
  });

  return jsonResponse(200, { status: "ok", queued: true });
});
