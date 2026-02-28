import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { createCheckoutSession } from "../_shared/billing-provider.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const provider = String(body.provider ?? "stripe").trim().toLowerCase();
  if (provider !== "stripe" && provider !== "razorpay") {
    return errorResponse(400, "provider must be stripe or razorpay");
  }

  const amountCents = Number(body.amountCents ?? body.amount_cents ?? 0);
  const currency = String(body.currency ?? "usd").trim();
  const successUrl = String(body.successUrl ?? body.success_url ?? "").trim();
  const cancelUrl = String(body.cancelUrl ?? body.cancel_url ?? "").trim();
  const priceId = body.priceId ? String(body.priceId) : null;
  const customerEmail = body.customerEmail ? String(body.customerEmail) : null;

  const tenantLookup = await auth.supabase.rpc("get_user_tenant_id");
  if (tenantLookup.error || !tenantLookup.data) {
    return errorResponse(400, "Could not resolve tenant", tenantLookup.error?.message ?? null);
  }
  const tenantId = String(tenantLookup.data);

  try {
    const session = await createCheckoutSession({
      provider,
      amountCents,
      currency,
      successUrl,
      cancelUrl,
      tenantId,
      customerEmail,
      metadata: body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : {},
      priceId,
    });

    const { error: checkoutError } = await auth.supabase.from("checkout_sessions").insert({
      tenant_id: tenantId,
      provider,
      provider_session_id: session.sessionId,
      status: "created",
      amount_cents: amountCents,
      currency,
      metadata: session.raw,
      created_by: auth.user.id,
    });

    if (checkoutError) return errorResponse(400, "Could not persist checkout session", checkoutError.message);

    await auth.supabase.from("billing_events").insert({
      tenant_id: tenantId,
      provider,
      provider_event_id: `checkout:${session.sessionId}`,
      event_type: "checkout.session.created",
      payload: session.raw,
      status: "processed",
      processed_at: new Date().toISOString(),
    });

    return jsonResponse(200, {
      ok: true,
      data: {
        provider: session.provider,
        sessionId: session.sessionId,
        checkoutUrl: session.checkoutUrl,
        razorpayKeyId: provider === "razorpay" ? Deno.env.get("RAZORPAY_KEY_ID") ?? null : null,
      },
      error: null,
    });
  } catch (error) {
    return errorResponse(400, "Could not create checkout session", error instanceof Error ? error.message : String(error));
  }
});
