import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizePosition(value: unknown) {
  const normalized = clean(value).toLowerCase();
  if (normalized === "bottom-left" || normalized === "top-right" || normalized === "top-left") return normalized;
  return "bottom-right";
}

function normalizeSize(value: unknown) {
  const normalized = clean(value).toLowerCase();
  if (normalized === "small" || normalized === "large") return normalized;
  return "medium";
}

function normalizeMode(value: unknown) {
  const normalized = clean(value).toLowerCase();
  if (normalized === "authenticated" || normalized === "jwt") return normalized;
  return "public";
}

function normalizeColor(value: unknown) {
  const normalized = clean(value);
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized : "#7c3aed";
}

function asUuidArray(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return value.map((item) => clean(item)).filter((item) => item.length > 0);
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return value.map((item) => clean(item)).filter((item) => item.length > 0);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let operation = "get_payload";

  try {
    const body = (await req.json()) as {
      operation?: string;
      config?: {
        name?: string;
        position?: string;
        primaryColor?: string;
        buttonSize?: string;
        initialMessage?: string;
        accessMode?: string;
        allowedOrigins?: string[];
        enabledAgentIds?: string[];
        features?: {
          executeActions?: boolean;
          viewReports?: boolean;
          requestApprovals?: boolean;
        };
      };
    };

    operation = clean(body?.operation).toLowerCase() || "get_payload";

    if (operation === "save_config") {
      const config = body?.config ?? {};
      const features = config.features ?? {};

      const { data, error } = await auth.supabase.rpc("save_widget_integration_config", {
        p_name: clean(config.name) || null,
        p_position: normalizePosition(config.position),
        p_primary_color: normalizeColor(config.primaryColor),
        p_button_size: normalizeSize(config.buttonSize),
        p_initial_message: clean(config.initialMessage),
        p_access_mode: normalizeMode(config.accessMode),
        p_allowed_origins: asStringArray(config.allowedOrigins),
        p_enabled_agent_ids: asUuidArray(config.enabledAgentIds),
        p_feature_execute_actions: features.executeActions === true,
        p_feature_view_reports: features.viewReports === true,
        p_feature_request_approvals: features.requestApprovals === true,
      });

      if (error) return errorResponse(400, "Could not save widget config", error.message);
      const { data: payloadData, error: payloadError } = await auth.supabase.rpc("get_widget_integration_payload");
      if (payloadError) return errorResponse(400, "Saved but could not reload widget payload", payloadError.message);

      return jsonResponse(200, {
        ok: true,
        result: data ?? {},
        payload: payloadData ?? {},
      });
    }

    const { data, error } = await auth.supabase.rpc("get_widget_integration_payload");
    if (error) return errorResponse(400, "Could not load widget payload", error.message);

    return jsonResponse(200, {
      ok: true,
      payload: data ?? {},
    });
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
});

