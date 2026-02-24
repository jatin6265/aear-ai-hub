import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

type RequestBody = {
  operation?: "get_payload";
  search?: string;
  riskFilter?: string;
  actionTypeFilter?: string;
  statusFilter?: string;
  userFilter?: string;
  agentFilter?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function toDateOrNull(value: string) {
  if (!value) return null;
  const normalized = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const operation = clean(body.operation || "get_payload").toLowerCase();
  if (operation !== "get_payload") {
    return errorResponse(400, "Unsupported operation");
  }

  const limit = Number.isFinite(body.limit) ? Math.min(Math.max(Number(body.limit), 1), 500) : 100;
  const offset = Number.isFinite(body.offset) ? Math.max(Number(body.offset), 0) : 0;

  const { data, error } = await auth.supabase.rpc("get_audit_log_full_payload", {
    p_search: clean(body.search) || null,
    p_risk_filter: clean(body.riskFilter || "all").toLowerCase(),
    p_action_type_filter: clean(body.actionTypeFilter || "all").toLowerCase(),
    p_status_filter: clean(body.statusFilter || "all").toLowerCase(),
    p_user_filter: clean(body.userFilter) || null,
    p_agent_filter: clean(body.agentFilter || "all") || "all",
    p_date_from: toDateOrNull(clean(body.dateFrom)),
    p_date_to: toDateOrNull(clean(body.dateTo)),
    p_limit: limit,
    p_offset: offset,
  });

  if (error) return errorResponse(400, "Failed to load audit log payload", error.message);

  return jsonResponse(200, {
    ok: true,
    payload:
      data ??
      {
        rows: [],
        total: 0,
        stats: { todayActions: 0, todayBlocked: 0, todayApproved: 0 },
        weekTrend: [],
        filterOptions: { users: [], agents: [] },
        page: { limit, offset },
        dateRange: { from: null, to: null },
      },
  });
});
