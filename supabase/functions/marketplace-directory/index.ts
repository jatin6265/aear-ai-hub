import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/service.ts";
import {
  bootstrapTenantIntegrationRuntime,
  teardownTenantIntegrationRuntime,
} from "../_shared/integration-runtime.ts";

type Operation = "get_payload" | "install" | "configure" | "uninstall";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizedCategory(value: unknown) {
  const category = clean(value).toLowerCase();
  if (!category) return "all";
  return category;
}

function fallbackPayload(reason: string) {
  return {
    summary: { total: 0, installed: 0, featured: 0 },
    categories: [],
    featured: [],
    integrations: [],
    fallback: {
      used: true,
      reason,
    },
  };
}

async function loadPayload(
  supabase: { rpc: (...args: unknown[]) => Promise<{ data: unknown; error: { message?: string } | null }> },
  filters: { search?: string; category?: string; installedOnly?: boolean },
) {
  const { data, error } = await supabase.rpc("get_integration_marketplace_payload", {
    p_search: clean(filters.search) || null,
    p_category: normalizedCategory(filters.category),
    p_installed_only: Boolean(filters.installedOnly),
  });

  if (error) throw new Error(error.message || "Failed to load marketplace payload");
  return data ?? { summary: { total: 0, installed: 0, featured: 0 }, categories: [], featured: [], integrations: [] };
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

  const filters = {
    search: clean(body.search),
    category: normalizedCategory(body.category),
    installedOnly: Boolean(body.installedOnly),
  };

  try {
    const { data: tenantIdRaw, error: tenantError } = await auth.supabase.rpc("get_user_tenant_id");
    const tenantId = String(tenantIdRaw ?? "").trim();
    if (tenantError || !tenantId) {
      return errorResponse(400, "Could not resolve tenant", tenantError?.message ?? null);
    }

    const service = getServiceClient();
    if (!service.ok) return service.response;

    if (operation === "install" || operation === "configure" || operation === "uninstall") {
      const integrationCode = clean(body.integrationCode || body.code).toLowerCase();
      if (!integrationCode) return errorResponse(400, "integrationCode is required");

      const { data, error } = await auth.supabase.rpc("set_integration_install_state", {
        p_integration_code: integrationCode,
        p_operation: operation,
      });

      if (error) return errorResponse(400, `Could not ${operation} integration`, error.message);

      let runtimeProvisioning: unknown = null;
      try {
        if (operation === "install" || operation === "configure") {
          runtimeProvisioning = await bootstrapTenantIntegrationRuntime({
            supabase: service.supabase,
            tenantId,
            userId: auth.user.id,
            integrationCode,
            credentialId: null,
          });
        } else if (operation === "uninstall") {
          runtimeProvisioning = await teardownTenantIntegrationRuntime({
            supabase: service.supabase,
            tenantId,
            userId: auth.user.id,
            integrationCode,
          });
        }
      } catch (runtimeError) {
        return errorResponse(
          500,
          `Integration ${operation} completed but runtime bootstrap failed`,
          runtimeError instanceof Error ? runtimeError.message : null,
        );
      }

      let payload;
      try {
        payload = await loadPayload(auth.supabase, filters);
      } catch (payloadError) {
        payload = fallbackPayload(
          payloadError instanceof Error
            ? payloadError.message
            : "Marketplace payload unavailable after integration update",
        );
      }
      return jsonResponse(200, {
        ok: true,
        operation,
        result: data,
        runtimeProvisioning,
        payload,
      });
    }

    if (operation !== "get_payload") {
      return errorResponse(400, "Unsupported operation");
    }

    let payload;
    try {
      payload = await loadPayload(auth.supabase, filters);
    } catch (error) {
      payload = fallbackPayload(
        error instanceof Error ? error.message : "Marketplace payload unavailable",
      );
    }
    return jsonResponse(200, {
      ok: true,
      operation,
      payload,
    });
  } catch (error) {
    return errorResponse(500, "Unexpected marketplace error", error instanceof Error ? error.message : null);
  }
});
