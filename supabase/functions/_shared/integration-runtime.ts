type SupabaseLike = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
};

export type ToolingStrategy = "mcp" | "openapi" | "custom_template";

export function resolveToolingStrategy(integration: {
  mcp_server_url?: unknown;
  connection_type?: unknown;
  docs_url?: unknown;
}): ToolingStrategy {
  const mcpServerUrl = String(integration.mcp_server_url ?? "").trim();
  if (mcpServerUrl) return "mcp";

  const connectionType = String(integration.connection_type ?? "").trim().toLowerCase();
  const docsUrl = String(integration.docs_url ?? "").trim().toLowerCase();
  const hasOpenApiHint =
    docsUrl.includes("openapi") ||
    docsUrl.endsWith(".json") ||
    docsUrl.endsWith(".yaml") ||
    docsUrl.endsWith(".yml");

  if (connectionType === "rest_api" && hasOpenApiHint) return "openapi";
  return "custom_template";
}

export async function bootstrapTenantIntegrationRuntime(args: {
  supabase: SupabaseLike;
  tenantId: string;
  userId: string | null;
  integrationCode: string;
  credentialId?: string | null;
}) {
  const { data, error } = await args.supabase.rpc("bootstrap_tenant_integration_runtime", {
    p_tenant_id: args.tenantId,
    p_user_id: args.userId,
    p_integration_code: args.integrationCode,
    p_credential_id: args.credentialId ?? null,
  });

  if (error) {
    throw new Error(error.message ?? "Failed to bootstrap integration runtime");
  }

  return data;
}

export async function teardownTenantIntegrationRuntime(args: {
  supabase: SupabaseLike;
  tenantId: string;
  userId: string | null;
  integrationCode: string;
}) {
  const { data, error } = await args.supabase.rpc("teardown_tenant_integration_runtime", {
    p_tenant_id: args.tenantId,
    p_user_id: args.userId,
    p_integration_code: args.integrationCode,
  });

  if (error) {
    throw new Error(error.message ?? "Failed to teardown integration runtime");
  }

  return data;
}
