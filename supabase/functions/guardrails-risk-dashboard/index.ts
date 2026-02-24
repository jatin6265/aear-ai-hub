import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

type Operation = "get_payload" | "override_risk" | "set_guardrail_state";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

async function loadPayload(
  supabase: { rpc: (...args: unknown[]) => Promise<{ data: unknown; error: { message?: string } | null }> },
  eventRiskFilter: string,
) {
  const { data, error } = await supabase.rpc("get_guardrails_risk_dashboard", {
    p_event_risk_filter: eventRiskFilter || "all",
  });

  if (error) throw new Error(error.message || "Failed to load risk dashboard payload");

  return (
    data ?? {
      profileRole: "member",
      isAdmin: false,
      summary: { critical: 0, high: 0, medium: 0, low: 0 },
      resources: [],
      actions: [],
      rules: [],
      guardrails: [],
      recentEvents: [],
    }
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> = {};
  let operation: Operation = "get_payload";

  try {
    body = (await req.json()) as Record<string, unknown>;
    operation = clean(body.operation || "get_payload").toLowerCase() as Operation;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const eventRiskFilter = clean(body.eventRiskFilter || "all").toLowerCase() || "all";

  try {
    if (operation === "override_risk") {
      const ruleId = clean(body.ruleId);
      const overrideRiskLevel = clean(body.overrideRiskLevel).toLowerCase();
      const justification = clean(body.justification);

      if (!ruleId || !overrideRiskLevel) {
        return errorResponse(400, "ruleId and overrideRiskLevel are required");
      }

      const { data, error } = await auth.supabase.rpc("set_risk_rule_override", {
        p_rule_id: ruleId,
        p_override_risk_level: overrideRiskLevel,
        p_justification: justification,
      });

      if (error) return errorResponse(400, "Failed to override risk rule", error.message);

      const payload = await loadPayload(auth.supabase, eventRiskFilter);
      return jsonResponse(200, {
        ok: true,
        operation,
        result: data,
        payload,
      });
    }

    if (operation === "set_guardrail_state") {
      const guardrailId = clean(body.guardrailId);
      const enabled = Boolean(body.enabled);

      if (!guardrailId) return errorResponse(400, "guardrailId is required");

      const { data, error } = await auth.supabase.rpc("set_guardrail_enabled", {
        p_guardrail_id: guardrailId,
        p_enabled: enabled,
      });

      if (error) return errorResponse(400, "Failed to update guardrail state", error.message);

      const payload = await loadPayload(auth.supabase, eventRiskFilter);
      return jsonResponse(200, {
        ok: true,
        operation,
        updated: Boolean(data),
        payload,
      });
    }

    if (operation !== "get_payload") {
      return errorResponse(400, "Unsupported operation");
    }

    const payload = await loadPayload(auth.supabase, eventRiskFilter);
    return jsonResponse(200, {
      ok: true,
      operation,
      payload,
    });
  } catch (error) {
    return errorResponse(500, "Unexpected guardrails risk dashboard error", error instanceof Error ? error.message : null);
  }
});
