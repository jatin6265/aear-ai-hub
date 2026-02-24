import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getServiceClient } from "../_shared/service.ts";

function parseStripeSignature(header: string) {
  const items = header.split(",").map((item) => item.trim());
  const parsed: Record<string, string[]> = {};

  for (const item of items) {
    const [key, value] = item.split("=");
    if (!key || !value) continue;
    if (!parsed[key]) parsed[key] = [];
    parsed[key].push(value);
  }

  const timestamp = parsed.t?.[0] ?? null;
  const signatures = parsed.v1 ?? [];
  return { timestamp, signatures };
}

function toHex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function computeStripeSignature(payload: string, timestamp: string, secret: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${timestamp}.${payload}`);
  const keyData = encoder.encode(secret);

  const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, data);
  return toHex(signature);
}

function pickTenantIdFromMetadata(obj: Record<string, unknown>) {
  const metadata = obj?.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const tenantId = (metadata as Record<string, unknown>).tenant_id;
  return tenantId ? String(tenantId) : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return errorResponse(500, "Missing STRIPE_WEBHOOK_SECRET");

  const signatureHeader = req.headers.get("stripe-signature") ?? "";
  if (!signatureHeader) return errorResponse(401, "Missing stripe-signature header");

  const parsedSignature = parseStripeSignature(signatureHeader);
  if (!parsedSignature.timestamp || parsedSignature.signatures.length === 0) {
    return errorResponse(401, "Invalid stripe signature header");
  }

  const payload = await req.text();
  const computed = await computeStripeSignature(payload, parsedSignature.timestamp, secret);
  if (!parsedSignature.signatures.includes(computed)) {
    return errorResponse(401, "Webhook signature mismatch");
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "Invalid JSON payload");
  }

  const eventId = String(event.id ?? "").trim();
  const eventType = String(event.type ?? "").trim();
  if (!eventId || !eventType) return errorResponse(400, "Stripe event missing id or type");

  const service = getServiceClient();
  if (!service.ok) return service.response;

  const object = ((event.data as Record<string, unknown> | undefined)?.object ?? {}) as Record<string, unknown>;
  const customerId = object.customer ? String(object.customer) : null;

  let tenantId = pickTenantIdFromMetadata(object);
  if (!tenantId && customerId) {
    const { data: tenant } = await service.supabase
      .from("tenants")
      .select("id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    tenantId = tenant?.id ?? null;
  }

  const { error: eventInsertError } = await service.supabase.from("billing_events").insert({
    tenant_id: tenantId,
    provider: "stripe",
    provider_event_id: eventId,
    event_type: eventType,
    payload: event,
    status: "received",
  });

  if (eventInsertError) {
    if (String(eventInsertError.code) === "23505") {
      return jsonResponse(200, { ok: true, duplicate: true, eventId, eventType });
    }
    return errorResponse(400, "Could not record billing event", eventInsertError.message);
  }

  try {
    if (tenantId && ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(eventType)) {
      const status = String(object.status ?? "trialing").toLowerCase();
      const stripeSubscriptionId = String(object.id ?? "");
      const periodStart = object.current_period_start ? new Date(Number(object.current_period_start) * 1000).toISOString() : null;
      const periodEnd = object.current_period_end ? new Date(Number(object.current_period_end) * 1000).toISOString() : null;

      const itemData = Array.isArray((object.items as Record<string, unknown> | undefined)?.data)
        ? (((object.items as Record<string, unknown>).data as unknown[]) ?? [])
        : [];
      const firstItem = (itemData[0] ?? {}) as Record<string, unknown>;
      const price = (firstItem.price ?? {}) as Record<string, unknown>;
      const metadata = (object.metadata ?? {}) as Record<string, unknown>;
      const plan = String(metadata.plan ?? price.nickname ?? "starter").toLowerCase();

      await service.supabase
        .from("subscriptions")
        .upsert(
          {
            tenant_id: tenantId,
            plan,
            status,
            stripe_subscription_id: stripeSubscriptionId || null,
            billing_cycle: String(metadata.billing_cycle ?? "monthly"),
            current_period_start: periodStart,
            current_period_end: periodEnd,
            trial_ends_at: object.trial_end ? new Date(Number(object.trial_end) * 1000).toISOString() : null,
          },
          { onConflict: "tenant_id" },
        );

      await service.supabase.rpc("reconcile_billing_state", { p_tenant_id: tenantId });
    }

    if (tenantId && eventType.startsWith("invoice.")) {
      await service.supabase
        .from("invoice_snapshots")
        .upsert(
          {
            tenant_id: tenantId,
            provider: "stripe",
            provider_invoice_id: String(object.id ?? ""),
            provider_subscription_id: object.subscription ? String(object.subscription) : null,
            currency: String(object.currency ?? "usd"),
            subtotal_cents: Number(object.subtotal ?? 0),
            tax_cents: Number(object.tax ?? 0),
            total_cents: Number(object.total ?? 0),
            amount_paid_cents: Number(object.amount_paid ?? 0),
            amount_due_cents: Number(object.amount_due ?? 0),
            invoice_status: String(object.status ?? "draft"),
            invoice_url: object.invoice_pdf ? String(object.invoice_pdf) : null,
            hosted_invoice_url: object.hosted_invoice_url ? String(object.hosted_invoice_url) : null,
            period_start: object.period_start ? new Date(Number(object.period_start) * 1000).toISOString() : null,
            period_end: object.period_end ? new Date(Number(object.period_end) * 1000).toISOString() : null,
            due_at: object.due_date ? new Date(Number(object.due_date) * 1000).toISOString() : null,
            paid_at: object.status_transitions && typeof object.status_transitions === "object" && (object.status_transitions as Record<string, unknown>).paid_at
              ? new Date(Number((object.status_transitions as Record<string, unknown>).paid_at) * 1000).toISOString()
              : null,
            metadata: object,
          },
          { onConflict: "provider,provider_invoice_id" },
        );
    }

    await service.supabase
      .from("billing_events")
      .update({
        tenant_id: tenantId,
        status: "processed",
        processed_at: new Date().toISOString(),
        error: null,
      })
      .eq("provider", "stripe")
      .eq("provider_event_id", eventId);

    return jsonResponse(200, { ok: true, eventId, eventType });
  } catch (error) {
    await service.supabase
      .from("billing_events")
      .update({
        tenant_id: tenantId,
        status: "error",
        processed_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Processing failed",
      })
      .eq("provider", "stripe")
      .eq("provider_event_id", eventId);

    return errorResponse(400, "Stripe webhook processing failed", error instanceof Error ? error.message : null);
  }
});
