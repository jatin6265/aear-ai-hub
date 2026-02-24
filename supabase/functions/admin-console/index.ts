import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

type Operation = "get_payload";

type RequestBody = {
  operation?: Operation;
};

type AdminConsoleFallbackPayload = {
  profileRole: string;
  isAdmin: boolean;
  workspaceHealthScore: number;
  healthBreakdown: {
    connectionHealth: number;
    raciCoverage: number;
    auditLogClean: number;
    billingCurrent: number;
  };
  stats: {
    connections: { total: number; healthy: number; errors: number };
    teamMembers: { active: number; pending: number };
    raciRules: { defined: number; coverageScore: number };
    pendingApprovals: number;
    agents: { active: number; total: number };
  };
  recentAdminEvents: Array<{
    id: string;
    message: string;
    createdAt: string;
    actorName: string;
    action: string;
    resource: string;
  }>;
  riskOverview: {
    raciDistribution: Array<{ type: "R" | "A" | "C" | "I"; count: number }>;
    criticalResources: { covered: number; uncovered: number; total: number };
  };
  fallback: {
    used: boolean;
    reason: string | null;
  };
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function isRpcMissing(error: { code?: string | null; message?: string | null } | null) {
  if (!error) return false;
  const code = String(error.code ?? "");
  const message = String(error.message ?? "").toLowerCase();
  return code === "PGRST202" || message.includes("could not find the function");
}

function isAmbiguousTenantError(error: { code?: string | null; message?: string | null } | null) {
  if (!error) return false;
  const code = String(error.code ?? "");
  const message = String(error.message ?? "").toLowerCase();
  return code === "42702" && message.includes("tenant_id") && message.includes("ambiguous");
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildFallbackPayload(supabase: any, reason: string): Promise<AdminConsoleFallbackPayload> {
  const empty: AdminConsoleFallbackPayload = {
    profileRole: "member",
    isAdmin: false,
    workspaceHealthScore: 0,
    healthBreakdown: {
      connectionHealth: 0,
      raciCoverage: 0,
      auditLogClean: 0,
      billingCurrent: 0,
    },
    stats: {
      connections: { total: 0, healthy: 0, errors: 0 },
      teamMembers: { active: 0, pending: 0 },
      raciRules: { defined: 0, coverageScore: 0 },
      pendingApprovals: 0,
      agents: { active: 0, total: 0 },
    },
    recentAdminEvents: [],
    riskOverview: {
      raciDistribution: [
        { type: "R", count: 0 },
        { type: "A", count: 0 },
        { type: "C", count: 0 },
        { type: "I", count: 0 },
      ],
      criticalResources: { covered: 0, uncovered: 0, total: 0 },
    },
    fallback: {
      used: true,
      reason,
    },
  };

  const userRes = await supabase.auth.getUser();
  const userId = userRes.data.user?.id;
  if (!userId) return empty;

  const profileRes = await supabase
    .from("profiles")
    .select("tenant_id, role, full_name")
    .eq("id", userId)
    .maybeSingle();
  const profile = profileRes.data;
  const tenantId = profile?.tenant_id ? String(profile.tenant_id) : "";
  if (!tenantId) return empty;

  const role = clean(profile?.role).toLowerCase() || "member";
  const isAdmin = ["owner", "admin", "manager"].includes(role);

  const [connectionsRes, teamRes, inviteRes, approvalRes, agentsRes, eventsRes] = await Promise.all([
    supabase.from("api_connections").select("status").eq("tenant_id", tenantId),
    supabase.from("profiles").select("id").eq("tenant_id", tenantId).eq("status", "active"),
    supabase.from("team_invitations").select("id").eq("tenant_id", tenantId).eq("status", "pending"),
    supabase.from("approval_requests").select("id").eq("tenant_id", tenantId).eq("status", "pending"),
    supabase.from("ai_agents").select("status").eq("tenant_id", tenantId),
    supabase
      .from("audit_logs")
      .select("id, action, resource, created_at, status")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(8),
  ]);

  const connections = asArray(connectionsRes?.data) as Array<Record<string, unknown>>;
  const totalConnections = connections.length;
  const healthyConnections = connections.filter((row) => clean(row.status).toLowerCase() === "active").length;
  const errorConnections = connections.filter((row) => clean(row.status).toLowerCase() === "error").length;
  const connectionHealthScore = totalConnections > 0 ? Math.round((healthyConnections / totalConnections) * 100) : 100;

  const teamActive = asArray(teamRes?.data).length;
  const teamPending = asArray(inviteRes?.data).length;
  const pendingApprovals = asArray(approvalRes?.data).length;

  const agents = asArray(agentsRes?.data) as Array<Record<string, unknown>>;
  const activeAgents = agents.filter((row) => clean(row.status).toLowerCase() === "ready").length;

  const events = asArray(eventsRes?.data) as Array<Record<string, unknown>>;

  const recentAdminEvents = events.map((row) => ({
    id: clean(row.id) || crypto.randomUUID(),
    message: `${clean(row.action).replaceAll("_", " ")} on ${clean(row.resource) || "resource"}`,
    createdAt: clean(row.created_at) || new Date().toISOString(),
    actorName: clean(profile?.full_name) || "Admin",
    action: clean(row.action),
    resource: clean(row.resource),
  }));

  const workspaceHealthScore = Math.max(0, Math.min(100, Math.round((connectionHealthScore + 100 + 100 + 100) / 4)));

  return {
    ...empty,
    profileRole: role,
    isAdmin,
    workspaceHealthScore,
    healthBreakdown: {
      connectionHealth: connectionHealthScore,
      raciCoverage: 100,
      auditLogClean: 100,
      billingCurrent: 100,
    },
    stats: {
      connections: {
        total: totalConnections,
        healthy: healthyConnections,
        errors: errorConnections,
      },
      teamMembers: {
        active: teamActive,
        pending: teamPending,
      },
      raciRules: {
        defined: 0,
        coverageScore: 100,
      },
      pendingApprovals,
      agents: {
        active: activeAgents,
        total: agents.length,
      },
    },
    recentAdminEvents,
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
  if (operation !== "get_payload") {
    return errorResponse(400, "Unsupported operation");
  }

  const { data, error } = await auth.supabase.rpc("get_tenant_admin_console_overview");
  if (error) {
    const fallbackReason =
      isRpcMissing(error) || isAmbiguousTenantError(error)
        ? `Fallback payload used: ${error.message ?? "admin console overview RPC unavailable"}`
        : `Fallback payload used after RPC failure: ${error.message ?? "admin console overview RPC failed"}`;
    try {
      const payload = await buildFallbackPayload(auth.supabase, fallbackReason);
      return jsonResponse(200, {
        ok: true,
        operation,
        payload,
      });
    } catch (fallbackError) {
      return errorResponse(
        400,
        "Failed to load admin console payload",
        fallbackError instanceof Error ? fallbackError.message : error.message,
      );
    }
  }

  return jsonResponse(200, {
    ok: true,
    operation,
    payload: data ?? null,
  });
});
