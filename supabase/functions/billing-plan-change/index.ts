import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizePlan(value: unknown) {
  const plan = clean(value).toLowerCase();
  if (plan === "starter" || plan === "pro" || plan === "business" || plan === "enterprise") return plan;
  return "";
}

function normalizeCycle(value: unknown) {
  const cycle = clean(value).toLowerCase();
  return cycle === "annual" ? "annual" : "monthly";
}

function normalizeChangeType(value: unknown) {
  const t = clean(value).toLowerCase();
  return t === "downgrade" ? "downgrade" : "upgrade";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let operation = "";
  let targetPlan = "";
  let billingCycle: "monthly" | "annual" = "monthly";
  let paymentReference = "";
  let changeType: "upgrade" | "downgrade" = "upgrade";

  try {
    const body = (await req.json()) as {
      operation?: string;
      targetPlan?: string;
      billingCycle?: string;
      paymentReference?: string;
      changeType?: string;
    };

    operation = clean(body?.operation).toLowerCase();
    targetPlan = normalizePlan(body?.targetPlan);
    billingCycle = normalizeCycle(body?.billingCycle);
    paymentReference = clean(body?.paymentReference);
    changeType = normalizeChangeType(body?.changeType);
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!operation) return errorResponse(400, "operation is required");

  if (operation === "get_options") {
    const { data, error } = await auth.supabase.rpc("get_billing_upgrade_options");
    if (error) return errorResponse(400, "Could not load upgrade options", error.message);
    return jsonResponse(200, { ok: true, payload: data ?? {} });
  }

  if (operation === "preview_change") {
    if (!targetPlan) return errorResponse(400, "targetPlan is required");
    const { data, error } = await auth.supabase.rpc("preview_plan_change", {
      p_target_plan: targetPlan,
      p_billing_cycle: billingCycle,
    });
    if (error) return errorResponse(400, "Could not preview plan change", error.message);
    return jsonResponse(200, { ok: true, payload: data ?? {} });
  }

  if (operation === "get_downgrade_impact") {
    if (!targetPlan) return errorResponse(400, "targetPlan is required");
    const { data, error } = await auth.supabase.rpc("get_plan_downgrade_impact", {
      p_target_plan: targetPlan,
    });
    if (error) return errorResponse(400, "Could not get downgrade impact", error.message);
    return jsonResponse(200, { ok: true, payload: data ?? {} });
  }

  if (operation === "apply_change") {
    if (!targetPlan) return errorResponse(400, "targetPlan is required");
    const { data, error } = await auth.supabase.rpc("apply_plan_change", {
      p_target_plan: targetPlan,
      p_billing_cycle: billingCycle,
      p_payment_reference: paymentReference || null,
      p_change_type: changeType,
    });
    if (error) return errorResponse(400, "Could not apply plan change", error.message);
    return jsonResponse(200, { ok: true, payload: data ?? {} });
  }

  return errorResponse(400, "Unknown operation");
});

