import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeTab(value: unknown) {
  const tab = clean(value).toLowerCase();
  if (tab === "anomalies" || tab === "forecasts" || tab === "sla_risks" || tab === "positive") return tab;
  return "all";
}

function normalizeBoolean(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = clean(value).toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return fallback;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let operation = "get_payload";
  let tab = "all";
  let sourceId = "";
  let includeDismissed = false;
  let insightId = "";

  try {
    const body = (await req.json()) as {
      operation?: string;
      tab?: string;
      sourceId?: string;
      includeDismissed?: boolean;
      insightId?: string;
    };
    operation = clean(body?.operation).toLowerCase() || "get_payload";
    tab = normalizeTab(body?.tab);
    sourceId = clean(body?.sourceId);
    includeDismissed = normalizeBoolean(body?.includeDismissed, false);
    insightId = clean(body?.insightId);
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (operation === "refresh") {
    const { error } = await auth.supabase.rpc("refresh_predictive_insights");
    if (error) return errorResponse(400, "Could not refresh insights", error.message);
  }

  if (operation === "dismiss") {
    if (!insightId) return errorResponse(400, "insightId is required");
    const { error } = await auth.supabase.rpc("dismiss_predictive_insight", {
      p_insight_id: insightId,
    });
    if (error) return errorResponse(400, "Could not dismiss insight", error.message);
  }

  const { data, error } = await auth.supabase.rpc("get_predictive_insights_payload", {
    p_tab: tab,
    p_source_id: sourceId || null,
    p_include_dismissed: includeDismissed,
  });

  if (error) return errorResponse(400, "Could not load insights feed", error.message);

  return jsonResponse(200, {
    ok: true,
    payload: data ?? {},
  });
});

