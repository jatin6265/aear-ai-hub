import { getSupabaseService } from '../lib/supabase';

export type McpServerConfig = {
  id: string;
  name: string;
  url: string;
  auth_config: Record<string, unknown>;
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
   * Pings an MCP server to check health.
   */
  async checkHealth(serverId: string): Promise<void> {
    const supabase = getSupabaseService();
    const { data: server } = await supabase.getClient()
      .from('mcp_servers')
      .select('url')
      .eq('id', serverId)
      .single();

    if (!server) return;

    try {
      const response = await fetch(`${server.url}/health`, { method: 'GET' });
      const status = response.ok ? 'online' : 'error';
      
      await supabase.getClient()
        .from('mcp_servers')
        .update({ status, last_ping_at: new Date().toISOString() })
        .eq('id', serverId);
    } catch (err) {
      await supabase.getClient()
        .from('mcp_servers')
        .update({ status: 'error', last_ping_at: new Date().toISOString() })
        .eq('id', serverId);
    }
  }
}

let instance: McpRegistry | null = null;
export function getMcpRegistry(): McpRegistry {
  if (!instance) {
    instance = new McpRegistry();
  }
  return instance;
}
