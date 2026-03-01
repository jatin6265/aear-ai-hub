import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getServiceClient } from "../_shared/service.ts";
import {
  asRecord,
  errorEnvelope,
  okEnvelope,
  queueMessagesAndAudit,
  resolveTenantFromIntegration,
  timedSafeEqual,
  toSafeText,
  type WebhookMessage,
} from "../_shared/webhook-common.ts";

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractTeamsMessages(payload: Record<string, unknown>): {
  tenantHint: string;
  messages: WebhookMessage[];
} {
  const notifications = Array.isArray(payload.value) ? (payload.value as unknown[]) : [];
  const messages: WebhookMessage[] = [];
  let tenantHint = "";

  for (const itemRaw of notifications) {
    const item = asRecord(itemRaw);
    const resourceData = asRecord(item.resourceData);
    const body = asRecord(resourceData.body);

    const tenantId = toSafeText(item.tenantId) || toSafeText(resourceData.tenantId);
    tenantHint = tenantHint || tenantId;

    const bodyContent = stripHtml(toSafeText(body.content));
    const resource = toSafeText(item.resource);
    const changeType = toSafeText(item.changeType, "updated");
    const content = bodyContent || `${changeType} event on ${resource || "teams resource"}`;
    const sourceId = toSafeText(resourceData.id) || resource || "teams_event";

    messages.push({
      sourceKind: "microsoft_teams_event",
      sourceType: "microsoft_teams",
      sourceId,
      eventType: `notification_${changeType}`,
      content,
      payload: {
        subscription_id: toSafeText(item.subscriptionId) || null,
        change_type: changeType,
        resource,
        tenant_id: tenantId || null,
      },
      metadata: {
        tenant_id: tenantId || null,
        client_state: toSafeText(item.clientState) || null,
      },
    });
  }

  return { tenantHint, messages };
}

serve(async (req) => {
  const url = new URL(req.url);
  const validationToken = toSafeText(url.searchParams.get("validationToken"));
  if (validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (req.method === "GET") {
    return okEnvelope({ service: "webhook-teams" });
  }
  if (req.method !== "POST") return errorEnvelope(405, "Method not allowed");

  let payload: Record<string, unknown>;
  try {
    payload = await req.json() as Record<string, unknown>;
  } catch {
    return errorEnvelope(400, "Invalid JSON");
  }

  const expectedClientState = toSafeText(Deno.env.get("TEAMS_WEBHOOK_CLIENT_STATE"));
  if (expectedClientState) {
    const notifications = Array.isArray(payload.value) ? (payload.value as unknown[]) : [];
    const hasMismatch = notifications.some((item) => {
      const clientState = toSafeText(asRecord(item).clientState);
      return clientState && !timedSafeEqual(clientState, expectedClientState);
    });
    if (hasMismatch) return errorEnvelope(401, "Invalid Teams clientState");
  }

  const extracted = extractTeamsMessages(payload);
  if (extracted.messages.length === 0) {
    return okEnvelope({ service: "webhook-teams", queued: 0, ignored: true });
  }

  const service = getServiceClient();
  if (!service.ok) return service.response;

  const tenantId = await resolveTenantFromIntegration({
    supabase: service.supabase,
    integrationSlug: "microsoft_teams",
    matcher: (row) => {
      const configured = toSafeText(asRecord(row.config).tenant_id);
      return !configured || !extracted.tenantHint || timedSafeEqual(configured, extracted.tenantHint);
    },
  });

  if (!tenantId) {
    return okEnvelope({
      service: "webhook-teams",
      queued: 0,
      ignored: true,
      reason: "No active Microsoft Teams integration",
    });
  }

  const queued = await queueMessagesAndAudit({
    supabase: service.supabase,
    tenantId,
    sourceLabel: "microsoft_teams",
    externalRef: extracted.tenantHint || undefined,
    messages: extracted.messages,
  });

  return okEnvelope({
    service: "webhook-teams",
    queued: queued.queued,
    tenant_id: tenantId,
  });
});
