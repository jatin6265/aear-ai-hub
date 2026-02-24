import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";

type Operation =
  | "get_payload"
  | "get_tenant_quick_view"
  | "suspend_tenant"
  | "change_plan"
  | "impersonate_tenant";

type RequestBody = {
  operation?: Operation;
  filters?: {
    search?: string;
    plan?: string;
    status?: string;
    createdFrom?: string | null;
    createdTo?: string | null;
    sortBy?: string;
    sortDir?: string;
    limit?: number;
    offset?: number;
  };
  tenantId?: string;
  plan?: string;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizePlan(value: unknown) {
  const normalized = clean(value).toLowerCase();
  if (["starter", "pro", "business", "enterprise"].includes(normalized)) return normalized;
  return "all";
}

function normalizeStatus(value: unknown) {
  const normalized = clean(value).toLowerCase();
  if (["active", "trial", "suspended", "cancelled"].includes(normalized)) return normalized;
  return "all";
}

function normalizeSortBy(value: unknown) {
  const normalized = clean(value).toLowerCase();
  if (["mrr", "created", "last_active", "health_score"].includes(normalized)) return normalized;
  return "mrr";
}

function normalizeSortDir(value: unknown) {
  const normalized = clean(value).toLowerCase();
  return normalized === "asc" ? "asc" : "desc";
}

function normalizeDate(value: unknown) {
  const cleaned = clean(value);
  if (!cleaned) return null;
  return cleaned;
}

function normalizeLimit(value: unknown) {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
}

function normalizeOffset(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
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
    const filters = body.filters ?? {};
    const { data, error } = await auth.supabase.rpc("get_platform_super_admin_tenants", {
      p_search: clean(filters.search) || null,
      p_plan: normalizePlan(filters.plan),
      p_status: normalizeStatus(filters.status),
      p_created_from: normalizeDate(filters.createdFrom),
      p_created_to: normalizeDate(filters.createdTo),
      p_sort_by: normalizeSortBy(filters.sortBy),
      p_sort_dir: normalizeSortDir(filters.sortDir),
      p_limit: normalizeLimit(filters.limit),
      p_offset: normalizeOffset(filters.offset),
    });

    if (error) return errorResponse(400, "Could not load platform tenant list", error.message);

    return jsonResponse(200, {
      ok: true,
      operation,
      payload: data ?? null,
    });
  }

  const tenantId = clean(body.tenantId);
  if (!tenantId) return errorResponse(400, "tenantId is required");

  if (operation === "get_tenant_quick_view") {
    const { data, error } = await auth.supabase.rpc("get_platform_super_admin_tenant_quick_view", {
      p_tenant_id: tenantId,
    });

    if (error) return errorResponse(400, "Could not load tenant quick view", error.message);

    return jsonResponse(200, {
      ok: true,
      operation,
      payload: data ?? null,
    });
  }

  if (operation === "suspend_tenant") {
    const { data, error } = await auth.supabase.rpc("platform_admin_manage_tenant", {
      p_tenant_id: tenantId,
      p_action: "suspend",
      p_value: null,
    });

    if (error) return errorResponse(400, "Could not suspend tenant", error.message);

    return jsonResponse(200, {
      ok: true,
      operation,
      result: data ?? null,
    });
  }

  if (operation === "change_plan") {
    const plan = normalizePlan(body.plan);
    if (plan === "all") return errorResponse(400, "Valid plan is required");

    const { data, error } = await auth.supabase.rpc("platform_admin_manage_tenant", {
      p_tenant_id: tenantId,
      p_action: "change_plan",
      p_value: plan,
    });

    if (error) return errorResponse(400, "Could not change tenant plan", error.message);

    return jsonResponse(200, {
      ok: true,
      operation,
      result: data ?? null,
    });
  }

  if (operation === "impersonate_tenant") {
    const { data, error } = await auth.supabase.rpc("platform_admin_start_impersonation", {
      p_tenant_id: tenantId,
    });

    if (error) return errorResponse(400, "Could not create impersonation request", error.message);

    return jsonResponse(200, {
      ok: true,
      operation,
      result: data ?? null,
    });
  }

  return errorResponse(400, "Unsupported operation");
});
