import { jsonResponse } from "./http.ts";

type IntegrationRow = {
  tenant_id: string;
  integration_slug: string;
  config?: Record<string, unknown> | null;
};

export type WebhookMessage = {
  sourceKind: string;
  sourceType: string;
  sourceId: string;
  eventType: string;
  content: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function toSafeText(value: unknown, fallback = ""): string {
  const text = typeof value === "string" ? value : value == null ? fallback : String(value);
  return text.trim();
}

export function timedSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function computeHmacHexSha256(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function resolveTenantFromIntegration(input: {
  supabase: any;
  integrationSlug: string;
  matcher?: (row: IntegrationRow) => boolean;
}): Promise<string | null> {
  const { data, error } = await input.supabase
    .from("tenant_integrations")
    .select("tenant_id,integration_slug,config")
    .eq("integration_slug", input.integrationSlug)
    .eq("status", "active")
    .limit(200);

  if (error) {
    throw new Error(`Could not load tenant_integrations: ${error.message}`);
  }

  const rows = ((data || []) as Record<string, unknown>[]).map((row) => ({
    tenant_id: toSafeText(row.tenant_id),
    integration_slug: toSafeText(row.integration_slug),
    config: asRecord(row.config),
  }));

  if (rows.length === 0) return null;
  if (typeof input.matcher === "function") {
    const matched = rows.find((row) => input.matcher?.(row));
    if (matched?.tenant_id) return matched.tenant_id;
  }

  return rows[0].tenant_id || null;
}

export async function queueMessagesAndAudit(input: {
  supabase: any;
  tenantId: string;
  sourceLabel: string;
  messages: WebhookMessage[];
  externalRef?: string;
}): Promise<{ queued: number }> {
  if (input.messages.length === 0) return { queued: 0 };

  const ingestionRows = input.messages.map((message) => ({
    tenant_id: input.tenantId,
    source_kind: message.sourceKind,
    source_ref: input.tenantId,
    payload: {
      ...message.payload,
      content: message.content,
      metadata: {
        ...(message.metadata || {}),
        source_type: message.sourceType,
        source_id: message.sourceId,
      },
    },
    status: "pending",
  }));

  const contextRows = input.messages.map((message) => ({
    tenant_id: input.tenantId,
    source_type: message.sourceType,
    source_id: message.sourceId,
    event_type: message.eventType,
    content: message.content,
    metadata: {
      ...(message.metadata || {}),
      webhook_source: input.sourceLabel,
      external_ref: input.externalRef || null,
    },
  }));

  const { error: ingestionError } = await input.supabase.from("ingestion_queue").insert(ingestionRows);
  if (ingestionError) {
    throw new Error(`Failed to queue ingestion rows: ${ingestionError.message}`);
  }

  const { error: contextError } = await input.supabase.from("context_events").insert(contextRows);
  if (contextError) {
    throw new Error(`Failed to write context events: ${contextError.message}`);
  }

  await input.supabase.from("audit_logs").insert({
    tenant_id: input.tenantId,
    action: `webhook.${input.sourceLabel}.ingest`,
    resource: input.sourceLabel,
    risk_level: "low",
    status: "success",
    details: {
      queued_count: input.messages.length,
      source: input.sourceLabel,
      external_ref: input.externalRef || null,
    },
  });

  return { queued: input.messages.length };
}

export function okEnvelope(data: Record<string, unknown>) {
  return jsonResponse(200, {
    ok: true,
    data,
    error: null,
  });
}

export function errorEnvelope(status: number, message: string, details?: unknown) {
  return jsonResponse(status, {
    ok: false,
    data: null,
    error: {
      message,
      details: details ?? null,
    },
  });
}
