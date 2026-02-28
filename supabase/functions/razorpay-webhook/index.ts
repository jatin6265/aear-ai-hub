import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getServiceClient } from "../_shared/service.ts";
import { verifyRazorpayWebhook } from "../_shared/billing-provider.ts";

function asRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function extractTenantId(payload: Record<string, unknown>) {
  const notes = asRecord(payload.notes);
  if (notes.tenant_id) return String(notes.tenant_id);
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const rawBody = await req.text();
  const valid = await verifyRazorpayWebhook(req, rawBody);
  if (!valid) return errorResponse(401, "Invalid Razorpay webhook signature");

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "Invalid JSON payload");
  }

  const eventType = String(event.event ?? "").trim();
  const payload = asRecord(event.payload);
  const paymentEntity = asRecord(asRecord(payload.payment).entity);
  const subscriptionEntity = asRecord(asRecord(payload.subscription).entity);
  const invoiceEntity = asRecord(asRecord(payload.invoice).entity);

  const providerEventId =
    String(event.id ?? "").trim() ||
    String(paymentEntity.id ?? subscriptionEntity.id ?? invoiceEntity.id ?? crypto.randomUUID());

  const tenantId =
    extractTenantId(paymentEntity) ??
    extractTenantId(subscriptionEntity) ??
    extractTenantId(invoiceEntity);

  const service = getServiceClient();
  if (!service.ok) return service.response;

  const { error: eventError } = await service.supabase.from("billing_events").insert({
    tenant_id: tenantId,
    provider: "razorpay",
    provider_event_id: providerEventId,
    event_type: eventType || "unknown",
    payload: event,
    status: "received",
  });

  if (eventError) {
    if (String(eventError.code) === "23505") {
      return jsonResponse(200, { ok: true, duplicate: true, providerEventId });
    }
    return errorResponse(400, "Could not persist Razorpay event", eventError.message);
  }

  try {
    if (tenantId && Object.keys(subscriptionEntity).length > 0) {
      await service.supabase.from("subscriptions").upsert(
        {
          tenant_id: tenantId,
          plan: String((asRecord(subscriptionEntity.notes).plan ?? "starter")),
          status: String(subscriptionEntity.status ?? "active"),
          stripe_subscription_id: null,
          current_period_start: subscriptionEntity.current_start
            ? new Date(Number(subscriptionEntity.current_start) * 1000).toISOString()
            : null,
          current_period_end: subscriptionEntity.current_end
            ? new Date(Number(subscriptionEntity.current_end) * 1000).toISOString()
            : null,
        },
        { onConflict: "tenant_id" },
      );
    }

    if (tenantId && Object.keys(invoiceEntity).length > 0) {
      await service.supabase.from("invoice_snapshots").upsert(
        {
          tenant_id: tenantId,
          provider: "razorpay",
          provider_invoice_id: String(invoiceEntity.id ?? providerEventId),
          provider_subscription_id: subscriptionEntity.id ? String(subscriptionEntity.id) : null,
          currency: String(invoiceEntity.currency ?? "inr").toLowerCase(),
          subtotal_cents: Number(invoiceEntity.amount ?? 0),
          total_cents: Number(invoiceEntity.amount_paid ?? invoiceEntity.amount ?? 0),
          amount_paid_cents: Number(invoiceEntity.amount_paid ?? 0),
          amount_due_cents: Number(invoiceEntity.amount_due ?? 0),
          invoice_status: String(invoiceEntity.status ?? "issued"),
          metadata: event,
          paid_at: invoiceEntity.paid_at ? new Date(Number(invoiceEntity.paid_at) * 1000).toISOString() : null,
        },
        { onConflict: "provider,provider_invoice_id" },
      );
    }

    await service.supabase
      .from("billing_events")
      .update({ status: "processed", processed_at: new Date().toISOString(), error: null })
      .eq("provider", "razorpay")
      .eq("provider_event_id", providerEventId);

    return jsonResponse(200, { ok: true, providerEventId, eventType });
  } catch (error) {
    await service.supabase
      .from("billing_events")
      .update({ status: "error", processed_at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) })
      .eq("provider", "razorpay")
      .eq("provider_event_id", providerEventId);

    return errorResponse(400, "Razorpay webhook processing failed", error instanceof Error ? error.message : String(error));
  }
});
