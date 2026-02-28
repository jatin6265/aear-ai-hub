export type CheckoutProvider = "stripe" | "razorpay";

export type CheckoutRequest = {
  provider: CheckoutProvider;
  amountCents: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
  tenantId: string;
  customerEmail?: string | null;
  metadata?: Record<string, unknown>;
  priceId?: string | null;
};

export type CheckoutResponse = {
  provider: CheckoutProvider;
  sessionId: string;
  checkoutUrl?: string | null;
  raw: Record<string, unknown>;
};

function asString(value: unknown) {
  return String(value ?? "").trim();
}

function assertPositiveInt(value: number, field: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
}

function validateCheckoutInput(input: CheckoutRequest) {
  assertPositiveInt(input.amountCents, "amountCents");
  if (!asString(input.currency)) throw new Error("currency is required");
  if (!asString(input.successUrl)) throw new Error("successUrl is required");
  if (!asString(input.cancelUrl)) throw new Error("cancelUrl is required");
  if (!asString(input.tenantId)) throw new Error("tenantId is required");
}

function toBase64(value: string) {
  return btoa(value);
}

export async function createCheckoutSession(input: CheckoutRequest): Promise<CheckoutResponse> {
  validateCheckoutInput(input);
  if (input.provider === "razorpay") {
    return await createRazorpayOrder(input);
  }
  return await createStripeCheckout(input);
}

async function createStripeCheckout(input: CheckoutRequest): Promise<CheckoutResponse> {
  const secret = asString(Deno.env.get("STRIPE_SECRET_KEY"));
  if (!secret) throw new Error("STRIPE_SECRET_KEY is not configured");

  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("success_url", input.successUrl);
  params.set("cancel_url", input.cancelUrl);

  if (input.priceId) {
    params.set("line_items[0][price]", input.priceId);
    params.set("line_items[0][quantity]", "1");
  } else {
    params.set("line_items[0][price_data][currency]", input.currency.toLowerCase());
    params.set("line_items[0][price_data][product_data][name]", "OpsAI Subscription");
    params.set("line_items[0][price_data][unit_amount]", String(Math.round(input.amountCents)));
    params.set("line_items[0][quantity]", "1");
    params.set("mode", "payment");
  }

  params.set("metadata[tenant_id]", input.tenantId);
  if (input.customerEmail) params.set("customer_email", input.customerEmail);

  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    params.set(`metadata[${key}]`, String(value ?? ""));
  }

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Stripe checkout creation failed: ${JSON.stringify(payload)}`);
  }

  return {
    provider: "stripe",
    sessionId: asString(payload.id),
    checkoutUrl: asString(payload.url) || null,
    raw: payload,
  };
}

async function createRazorpayOrder(input: CheckoutRequest): Promise<CheckoutResponse> {
  const keyId = asString(Deno.env.get("RAZORPAY_KEY_ID"));
  const keySecret = asString(Deno.env.get("RAZORPAY_KEY_SECRET"));
  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required");
  }

  const amount = Math.round(input.amountCents);
  const currency = input.currency.toUpperCase();

  const payload = {
    amount,
    currency,
    receipt: `opsai_${input.tenantId}_${Date.now()}`,
    notes: {
      tenant_id: input.tenantId,
      ...(input.metadata ?? {}),
    },
  };

  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      authorization: `Basic ${toBase64(`${keyId}:${keySecret}`)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const responsePayload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Razorpay order creation failed: ${JSON.stringify(responsePayload)}`);
  }

  return {
    provider: "razorpay",
    sessionId: asString(responsePayload.id),
    checkoutUrl: null,
    raw: responsePayload,
  };
}

export async function verifyRazorpayWebhook(req: Request, rawBody: string): Promise<boolean> {
  const webhookSecret = asString(Deno.env.get("RAZORPAY_WEBHOOK_SECRET"));
  if (!webhookSecret) return false;

  const signature = asString(req.headers.get("x-razorpay-signature"));
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computed = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (computed.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i += 1) {
    diff |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}
