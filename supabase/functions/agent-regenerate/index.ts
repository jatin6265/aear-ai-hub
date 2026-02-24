import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let tenantId: string | null = null;
  let force = false;

  try {
    const body = await req.json();
    tenantId = body?.tenantId ? String(body.tenantId).trim() : null;
    force = Boolean(body?.force);
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const { data, error } = await auth.supabase.rpc("regenerate_agents_for_tenant", {
    p_tenant_id: tenantId,
    p_force: force,
  });

  if (error) return errorResponse(400, "Agent regeneration failed", error.message);

  const row = data?.[0];
  if (!row) return errorResponse(500, "Agent regeneration returned no result");

  const [domainResponse, agentsResponse] = await Promise.all([
    auth.supabase.rpc("derive_agent_domains", {
      p_tenant_id: row.tenant_id,
      p_force: force,
    }),
    auth.supabase
      .from("ai_agents")
      .select("status, schema_fingerprint")
      .eq("tenant_id", row.tenant_id),
  ]);

  const domains = (domainResponse.data ?? []) as Array<{
    domain: string;
    slug: string;
    entity_count: number;
  }>;

  const agents = (agentsResponse.data ?? []) as Array<{
    status: string;
    schema_fingerprint: string | null;
  }>;

  const statusCounts = agents.reduce(
    (acc, agent) => {
      const key = String(agent.status ?? "").toLowerCase();
      if (!key) return acc;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const schemaFingerprint = agents.find((agent) => agent.schema_fingerprint)?.schema_fingerprint ?? null;

  return jsonResponse(200, {
    ok: true,
    tenantId: row.tenant_id,
    seeded: row.seeded,
    updated: row.updated,
    schemaFingerprint,
    domainCount: domains.length,
    domains,
    statusCounts,
  });
});
