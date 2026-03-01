import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getServiceClient } from "../_shared/service.ts";
import {
  asRecord,
  computeHmacHexSha256,
  errorEnvelope,
  okEnvelope,
  queueMessagesAndAudit,
  resolveTenantFromIntegration,
  timedSafeEqual,
  toSafeText,
  type WebhookMessage,
} from "../_shared/webhook-common.ts";

async function verifyWhatsAppSignature(req: Request, rawBody: string): Promise<boolean> {
  const appSecret = toSafeText(Deno.env.get("WHATSAPP_APP_SECRET"));
  if (!appSecret) return true;
  const header = toSafeText(req.headers.get("x-hub-signature-256"));
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = `sha256=${await computeHmacHexSha256(appSecret, rawBody)}`;
  return timedSafeEqual(expected, header);
}

function extractMessages(payload: Record<string, unknown>): {
  phoneNumberId: string;
  messages: WebhookMessage[];
} {
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  const messages: WebhookMessage[] = [];
  let phoneNumberId = "";

  for (const entry of entries) {
    const changeItems = Array.isArray(asRecord(entry).changes) ? (asRecord(entry).changes as unknown[]) : [];
    for (const change of changeItems) {
      const value = asRecord(asRecord(change).value);
      const metadata = asRecord(value.metadata);
      phoneNumberId = phoneNumberId || toSafeText(metadata.phone_number_id);
      const itemMessages = Array.isArray(value.messages) ? (value.messages as unknown[]) : [];
      for (const messageRaw of itemMessages) {
        const message = asRecord(messageRaw);
        const text = toSafeText(asRecord(message.text).body) || toSafeText(message.caption) || toSafeText(message.type);
        if (!text) continue;
        const from = toSafeText(message.from, "unknown");
        const timestamp = toSafeText(message.timestamp);
        const messageId = toSafeText(message.id);
        messages.push({
          sourceKind: "whatsapp_message",
          sourceType: "whatsapp",
          sourceId: messageId || from,
          eventType: "message_received",
          content: text,
          payload: {
            from,
            timestamp,
            message_id: messageId || null,
            phone_number_id: phoneNumberId || null,
            type: toSafeText(message.type, "text"),
          },
          metadata: {
            from,
            timestamp,
            phone_number_id: phoneNumberId || null,
          },
        });
      }
    }
  }

  return { phoneNumberId, messages };
}

serve(async (req) => {
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const challenge = url.searchParams.get("hub.challenge");
    const verifyToken = url.searchParams.get("hub.verify_token");
    const expectedToken = toSafeText(Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN"));

    if (!mode && !challenge) {
      return okEnvelope({ service: "webhook-whatsapp" });
    }

    if (mode === "subscribe" && challenge && expectedToken && verifyToken === expectedToken) {
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return errorEnvelope(403, "Webhook verification failed");
  }

  if (req.method !== "POST") return errorEnvelope(405, "Method not allowed");

  const rawBody = await req.text();
  if (!(await verifyWhatsAppSignature(req, rawBody))) {
    return errorEnvelope(401, "Invalid WhatsApp signature");
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return errorEnvelope(400, "Invalid JSON");
  }

  const extracted = extractMessages(payload);
  if (extracted.messages.length === 0) {
    return okEnvelope({ service: "webhook-whatsapp", queued: 0, ignored: true });
  }

  const service = getServiceClient();
  if (!service.ok) return service.response;

  const tenantId = await resolveTenantFromIntegration({
    supabase: service.supabase,
    integrationSlug: "whatsapp",
    matcher: (row) => {
      const rowConfig = asRecord(row.config);
      const phoneId = toSafeText(rowConfig.phone_number_id);
      return !extracted.phoneNumberId || !phoneId || phoneId === extracted.phoneNumberId;
    },
  });

  if (!tenantId) {
    return okEnvelope({
      service: "webhook-whatsapp",
      queued: 0,
      ignored: true,
      reason: "No active WhatsApp integration",
    });
  }

  const queued = await queueMessagesAndAudit({
    supabase: service.supabase,
    tenantId,
    sourceLabel: "whatsapp",
    externalRef: extracted.phoneNumberId || undefined,
    messages: extracted.messages,
  });

  return okEnvelope({
    service: "webhook-whatsapp",
    queued: queued.queued,
    tenant_id: tenantId,
  });
});
