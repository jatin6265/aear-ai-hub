import { getSupabaseService } from '../lib/supabase';

export type ToolingApproach = 'mcp' | 'openapi' | 'custom_template';

export type McpServerConfig = {
  id: string;
  tenant_id?: string | null;
  name: string;
  description?: string | null;
  url: string;
  auth_config: Record<string, unknown>;
  strategy?: ToolingApproach;
  integration_code?: string | null;
  auth_type?: string | null;
  docs_url?: string | null;
  capabilities?: unknown;
  tool_manifest?: unknown;
  status?: string;
  is_active: boolean;
};

export class McpRegistry {
  /**
   * Fetches active MCP servers for a tenant, including global ones.
   */
  async getActiveServers(tenantId: string): Promise<McpServerConfig[]> {
    const supabase = getSupabaseService();

    const { data, error } = await supabase.getClient()
      .from('mcp_servers')
      .select('*')
      .eq('is_active', true)
      .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`);

    if (error) {
      throw new Error(`Failed to fetch MCP servers: ${error.message}`);
    }

    return (data || []) as McpServerConfig[];
  }

  /**
   * Resolves MCP/OpenAPI/custom strategy from catalog metadata.
   */
  resolveToolingApproach(entry: {
    mcp_server_url?: unknown;
    connection_type?: unknown;
    docs_url?: unknown;
  }): ToolingApproach {
    const mcpServerUrl = String(entry.mcp_server_url ?? '').trim();
    if (mcpServerUrl) return 'mcp';

    const connectionType = String(entry.connection_type ?? '').trim().toLowerCase();
    const docsUrl = String(entry.docs_url ?? '').trim().toLowerCase();
    const hasOpenApiHint =
      docsUrl.includes('openapi') ||
      docsUrl.endsWith('.json') ||
      docsUrl.endsWith('.yaml') ||
      docsUrl.endsWith('.yml');

    if (connectionType === 'rest_api' && hasOpenApiHint) return 'openapi';
    return 'custom_template';
  }

  /**
   * Registers/updates tenant MCP server from integration catalog when strategy is MCP-first.
   */
  async registerTenantServerFromCatalog(
    tenantId: string,
    integrationCode: string,
    options: { credentialId?: string | null; authType?: string | null } = {}
  ): Promise<McpServerConfig | null> {
    const supabase = getSupabaseService();
    const code = String(integrationCode || '').trim().toLowerCase();
    if (!code) throw new Error('integrationCode is required');

    const { data: catalog, error: catalogError } = await supabase.getClient()
      .from('integration_catalog')
      .select('code, display_name, summary, mcp_server_url, connection_type, auth_type, docs_url, tool_templates')
      .eq('code', code)
      .eq('is_active', true)
      .maybeSingle();

    if (catalogError) {
      throw new Error(`Failed to load integration catalog entry: ${catalogError.message}`);
    }
    if (!catalog) return null;

    const approach = this.resolveToolingApproach(catalog);
    const mcpServerUrl = String(catalog.mcp_server_url ?? '').trim();
    if (approach !== 'mcp' || !mcpServerUrl) return null;

    const { data: existing, error: existingError } = await supabase.getClient()
      .from('mcp_servers')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('integration_code', code)
      .limit(1)
      .maybeSingle();

    if (existingError) {
      throw new Error(`Failed to resolve existing MCP server: ${existingError.message}`);
    }

    const payload = {
      tenant_id: tenantId,
      name: `${String(catalog.display_name ?? code)} MCP`,
      description: String(catalog.summary ?? 'Tenant MCP integration server'),
      url: mcpServerUrl,
      auth_config: {
        auth_type: options.authType ?? catalog.auth_type ?? 'oauth2',
        credential_id: options.credentialId ?? null,
        integration_code: code,
      },
      is_active: true,
      status: 'offline',
      strategy: 'mcp',
      source: 'integration_install',
      integration_code: code,
      auth_type: options.authType ?? catalog.auth_type ?? null,
      docs_url: catalog.docs_url ?? null,
      tool_manifest: { tools: Array.isArray(catalog.tool_templates) ? catalog.tool_templates : [] },
    };

    if (existing?.id) {
      const { data, error } = await supabase.getClient()
        .from('mcp_servers')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select('*')
        .single();

      if (error) throw new Error(`Failed to update MCP server: ${error.message}`);
      return data as McpServerConfig;
    }

    const { data, error } = await supabase.getClient()
      .from('mcp_servers')
      .insert(payload)
      .select('*')
      .single();

    if (error) throw new Error(`Failed to register MCP server: ${error.message}`);
    return data as McpServerConfig;
  }

  async refreshToolManifest(serverId: string): Promise<void> {
    const supabase = getSupabaseService();
    const { data: server, error } = await supabase.getClient()
      .from('mcp_servers')
      .select('id, url, auth_config')
      .eq('id', serverId)
      .single();

    if (error || !server) {
      throw new Error(error?.message ?? 'MCP server not found');
    }

    try {
      const token = (server.auth_config as Record<string, unknown>)?.token;
      const response = await fetch(`${String(server.url)}/tools/list`, {
        headers: token ? { Authorization: `Bearer ${String(token)}` } : {},
      });

      if (!response.ok) {
        throw new Error(`tools/list returned ${response.status}`);
      }

      const payload = await response.json() as { tools?: Array<{ name?: string }> };
      const tools = Array.isArray(payload.tools) ? payload.tools : [];
      const capabilities = tools
        .map((tool) => String(tool?.name ?? '').trim())
        .filter((name) => name.length > 0);

      await supabase.getClient()
        .from('mcp_servers')
        .update({
          status: 'online',
          tool_manifest: { tools },
          capabilities,
          last_ping_at: new Date().toISOString(),
        })
        .eq('id', serverId);
    } catch {
      await supabase.getClient()
        .from('mcp_servers')
        .update({ status: 'error', last_ping_at: new Date().toISOString() })
        .eq('id', serverId);
    }
  }

  /**
   * Pings an MCP server to check health.
   */
  async checkHealth(serverId: string): Promise<void> {
    await this.refreshToolManifest(serverId);
  }
}

let instance: McpRegistry | null = null;
export function getMcpRegistry(): McpRegistry {
  if (!instance) {
    instance = new McpRegistry();
  }
  return instance;
}
