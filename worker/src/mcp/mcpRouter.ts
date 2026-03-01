import { getMcpRegistry } from './mcpRegistry';
import { getGovernanceMiddleware } from '../governance/governanceMiddleware';
import { getSupabaseService } from '../lib/supabase';

const MCP_CALL_TIMEOUT_MS = Number(process.env.MCP_CALL_TIMEOUT_MS ?? 30_000);
const MCP_LIST_TIMEOUT_MS = Number(process.env.MCP_LIST_TIMEOUT_MS ?? 10_000);

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

type RemoteTool = {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
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
      await this.logAudit(call, 'blocked', null, `No MCP server found for ${call.toolName}`);
      return { success: false, error: `No active MCP server found for tool: ${call.toolName}` };
    }

    // 3. Execute the tool call via MCP protocol
    try {
      const serverTools = await this.listToolsFromServer(server);
      const declaredTool = serverTools.find((tool) => tool.name === call.toolName);
      if (!declaredTool) {
        await this.logAudit(call, 'blocked', null, `Unknown tool on server: ${call.toolName}`);
        return {
          success: false,
          error: `Unknown tool "${call.toolName}" for server "${server.name}"`,
        };
      }

      const callController = new AbortController();
      const callTimeout = setTimeout(() => callController.abort(), MCP_CALL_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(`${server.url}/tools/call`, {
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
          signal: callController.signal,
        });
      } finally {
        clearTimeout(callTimeout);
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MCP server returned ${response.status}: ${errorText}`);
      }

      const rawResult = await response.json() as unknown;
      const result = this.validateToolResult(call, declaredTool, rawResult);
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
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  }>> {
    const registry = getMcpRegistry();
    const servers = await registry.getActiveServers(tenantId);
    const allTools: Array<{
      name: string;
      description: string;
      serverId: string;
      serverName: string;
      inputSchema?: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
    }> = [];

    for (const server of servers) {
      try {
        const tools = await this.listToolsFromServer(server);
        for (const tool of tools) {
          allTools.push({
            name: tool.name,
            description: tool.description ?? '',
            serverId: server.id,
            serverName: server.name,
            inputSchema: isRecord(tool.input_schema) ? tool.input_schema : undefined,
            outputSchema: isRecord(tool.output_schema) ? tool.output_schema : undefined,
          });
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
  ): Promise<Array<RemoteTool>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MCP_LIST_TIMEOUT_MS);
    try {
      const response = await fetch(`${server.url}/tools/list`, {
        headers: server.auth_config.token
          ? { Authorization: `Bearer ${server.auth_config.token}` }
          : {},
        signal: controller.signal,
      });
      if (!response.ok) return [];
      const data = await response.json() as { tools?: Array<RemoteTool> };
      return (data.tools ?? []).filter((tool) => String(tool?.name ?? '').trim().length > 0);
    } finally {
      clearTimeout(timeout);
    }
  }

  private validateToolResult(call: McpToolCall, tool: RemoteTool, rawResult: unknown): unknown {
    if (!isRecord(rawResult) && !Array.isArray(rawResult)) {
      throw new Error(`Tool output must be JSON object/array for ${call.toolName}`);
    }

    const schema = isRecord(tool.output_schema) ? tool.output_schema : null;
    if (!schema) return rawResult;

    if (schema.type === 'object' && !isRecord(rawResult)) {
      throw new Error(`Tool output schema mismatch for ${call.toolName}: expected object`);
    }

    if (isRecord(rawResult) && Array.isArray(schema.required)) {
      for (const key of schema.required) {
        const field = String(key ?? '').trim();
        if (!field) continue;
        if (!(field in rawResult)) {
          throw new Error(`Tool output schema mismatch for ${call.toolName}: missing "${field}"`);
        }
      }
    }

    return rawResult;
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
      user_id: call.userId,
      action: 'mcp.tool_call',
      resource: call.toolName,
      risk_level: 'medium',
      status: outcome,
      details: {
        server_id: call.serverId ?? null,
        params: call.params,
        result: result ?? null,
        error: error ?? null,
      },
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

let instance: McpRouter | null = null;
export function getMcpRouter(): McpRouter {
  if (!instance) {
    instance = new McpRouter();
  }
  return instance;
}
