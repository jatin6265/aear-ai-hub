import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

type AgentDashboardRow = {
  id: string;
  name: string;
  slug: string;
  domain: string;
  description: string | null;
  status: string;
  status_bucket: "active" | "inactive" | "training";
  avatar_emoji: string | null;
  source_connection_id: string | null;
  source_connection_name: string | null;
  capabilities: string[] | null;
  raci_scope: string | null;
  queries_today: number | null;
  success_rate: number | null;
  avg_response_ms: number | null;
  lifecycle_reason: string | null;
  is_custom: boolean | null;
  updated_at: string;
};

function isRpcUnavailable(error: { code?: string | null; message?: string | null } | null) {
  if (!error) return false;
  const code = String(error.code ?? "");
  const message = String(error.message ?? "").toLowerCase();
  return (
    code === "PGRST202" ||
    code === "42702" ||
    message.includes("could not find the function") ||
    (message.includes("tenant_id") && message.includes("ambiguous"))
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let search = "";
  let status = "all";
  try {
    const body = await req.json();
    search = String(body?.search ?? "").trim();
    status = String(body?.status ?? "all").trim().toLowerCase();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const { data, error } = await auth.supabase.rpc("list_agents_dashboard", {
    p_search: search.length > 0 ? search : null,
    p_status: status || "all",
  });
  let agents = (data ?? []) as AgentDashboardRow[];
  if (error) {
    if (!isRpcUnavailable(error)) {
      return errorResponse(400, "Failed to load agents dashboard", error.message);
    }

    const { data: tenantId, error: tenantError } = await auth.supabase.rpc("get_user_tenant_id");
    if (tenantError || !tenantId) {
      return errorResponse(400, "Failed to load agents dashboard", tenantError?.message ?? error.message);
    }

    const fallback = await auth.supabase
      .from("ai_agents")
      .select("id,name,slug,domain,description,status,updated_at")
      .eq("tenant_id", tenantId)
      .order("updated_at", { ascending: false });
    if (fallback.error) return errorResponse(400, "Failed to load agents dashboard", fallback.error.message);

    const normalizedSearch = search.toLowerCase();
    agents = (fallback.data ?? [])
      .filter((row) => {
        if (!normalizedSearch) return true;
        return `${row.name ?? ""} ${row.domain ?? ""}`.toLowerCase().includes(normalizedSearch);
      })
      .map((row) => {
        const normalizedStatus = String(row.status ?? "inactive").toLowerCase();
        const statusBucket: AgentDashboardRow["status_bucket"] =
          normalizedStatus === "ready"
            ? "active"
            : normalizedStatus === "syncing" || normalizedStatus === "training"
              ? "training"
              : "inactive";
        return {
          id: String(row.id),
          name: String(row.name ?? "Agent"),
          slug: String(row.slug ?? ""),
          domain: String(row.domain ?? "general"),
          description: row.description ?? null,
          status: normalizedStatus,
          status_bucket: statusBucket,
          avatar_emoji: null,
          source_connection_id: null,
          source_connection_name: null,
          capabilities: [],
          raci_scope: null,
          queries_today: 0,
          success_rate: null,
          avg_response_ms: null,
          lifecycle_reason: null,
          is_custom: null,
          updated_at: String(row.updated_at ?? new Date().toISOString()),
        };
      });
  }

  const summary = agents.reduce(
    (acc, agent) => {
      const key = String(agent.status_bucket ?? "inactive").toLowerCase();
      if (key === "active") acc.active += 1;
      else if (key === "training") acc.training += 1;
      else acc.inactive += 1;
      return acc;
    },
    { active: 0, inactive: 0, training: 0 },
  );

  return jsonResponse(200, {
    ok: true,
    summary,
    agents,
  });
});
