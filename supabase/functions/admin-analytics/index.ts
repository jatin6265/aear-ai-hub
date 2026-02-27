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

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function toDateRange(dateFrom: string | null, dateTo: string | null) {
  const end = dateTo ? new Date(dateTo) : new Date();
  const start = dateFrom ? new Date(dateFrom) : new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);
  const previousEnd = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  const previousStart = new Date(previousEnd.getTime() - Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000))) * 24 * 60 * 60 * 1000);
  const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1);
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
    previousFrom: previousStart.toISOString().slice(0, 10),
    previousTo: previousEnd.toISOString().slice(0, 10),
    days,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveTenantId(supabase: any, userId: string) {
  const tenantRpc = await supabase.rpc("get_user_tenant_id");
  if (!tenantRpc.error && tenantRpc.data) return String(tenantRpc.data);
  const profile = await supabase
    .from("profiles")
    .select("tenant_id")
    .eq("id", userId)
    .maybeSingle();
  if (!profile.error && profile.data?.tenant_id) return String(profile.data.tenant_id);
  return "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildFallbackPayload(supabase: any, userId: string, dateFrom: string | null, dateTo: string | null) {
  const range = toDateRange(dateFrom, dateTo);
  const tenantId = await resolveTenantId(supabase, userId);
  if (!tenantId) {
    return {
      range,
      topMetrics: {
        totalAiQueries: 0,
        actionsExecuted: 0,
        avgResponseTimeMs: 0,
        approvalRatePct: 0,
        dataSourcesQueried: 0,
      },
      usageCharts: {
        queriesPerDay: [],
        agentKeys: [],
        responseTimeDistribution: [],
        mostActiveUsers: [],
        mostQueriedResources: [],
        actionExecutionBreakdown: [],
      },
      agentPerformance: [],
      tokenUsage: {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        trendPctVsPrevious: 0,
        previousTotalTokens: 0,
      },
      settings: {
        weeklyEmailReportEnabled: false,
      },
      fallback: {
        used: true,
        reason: "tenant resolution failed",
      },
    };
  }

  const [messagesRes, actionsRes, approvalsRes, connectionsRes, settingsRes] = await Promise.all([
    supabase
      .from("chat_messages")
      .select("created_at,metadata,risk_level,session_id")
      .gte("created_at", `${range.from}T00:00:00.000Z`)
      .lte("created_at", `${range.to}T23:59:59.999Z`)
      .order("created_at", { ascending: true }),
    supabase
      .from("agent_action_runs")
      .select("created_at,status,duration_ms")
      .eq("tenant_id", tenantId)
      .gte("created_at", `${range.from}T00:00:00.000Z`)
      .lte("created_at", `${range.to}T23:59:59.999Z`),
    supabase
      .from("approval_requests")
      .select("status")
      .eq("tenant_id", tenantId)
      .gte("requested_at", `${range.from}T00:00:00.000Z`)
      .lte("requested_at", `${range.to}T23:59:59.999Z`),
    supabase
      .from("api_connections")
      .select("id,status")
      .eq("tenant_id", tenantId)
      .neq("status", "deleted"),
    supabase
      .from("tenant_notification_settings")
      .select("weekly_report_enabled")
      .eq("tenant_id", tenantId)
      .maybeSingle(),
  ]);

  const messages = messagesRes.error ? [] : asArray<Record<string, unknown>>(messagesRes.data);
  const actions = actionsRes.error ? [] : asArray<Record<string, unknown>>(actionsRes.data);
  const approvals = approvalsRes.error ? [] : asArray<Record<string, unknown>>(approvalsRes.data);
  const connections = connectionsRes.error ? [] : asArray<Record<string, unknown>>(connectionsRes.data);
  const weeklyEnabled = Boolean(settingsRes.data?.weekly_report_enabled);

  const uniqueSourceIds = new Set<string>();
  for (const row of messages) {
    const metadata = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : null;
    const sourceId = metadata?.connection_id;
    if (sourceId) uniqueSourceIds.add(String(sourceId));
  }

  const approvalsTotal = approvals.length;
  const approvalsApproved = approvals.filter((row) => String(row.status ?? "").toLowerCase() === "approved").length;
  const avgResponseTimeMs = actions.length
    ? Math.round(actions.reduce((sum, row) => sum + Number(row.duration_ms ?? 0), 0) / actions.length)
    : 0;

  return {
    range,
    topMetrics: {
      totalAiQueries: messages.length,
      actionsExecuted: actions.length,
      avgResponseTimeMs,
      approvalRatePct: approvalsTotal > 0 ? Math.round((approvalsApproved / approvalsTotal) * 1000) / 10 : 0,
      dataSourcesQueried: uniqueSourceIds.size || connections.length,
    },
    usageCharts: {
      queriesPerDay: [],
      agentKeys: [],
      responseTimeDistribution: [],
      mostActiveUsers: [],
      mostQueriedResources: [],
      actionExecutionBreakdown: [],
    },
    agentPerformance: [],
    tokenUsage: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      trendPctVsPrevious: 0,
      previousTotalTokens: 0,
    },
    settings: {
      weeklyEmailReportEnabled: weeklyEnabled,
    },
    fallback: {
      used: true,
      reason: "RPC unavailable; returned direct-query fallback payload",
    },
  };
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
      const fallbackPayload = await buildFallbackPayload(auth.supabase, auth.user.id, dateFrom, dateTo);
      return jsonResponse(200, {
        ok: true,
        operation,
        settings: toggleResult.data ?? null,
        payload: fallbackPayload,
        warning: `Primary analytics payload RPC failed: ${payloadResult.error.message ?? "unknown error"}`,
      });
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
    const fallbackPayload = await buildFallbackPayload(auth.supabase, auth.user.id, dateFrom, dateTo);
    return jsonResponse(200, {
      ok: true,
      operation,
      payload: fallbackPayload,
      warning: `Primary analytics payload RPC failed: ${payloadResult.error.message ?? "unknown error"}`,
    });
  }

  return jsonResponse(200, {
    ok: true,
    operation,
    payload: payloadResult.data ?? null,
  });
});
