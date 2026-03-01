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

function extractTelegramMessages(update: Record<string, unknown>): {
  messages: WebhookMessage[];
} {
  const containers = [
    asRecord(update.message),
    asRecord(update.edited_message),
    asRecord(update.channel_post),
    asRecord(update.edited_channel_post),
  ];
  const messages: WebhookMessage[] = [];

  for (const message of containers) {
    if (Object.keys(message).length === 0) continue;
    const chat = asRecord(message.chat);
    const from = asRecord(message.from);
    const text = toSafeText(message.text) || toSafeText(message.caption);
    if (!text) continue;

    const chatId = toSafeText(chat.id, "unknown_chat");
    const messageId = toSafeText(message.message_id);
    messages.push({
      sourceKind: "telegram_message",
      sourceType: "telegram",
      sourceId: messageId || chatId,
      eventType: "message_received",
      content: text,
      payload: {
        chat_id: chatId,
        chat_type: toSafeText(chat.type, "unknown"),
        message_id: messageId || null,
        from_id: toSafeText(from.id) || null,
        from_username: toSafeText(from.username) || null,
        date: toSafeText(message.date) || null,
      },
      metadata: {
        chat_id: chatId,
        chat_title: toSafeText(chat.title) || null,
        from_username: toSafeText(from.username) || null,
      },
    });
  }

  return {
    messages,
  };
}

serve(async (req) => {
  if (req.method === "GET") {
    return okEnvelope({ service: "webhook-telegram" });
  }

  if (req.method !== "POST") return errorEnvelope(405, "Method not allowed");

  const expectedSecret = toSafeText(Deno.env.get("TELEGRAM_WEBHOOK_SECRET_TOKEN"));
  if (expectedSecret) {
    const incoming = toSafeText(req.headers.get("x-telegram-bot-api-secret-token"));
    if (!incoming || !timedSafeEqual(incoming, expectedSecret)) {
      return errorEnvelope(401, "Invalid Telegram webhook secret token");
    }
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json() as Record<string, unknown>;
  } catch {
    return errorEnvelope(400, "Invalid JSON");
  }

  const extracted = extractTelegramMessages(payload);
  if (extracted.messages.length === 0) {
    return okEnvelope({ service: "webhook-telegram", queued: 0, ignored: true });
  }

  const service = getServiceClient();
  if (!service.ok) return service.response;

  const tenantId = await resolveTenantFromIntegration({
    supabase: service.supabase,
    integrationSlug: "telegram",
  });

  if (!tenantId) {
    return okEnvelope({
      service: "webhook-telegram",
      queued: 0,
      ignored: true,
      reason: "No active Telegram integration",
    });
  }

  const queued = await queueMessagesAndAudit({
    supabase: service.supabase,
    tenantId,
    sourceLabel: "telegram",
    messages: extracted.messages,
  });

  return okEnvelope({
    service: "webhook-telegram",
    queued: queued.queued,
    tenant_id: tenantId,
  });
});
