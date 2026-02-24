import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeWindow(value: unknown) {
  const windowValue = clean(value).toLowerCase();
  if (windowValue === "7d" || windowValue === "30d" || windowValue === "60d" || windowValue === "90d") return windowValue;
  return "60d";
}

function normalizeStatus(value: unknown) {
  const status = clean(value).toLowerCase();
  if (status === "active" || status === "investigating" || status === "resolved") return status;
  return "active";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let operation = "get_detail";
  let insightId = "";
  let window = "60d";
  let status = "active";

  try {
    const body = (await req.json()) as {
      operation?: string;
      insightId?: string;
      window?: string;
      status?: string;
    };
    operation = clean(body?.operation).toLowerCase() || "get_detail";
    insightId = clean(body?.insightId);
    window = normalizeWindow(body?.window);
    status = normalizeStatus(body?.status);
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!insightId) return errorResponse(400, "insightId is required");

  if (operation === "set_status") {
    const { data, error } = await auth.supabase.rpc("update_predictive_anomaly_status", {
      p_insight_id: insightId,
      p_status: status,
    });
    if (error) return errorResponse(400, "Could not update anomaly status", error.message);
    return jsonResponse(200, { ok: true, payload: data ?? {} });
  }

  const { data, error } = await auth.supabase.rpc("get_predictive_anomaly_detail", {
    p_insight_id: insightId,
    p_window: window,
  });
  if (error) return errorResponse(400, "Could not load anomaly detail", error.message);

  return jsonResponse(200, {
    ok: true,
    payload: data ?? {},
  });
});

