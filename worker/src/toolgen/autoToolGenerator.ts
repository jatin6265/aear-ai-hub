import { getSupabaseService } from '../lib/supabase';
import { sanitizeName } from '../lib/utils';
import { getMcpRegistry, type ToolingApproach } from '../mcp/mcpRegistry';

export class AutoToolGenerator {
  /**
   * Generates tool definitions for a specific connection based on its discovered schema.
   */
  async generateToolsForConnection(connectionId: string): Promise<void> {
    const supabase = getSupabaseService();

    // 1. Fetch connection and entities
    const { data: connection } = await supabase.getClient()
      .from('api_connections')
      .select('*')
      .eq('id', connectionId)
      .single();

    if (!connection) throw new Error('Connection not found');

    const { data: entities } = await supabase.getClient()
      .from('schema_entities')
      .select('*')
      .eq('connection_id', connectionId);

    if (!entities || entities.length === 0) return;

      // 2. Map entities to tool definitions
    for (const entity of entities) {
      const toolCode = sanitizeName(`${connection.name}_get_${entity.name}`);
      
      const toolDefinition = {
        tenant_id: connection.tenant_id,
        code: toolCode,
        display_name: `Get ${entity.name}`,
        description: `Fetch records from ${entity.name} in ${connection.name}.`,
        category: 'data_source',
        handler_key: 'sql_query_handler', // Default for DB connections
        input_schema: {
          type: 'object',
          properties: {
            filters: { type: 'object', description: 'Query filters' },
            limit: { type: 'number', default: 10 }
          }
        },
        risk_level: 'low',
        is_write_action: false
      };

      // 3. Upsert into tool registry
      await supabase.getClient()
        .from('tool_registry')
        .upsert(toolDefinition, { onConflict: 'tenant_id,code' });
    }
  }

  /**
   * Auto-generates tenant tools from integration catalog tool_templates.
   * Strategy: MCP (preferred) -> OpenAPI discovery -> custom template fallback.
   */
  async generateToolsForIntegrationInstall(
    tenantId: string,
    integrationCode: string,
    options: { credentialId?: string | null; createdBy?: string | null } = {}
  ): Promise<{ strategy: ToolingApproach; generatedTools: number; mcpServerId: string | null }> {
    const supabase = getSupabaseService();
    const mcpRegistry = getMcpRegistry();
    const code = sanitizeName(integrationCode);

    const { data: integration, error: integrationError } = await supabase.getClient()
      .from('integration_catalog')
      .select('id, code, display_name, category, auth_type, connection_type, docs_url, mcp_server_url, tool_templates')
      .eq('code', code)
      .eq('is_active', true)
      .maybeSingle();

    if (integrationError) throw new Error(`Failed to load integration catalog: ${integrationError.message}`);
    if (!integration) throw new Error(`Integration not found: ${integrationCode}`);

    const strategy = mcpRegistry.resolveToolingApproach(integration);
    let mcpServerId: string | null = null;

    if (strategy === 'mcp') {
      const server = await mcpRegistry.registerTenantServerFromCatalog(tenantId, code, {
        credentialId: options.credentialId ?? null,
        authType: String(integration.auth_type ?? ''),
      });
      mcpServerId = server?.id ?? null;
    }

    const templates = Array.isArray(integration.tool_templates)
      ? (integration.tool_templates as Array<Record<string, unknown>>)
      : [];

    let generatedTools = 0;
    for (const template of templates) {
      const templateName = sanitizeName(String(template.name ?? ''));
      if (!templateName) continue;

      const riskLevel = normalizeRiskLevel(template.risk_level);
      const requiresApproval = riskLevel === 'high' || riskLevel === 'critical' || Boolean(template.requires_approval);
      const toolCode = sanitizeName(`${code}_${templateName}`);
      const toolType = String(template.tool_type ?? 'http_call').trim().toLowerCase();
      const handlerKey = resolveHandlerKey(toolType, strategy);

      const upsertPayload = {
        tenant_id: tenantId,
        code: toolCode,
        display_name: String(template.display_name ?? humanizeToolName(templateName)),
        description: String(template.description ?? `Auto-generated tool for ${integration.display_name}`),
        category: sanitizeName(String(integration.category ?? 'integration')),
        input_schema: isRecord(template.input_schema)
          ? (template.input_schema as Record<string, unknown>)
          : { type: 'object', properties: {}, additionalProperties: true },
        default_config: {
          integration_code: code,
          strategy,
          template,
          mcp_server_id: mcpServerId,
          generated_by: 'auto_tool_generator',
        },
        handler_key: handlerKey,
        requires_credential_service: code,
        risk_level: riskLevel,
        raci_required: requiresApproval ? 'A' : 'R',
        is_write_action: Boolean(template.is_destructive) || requiresApproval,
        is_active: true,
        version: 'v1',
      };

      await supabase.getClient()
        .from('tool_registry')
        .upsert(upsertPayload, { onConflict: 'tenant_id,code' });

      generatedTools += 1;
    }

    const { data: integrationRow } = await supabase.getClient()
      .from('integration_catalog')
      .select('id')
      .eq('code', code)
      .maybeSingle();
    const integrationId = (integrationRow as Record<string, unknown> | null)?.id as string | undefined;

    if (integrationId) {
      await supabase.getClient()
        .from('tenant_integration_installs')
        .upsert({
          tenant_id: tenantId,
          integration_id: integrationId,
          status: 'installed',
          installed_by: options.createdBy ?? null,
          installed_at: new Date().toISOString(),
          uninstalled_at: null,
          last_synced_at: null,
        }, { onConflict: 'tenant_id,integration_id' });
    }

    return { strategy, generatedTools, mcpServerId };
  }
}

function normalizeRiskLevel(value: unknown): 'low' | 'medium' | 'high' | 'critical' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'critical') {
    return normalized;
  }
  return 'low';
}

function resolveHandlerKey(toolType: string, strategy: ToolingApproach): string {
  if (toolType === 'sql_query') return 'tool.sql_query';
  if (toolType === 'transformation') return 'tool.transform';
  if (toolType === 'notification') return 'tool.notify';
  if (strategy === 'mcp') return 'tool.mcp_proxy';
  if (strategy === 'openapi') return 'tool.openapi_proxy';
  return 'tool.http_request';
}

function humanizeToolName(name: string): string {
  const withSpaces = name.replace(/_/g, ' ').trim();
  return withSpaces.slice(0, 1).toUpperCase() + withSpaces.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

let instance: AutoToolGenerator | null = null;
export function getAutoToolGenerator(): AutoToolGenerator {
  if (!instance) {
    instance = new AutoToolGenerator();
  }
  return instance;
}
