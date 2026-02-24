import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";

type Operation = "get_payload" | "send_retention_email";

type RequestBody = {
  operation?: Operation;
  months?: number;
  tenantId?: string;
  note?: string;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeMonths(value: unknown) {
  const parsed = Number(value ?? 12);
  if (!Number.isFinite(parsed)) return 12;
  return Math.max(6, Math.min(24, Math.floor(parsed)));
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

  if (operation === "get_payload") {
    const { data, error } = await auth.supabase.rpc("get_platform_super_admin_revenue_dashboard", {
      p_months: normalizeMonths(body.months),
    });

    if (error) return errorResponse(400, "Could not load platform revenue dashboard", error.message);

    return jsonResponse(200, {
      ok: true,
      operation,
      payload: data ?? null,
    });
  }

  if (operation === "send_retention_email") {
    const tenantId = clean(body.tenantId);
    if (!tenantId) return errorResponse(400, "tenantId is required");

    const { data, error } = await auth.supabase.rpc("platform_admin_send_retention_email", {
      p_tenant_id: tenantId,
      p_note: clean(body.note) || null,
    });

    if (error) return errorResponse(400, "Could not queue retention email", error.message);

    return jsonResponse(200, {
      ok: true,
      operation,
      result: data ?? null,
    });
  }

  return errorResponse(400, "Unsupported operation");
});
