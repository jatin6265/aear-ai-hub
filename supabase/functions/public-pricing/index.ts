import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getServiceClient } from "../_shared/service.ts";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeInterval(value: unknown): "monthly" | "annual" {
  const interval = clean(value).toLowerCase();
  return interval === "annual" ? "annual" : "monthly";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return errorResponse(405, "Method not allowed");

  const service = getServiceClient();
  if (!service.ok) return service.response;

  let interval: "monthly" | "annual" = "monthly";

  if (req.method === "GET") {
    const url = new URL(req.url);
    interval = normalizeInterval(url.searchParams.get("billingInterval"));
  } else {
    try {
      const body = (await req.json()) as { billingInterval?: string };
      interval = normalizeInterval(body?.billingInterval);
    } catch {
      return errorResponse(400, "Invalid JSON body");
    }
  }

  const { data, error } = await service.supabase.rpc("get_public_pricing_payload", {
    p_billing_interval: interval,
  });

  if (error) return errorResponse(400, "Failed to load pricing payload", error.message);

  return jsonResponse(200, {
    ok: true,
    billingInterval: interval,
    payload: data ?? null,
  });
});
