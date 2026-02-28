import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const provider = String(body.provider ?? "stripe").trim().toLowerCase();
  const windowDays = Number.isFinite(Number(body.windowDays)) ? Math.max(1, Math.min(Number(body.windowDays), 365)) : 1;

  const tenantLookup = await auth.supabase.rpc("get_user_tenant_id");
  if (tenantLookup.error || !tenantLookup.data) {
    return errorResponse(400, "Could not resolve tenant", tenantLookup.error?.message ?? null);
  }
  const tenantId = String(tenantLookup.data);

  const summaryResult = await auth.supabase.rpc("get_usage_summary", {
    p_tenant_id: tenantId,
    p_window_days: windowDays,
  });

  if (summaryResult.error) return errorResponse(400, "Could not load usage summary", summaryResult.error.message);

  const summary = summaryResult.data ?? {};

  await auth.supabase.from("billing_events").insert({
    tenant_id: tenantId,
    provider,
    provider_event_id: `usage:${provider}:${Date.now()}`,
    event_type: "usage.reported",
    payload: {
      windowDays,
      summary,
    },
    status: "processed",
    processed_at: new Date().toISOString(),
  });

  return jsonResponse(200, {
    ok: true,
    data: {
      provider,
      windowDays,
      summary,
    },
    error: null,
  });
});
