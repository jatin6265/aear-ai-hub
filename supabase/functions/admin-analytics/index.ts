import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

type Operation = "get_payload" | "set_weekly_report";

type RequestBody = {
  operation?: Operation;
  dateFrom?: string | null;
  dateTo?: string | null;
  enabled?: boolean;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function toNullableDate(value: unknown) {
  const cleaned = clean(value);
  if (!cleaned) return null;
  return cleaned;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const operation = clean(body.operation || "get_payload").toLowerCase() as Operation;
  if (operation !== "get_payload" && operation !== "set_weekly_report") {
    return errorResponse(400, "Unsupported operation");
  }

  const dateFrom = toNullableDate(body.dateFrom);
  const dateTo = toNullableDate(body.dateTo);

  if (operation === "set_weekly_report") {
    const enabled = body.enabled === true;

    const toggleResult = await auth.supabase.rpc("set_tenant_admin_weekly_report_enabled", {
      p_enabled: enabled,
    });

    if (toggleResult.error) {
      return errorResponse(400, "Failed to update weekly report setting", toggleResult.error.message);
    }

    const payloadResult = await auth.supabase.rpc("get_tenant_admin_analytics_payload", {
      p_date_from: dateFrom,
      p_date_to: dateTo,
    });

    if (payloadResult.error) {
      return errorResponse(400, "Failed to load analytics payload", payloadResult.error.message);
    }

    return jsonResponse(200, {
      ok: true,
      operation,
      settings: toggleResult.data ?? null,
      payload: payloadResult.data ?? null,
    });
  }

  const payloadResult = await auth.supabase.rpc("get_tenant_admin_analytics_payload", {
    p_date_from: dateFrom,
    p_date_to: dateTo,
  });

  if (payloadResult.error) {
    return errorResponse(400, "Failed to load analytics payload", payloadResult.error.message);
  }

  return jsonResponse(200, {
    ok: true,
    operation,
    payload: payloadResult.data ?? null,
  });
});
