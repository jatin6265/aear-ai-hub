import { getSupabaseService } from '../../lib/supabase';
import { getMcpRouter } from '../../mcp/mcpRouter';
import { governanceWrappedExecute } from '../governance/wrapper';
import type { RuntimeTool } from '../agent-core/types';

export async function loadTenantTools(input: {
  tenantId: string;
  userId: string;
  runId?: string;
  sessionId?: string;
  agentId?: string;
  allowedToolCodes?: string[];
  allowedMcpServerIds?: string[];
}): Promise<RuntimeTool[]> {
  const supabase = getSupabaseService();
  const mcpRouter = getMcpRouter();

  const [toolRowsResponse, discoveredMcpTools] = await Promise.all([
    supabase.getClient()
      .from('tool_registry')
      .select('code, display_name, description, input_schema, risk_level, is_write_action, handler_key, default_config')
      .eq('tenant_id', input.tenantId)
      .eq('is_active', true)
      .limit(200),
    mcpRouter.listAvailableTools(input.tenantId),
  ]);

  const allowedToolCodes = new Set((input.allowedToolCodes ?? []).map((value) => normalize(value)));
  const allowedMcpServers = new Set((input.allowedMcpServerIds ?? []).map((value) => String(value)));

  const registryTools: RuntimeTool[] = (toolRowsResponse.data ?? [])
    .map((row) => toRuntimeToolFromRegistry({
      row: row as Record<string, unknown>,
      tenantId: input.tenantId,
      userId: input.userId,
      runId: input.runId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      mcpRouter,
    }))
    .filter((tool): tool is RuntimeTool => Boolean(tool))
    .filter((tool) => allowedToolCodes.size === 0 || allowedToolCodes.has(normalize(tool.name)));

  const mcpTools: RuntimeTool[] = discoveredMcpTools
    .filter((tool) => allowedMcpServers.size === 0 || allowedMcpServers.has(tool.serverId))
    .map((tool) => {
      const requiresWrite = inferRequiresWrite(tool.name);
      const riskLevel = requiresWrite ? 'medium' : 'low';

      return {
        name: tool.name,
        description: tool.description || `Execute ${tool.name} via MCP`,
        parameters: tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true },
        metadata: {
          source: 'mcp',
          serverId: tool.serverId,
          serverName: tool.serverName,
          riskLevel,
          requiresWrite,
        },
        execute: async (params: Record<string, unknown>) => {
          const governed = await governanceWrappedExecute({
            tenantId: input.tenantId,
            userId: input.userId,
            toolName: tool.name,
            resource: tool.name,
            action: inferAction(tool.name, requiresWrite),
            params,
            riskLevel,
            requiresWrite,
            context: {
              runId: input.runId,
              sessionId: input.sessionId,
              agentId: input.agentId,
            },
            execute: async () => {
              const result = await mcpRouter.callTool({
                toolName: tool.name,
                serverId: tool.serverId,
                params,
                tenantId: input.tenantId,
                userId: input.userId,
              });
              if (!result.success) {
                throw new Error(result.error ?? 'MCP tool call failed');
              }
              return result.data ?? null;
            },
          });
          return governed;
        },
      };
    });

  const merged = new Map<string, RuntimeTool>();
  for (const tool of [...registryTools, ...mcpTools]) {
    const key = normalize(tool.name);
    if (!merged.has(key)) {
      merged.set(key, tool);
    }
  }

  return [...merged.values()].slice(0, 80);
}

function toRuntimeToolFromRegistry(input: {
  row: Record<string, unknown>;
  tenantId: string;
  userId: string;
  runId?: string;
  sessionId?: string;
  agentId?: string;
  mcpRouter: ReturnType<typeof getMcpRouter>;
}): RuntimeTool | null {
  const code = String(input.row.code ?? '').trim();
  if (!code) return null;

  const displayName = String(input.row.display_name ?? code);
  const description = String(input.row.description ?? `Execute ${displayName}`);
  const inputSchema = asRecord(input.row.input_schema);
  const handlerKey = String(input.row.handler_key ?? 'tool.http_request').trim();
  const riskLevel = normalizeRiskLevel(String(input.row.risk_level ?? 'medium'));
  const requiresWrite = Boolean(input.row.is_write_action);
  const defaultConfig = asRecord(input.row.default_config);

  return {
    name: code,
    description,
    parameters: Object.keys(inputSchema).length > 0
      ? inputSchema
      : { type: 'object', properties: {}, additionalProperties: true },
    metadata: {
      source: handlerKey,
      riskLevel,
      requiresWrite,
    },
    execute: async (params: Record<string, unknown>) => {
      return await governanceWrappedExecute({
        tenantId: input.tenantId,
        userId: input.userId,
        toolName: code,
        resource: code,
        action: inferAction(code, requiresWrite),
        params,
        riskLevel,
        requiresWrite,
        context: {
          runId: input.runId,
          sessionId: input.sessionId,
          agentId: input.agentId,
        },
        execute: async () => {
          if (handlerKey === 'tool.mcp_proxy') {
            const serverId = String(defaultConfig.mcp_server_id ?? '').trim() || undefined;
            const result = await input.mcpRouter.callTool({
              toolName: code,
              serverId,
              params,
              tenantId: input.tenantId,
              userId: input.userId,
            });
            if (!result.success) throw new Error(result.error ?? 'MCP proxy tool failed');
            return result.data ?? null;
          }

          if (handlerKey === 'tool.sql_query') {
            throw new Error(
              'SQL governed tool execution must run via authenticated edge path; worker service-role execution is disabled for this handler.'
            );
          }

          throw new Error(`Tool handler not implemented for ${handlerKey}`);
        },
      });
    },
  };
}

function normalizeRiskLevel(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'critical') {
    return normalized;
  }
  return 'medium';
}

function inferAction(toolName: string, requiresWrite: boolean): string {
  if (!requiresWrite) return 'read';
  const lower = toolName.toLowerCase();
  if (lower.includes('delete') || lower.includes('remove') || lower.includes('drop')) return 'delete';
  if (lower.includes('create') || lower.includes('insert') || lower.includes('add')) return 'create';
  if (lower.includes('update') || lower.includes('modify') || lower.includes('patch')) return 'update';
  return 'execute';
}

function inferRequiresWrite(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  if (
    lower.includes('get') ||
    lower.includes('list') ||
    lower.includes('read') ||
    lower.includes('fetch') ||
    lower.includes('search') ||
    lower.includes('query')
  ) {
    return false;
  }
  return true;
}

function normalize(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
