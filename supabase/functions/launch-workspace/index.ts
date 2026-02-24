import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/service.ts";

function asString(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeRaciRules(input: unknown) {
  if (!Array.isArray(input)) return [] as Array<{
    resource: string;
    action: string;
    responsibleRole: string | null;
    accountableRole: string | null;
  }>;

  return input
    .map((item) => {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const enabled = row.enabled === undefined ? true : Boolean(row.enabled);
      if (!enabled) return null;

      const resource = asString(row.resource);
      const action = asString(row.action);
      if (!resource || !action) return null;

      const responsibleRole = asString(row.responsible_role) || null;
      const accountableRole = asString(row.accountable_role) || null;

      return {
        resource,
        action,
        responsibleRole,
        accountableRole,
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let raciRules: unknown[] = [];
  try {
    const body = await req.json();
    raciRules = Array.isArray(body?.raciRules) ? body.raciRules : [];
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const { data, error } = await auth.supabase.rpc("launch_workspace", {
    p_raci_rules: raciRules,
  });

  if (error) {
    const service = getServiceClient();
    const fallbackClient = service.ok ? service.supabase : auth.supabase;

    const { data: tenantRpc, error: tenantRpcError } = await auth.supabase.rpc("get_user_tenant_id");
    let tenantId = tenantRpc ? String(tenantRpc) : "";
    if (!tenantId) {
      const { data: profile, error: profileError } = await fallbackClient
        .from("profiles")
        .select("tenant_id")
        .eq("id", auth.user.id)
        .maybeSingle();
      if (profileError || !profile?.tenant_id) {
        return errorResponse(
          400,
          "Workspace launch failed",
          profileError?.message || tenantRpcError?.message || "Could not resolve tenant",
        );
      }
      tenantId = String(profile.tenant_id);
    }

    const normalizedRules = normalizeRaciRules(raciRules);
    let appliedRules = 0;

    const { error: tenantUpdateError } = await fallbackClient
      .from("tenants")
      .update({
        status: "active",
        onboarding_step: 4,
        onboarding_completed_at: new Date().toISOString(),
        activated_at: new Date().toISOString(),
      })
      .eq("id", tenantId);
    if (tenantUpdateError) {
      return errorResponse(400, "Workspace launch failed", tenantUpdateError.message);
    }

    for (const rule of normalizedRules) {
      if (rule.responsibleRole) {
        const insertResponsible = await fallbackClient.from("raci_matrix").insert({
          tenant_id: tenantId,
          resource: rule.resource,
          action: rule.action,
          role_name: rule.responsibleRole,
          raci_type: "R",
        });
        if (!insertResponsible.error) appliedRules += 1;
      }
      if (rule.accountableRole) {
        const insertAccountable = await fallbackClient.from("raci_matrix").insert({
          tenant_id: tenantId,
          resource: rule.resource,
          action: rule.action,
          role_name: rule.accountableRole,
          raci_type: "A",
        });
        if (!insertAccountable.error) appliedRules += 1;
      }
    }

    let seededAgents = 0;
    const regenerate = await fallbackClient.rpc("regenerate_agents_for_tenant", {
      p_tenant_id: tenantId,
      p_force: false,
    });
    if (!regenerate.error && Array.isArray(regenerate.data) && regenerate.data[0]?.seeded) {
      seededAgents = Number(regenerate.data[0].seeded ?? 0);
    }

    await fallbackClient.from("audit_logs").insert({
      tenant_id: tenantId,
      user_id: auth.user.id,
      action: "workspace.launch",
      resource: "tenant",
      status: "success",
      details: {
        fallback: true,
        rpc_error: error.message,
        raci_rules_applied: appliedRules,
        agents_seeded: seededAgents,
      },
    });

    const { data: tenant } = await fallbackClient
      .from("tenants")
      .select("id,status")
      .eq("id", tenantId)
      .maybeSingle();

    return jsonResponse(200, {
      ok: true,
      tenantId: tenant?.id ?? tenantId,
      status: tenant?.status ?? "active",
      appliedRules,
      seededAgents,
      fallback: true,
      warning: `launch_workspace RPC failed (${error.message}). Fallback activation was applied.`,
    });
  }

  const result = data?.[0] ?? {
    tenant_id: null,
    tenant_status: "active",
    applied_rules: 0,
    seeded_agents: 0,
  };

  return jsonResponse(200, {
    ok: true,
    tenantId: result.tenant_id,
    status: result.tenant_status,
    appliedRules: result.applied_rules,
    seededAgents: result.seeded_agents,
  });
});
