import { getMcpRegistry } from './mcpRegistry';
import { getGovernanceMiddleware } from '../governance/governanceMiddleware';
import { getSupabaseService } from '../lib/supabase';

export type McpToolCall = {
  toolName: string;
  serverId?: string;
  params: Record<string, unknown>;
  tenantId: string;
  userId: string;
};

export type McpToolResult = {
  success: boolean;
  data?: unknown;
  error?: string;
};

/**
 * Routes tool calls to the correct MCP server, with governance enforcement.
 * Critical: MCP tools MUST pass RACI + risk checks before execution.
 *
 * Agent → MCP Router → RACI Check → Risk Classification → Approval (if needed) → Execute → Audit Log
 */
export class McpRouter {
  /**
   * Executes a tool call via the appropriate MCP server.
   */
  async callTool(call: McpToolCall): Promise<McpToolResult> {
    const supabase = getSupabaseService();
    const governance = getGovernanceMiddleware();
    const registry = getMcpRegistry();

    // 1. Governance check FIRST - MCP tools are not exempt
    const decision = await governance.evaluateAction(
      call.tenantId,
      call.userId,
      call.toolName,
      call.params
    );

    if (!decision.allowed) {
      await this.logAudit(call, 'blocked', null, decision.reason);
      return {
        success: false,
        error: `Governance block: ${decision.reason ?? 'Action not permitted'}`,
      };
    }

    if (decision.requires_approval) {
      await this.logAudit(call, 'pending_approval', null, 'Requires approval');
      return {
        success: false,
        error: 'Action requires approval. Please check your approvals queue.',
      };
    }

    // 2. Find the right MCP server
    const servers = await registry.getActiveServers(call.tenantId);
    const server = call.serverId
      ? servers.find((s) => s.id === call.serverId)
      : await this.findServerForTool(call.toolName, servers);

    if (!server) {
      return { success: false, error: `No active MCP server found for tool: ${call.toolName}` };
    }

    // 3. Execute the tool call via MCP protocol
    try {
      const response = await fetch(`${server.url}/tools/call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(server.auth_config.token
            ? { Authorization: `Bearer ${server.auth_config.token}` }
            : {}),
        },
        body: JSON.stringify({
          name: call.toolName,
          arguments: call.params,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MCP server returned ${response.status}: ${errorText}`);
      }

      const result = await response.json() as unknown;
      await this.logAudit(call, 'success', result, null);

      return { success: true, data: result };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.logAudit(call, 'error', null, errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Lists all available tools across active MCP servers for a tenant.
   */
  async listAvailableTools(tenantId: string): Promise<Array<{
    name: string;
    description: string;
    serverId: string;
    serverName: string;
  }>> {
    const registry = getMcpRegistry();
    const servers = await registry.getActiveServers(tenantId);
    const allTools: Array<{ name: string; description: string; serverId: string; serverName: string }> = [];

    for (const server of servers) {
      try {
        const response = await fetch(`${server.url}/tools/list`, {
          headers: server.auth_config.token
            ? { Authorization: `Bearer ${server.auth_config.token}` }
            : {},
        });
        if (response.ok) {
          const data = await response.json() as { tools?: Array<{ name: string; description?: string }> };
          const tools = data.tools ?? [];
          for (const tool of tools) {
            allTools.push({
              name: tool.name,
              description: tool.description ?? '',
              serverId: server.id,
              serverName: server.name,
            });
          }
        }
      } catch {
        // Server unreachable - skip
      }
    }

    return allTools;
  }

  private async findServerForTool(
    toolName: string,
    servers: Array<{ id: string; url: string; name: string; auth_config: Record<string, unknown> }>
  ): Promise<(typeof servers)[0] | null> {
    for (const server of servers) {
      try {
        const tools = await this.listToolsFromServer(server);
        if (tools.some((t) => t.name === toolName)) {
          return server;
        }
      } catch {
        // Skip unreachable servers
      }
    }
    return null;
  }

  private async listToolsFromServer(
    server: { url: string; auth_config: Record<string, unknown> }
  ): Promise<Array<{ name: string }>> {
    const response = await fetch(`${server.url}/tools/list`, {
      headers: server.auth_config.token
        ? { Authorization: `Bearer ${server.auth_config.token}` }
        : {},
    });
    if (!response.ok) return [];
    const data = await response.json() as { tools?: Array<{ name: string }> };
    return data.tools ?? [];
  }

  private async logAudit(
    call: McpToolCall,
    outcome: string,
    result: unknown,
    error: string | null | undefined
  ): Promise<void> {
    const supabase = getSupabaseService();
    await supabase.getClient().from('audit_logs').insert({
      tenant_id: call.tenantId,
      actor_id: call.userId,
      action_type: 'mcp_tool_call',
      resource_type: 'mcp_tool',
      resource_id: call.serverId ?? null,
      payload: { tool_name: call.toolName, params: call.params },
      outcome,
      result: result ?? null,
      error_message: error ?? null,
    });
  }
}

let instance: McpRouter | null = null;
export function getMcpRouter(): McpRouter {
  if (!instance) {
    instance = new McpRouter();
  }
  return instance;
}
