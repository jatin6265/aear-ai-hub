import OpenAI from 'openai';
import { getSupabaseService } from '../lib/supabase';

export type AgentBlueprint = {
  name: string;
  description: string;
  model: string;
  system_prompt: string;
  tool_ids: string[];
  mcp_server_ids: string[];
  risk_policies: {
    max_risk_level: 'low' | 'medium' | 'high' | 'critical';
    requires_approval_above: 'low' | 'medium' | 'high';
    allowed_tool_categories: string[];
  };
  memory_config: {
    short_term_enabled: boolean;
    long_term_enabled: boolean;
    semantic_search_enabled: boolean;
    context_window_turns: number;
  };
};

/**
 * Generates validated agent blueprints from natural language prompts.
 *
 * Uses GPT-4 with Structured Output (JSON schema enforcement) to generate
 * a validated agent blueprint with no hallucinated tool names.
 *
 * User: "Build me a finance monitoring agent" →
 * AI generates validated JSON blueprint with name, model, system_prompt,
 * tool_ids[], mcp_server_ids[], risk_policies, memory_config
 */
export class AgentBuilder {
  private openai: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is missing');
    }
    this.openai = new OpenAI({ apiKey });
  }

  /**
   * Generates an agent blueprint from a natural language description.
   */
  async generateBlueprint(
    tenantId: string,
    prompt: string
  ): Promise<AgentBlueprint> {
    const supabase = getSupabaseService();

    // Fetch available tools for this tenant to prevent hallucination
    const { data: tools } = await supabase.getClient()
      .from('tool_registry')
      .select('code, display_name, category, risk_level')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .limit(50);

    // Fetch available MCP servers
    const { data: mcpServers } = await supabase.getClient()
      .from('mcp_servers')
      .select('id, name, description')
      .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
      .eq('is_active', true);

    const toolList = (tools ?? []).map((t: Record<string, unknown>) =>
      `${t.code} (${t.category}, risk: ${t.risk_level})`
    ).join('\n');

    const mcpList = (mcpServers ?? []).map((s: Record<string, unknown>) =>
      `${s.id}: ${s.name} - ${s.description}`
    ).join('\n');

    const systemPrompt = `You are an AI agent blueprint generator for OpsAI Enterprise Platform.
Generate a production-ready agent blueprint in strict JSON format.

Available tools for this tenant:
${toolList || '(none yet)'}

Available MCP servers:
${mcpList || '(none yet)'}

CRITICAL RULES:
- Only use tool codes from the provided list - never hallucinate tool names
- Only use MCP server IDs from the provided list
- system_prompt must include tenant governance context
- risk_policies must be conservative for enterprise use`;

    const response = await this.openai.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Generate an agent blueprint for: ${prompt}

Return ONLY valid JSON matching this exact schema:
{
  "name": "string (concise agent name)",
  "description": "string (what this agent does)",
  "model": "gpt-4o",
  "system_prompt": "string (detailed system prompt with governance context)",
  "tool_ids": ["array of tool codes from the provided list"],
  "mcp_server_ids": ["array of MCP server IDs from the provided list"],
  "risk_policies": {
    "max_risk_level": "medium",
    "requires_approval_above": "medium",
    "allowed_tool_categories": ["array of categories"]
  },
  "memory_config": {
    "short_term_enabled": true,
    "long_term_enabled": true,
    "semantic_search_enabled": true,
    "context_window_turns": 10
  }
}`,
        },
      ],
      temperature: 0.3,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'agent_blueprint',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: [
              'name',
              'description',
              'model',
              'system_prompt',
              'tool_ids',
              'mcp_server_ids',
              'risk_policies',
              'memory_config',
            ],
            properties: {
              name: { type: 'string', minLength: 3, maxLength: 120 },
              description: { type: 'string', minLength: 10, maxLength: 500 },
              model: { type: 'string' },
              system_prompt: { type: 'string', minLength: 20 },
              tool_ids: { type: 'array', items: { type: 'string' } },
              mcp_server_ids: { type: 'array', items: { type: 'string' } },
              risk_policies: {
                type: 'object',
                additionalProperties: false,
                required: ['max_risk_level', 'requires_approval_above', 'allowed_tool_categories'],
                properties: {
                  max_risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
                  requires_approval_above: { type: 'string', enum: ['low', 'medium', 'high'] },
                  allowed_tool_categories: { type: 'array', items: { type: 'string' } },
                },
              },
              memory_config: {
                type: 'object',
                additionalProperties: false,
                required: ['short_term_enabled', 'long_term_enabled', 'semantic_search_enabled', 'context_window_turns'],
                properties: {
                  short_term_enabled: { type: 'boolean' },
                  long_term_enabled: { type: 'boolean' },
                  semantic_search_enabled: { type: 'boolean' },
                  context_window_turns: { type: 'integer', minimum: 1, maximum: 50 },
                },
              },
            },
          },
        },
      } as any,
    });

    const content = response.choices[0]?.message?.content ?? '{}';
    const blueprint = JSON.parse(content) as Partial<AgentBlueprint>;

    // Validate that tool_ids only contain real tools
    const validToolCodes = new Set((tools ?? []).map((t: Record<string, unknown>) => t.code as string));
    const filteredToolIds = Array.isArray(blueprint.tool_ids)
      ? blueprint.tool_ids.filter((id) => validToolCodes.has(id))
      : [];

    // Validate MCP server IDs
    const validMcpIds = new Set((mcpServers ?? []).map((s: Record<string, unknown>) => s.id as string));
    const filteredMcpIds = Array.isArray(blueprint.mcp_server_ids)
      ? blueprint.mcp_server_ids.filter((id) => validMcpIds.has(id))
      : [];

    return {
      name: String(blueprint.name ?? 'Generated Agent').slice(0, 120),
      description: String(blueprint.description ?? 'Auto-generated OpsAI agent'),
      model: String(blueprint.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'),
      system_prompt: String(blueprint.system_prompt ?? 'You are an OpsAI enterprise agent.'),
      tool_ids: filteredToolIds,
      mcp_server_ids: filteredMcpIds,
      risk_policies: {
        max_risk_level: normalizeRiskLevel(blueprint.risk_policies?.max_risk_level),
        requires_approval_above: normalizeApprovalThreshold(blueprint.risk_policies?.requires_approval_above),
        allowed_tool_categories: Array.isArray(blueprint.risk_policies?.allowed_tool_categories)
          ? blueprint.risk_policies!.allowed_tool_categories
          : [],
      },
      memory_config: {
        short_term_enabled: Boolean(blueprint.memory_config?.short_term_enabled ?? true),
        long_term_enabled: Boolean(blueprint.memory_config?.long_term_enabled ?? true),
        semantic_search_enabled: Boolean(blueprint.memory_config?.semantic_search_enabled ?? true),
        context_window_turns: clampTurns(blueprint.memory_config?.context_window_turns),
      },
    };
  }

  /**
   * Saves a generated blueprint as an agent in the database.
   */
  async saveAgent(tenantId: string, userId: string, blueprint: AgentBlueprint): Promise<string> {
    const supabase = getSupabaseService();
    const slug = slugify(blueprint.name);
    const domain = inferDomain(blueprint.description, blueprint.name);

    const { data, error } = await supabase.getClient()
      .from('ai_agents')
      .insert({
        tenant_id: tenantId,
        created_by: userId,
        name: blueprint.name,
        slug,
        domain,
        description: blueprint.description,
        config: {
          model: blueprint.model,
          system_prompt: blueprint.system_prompt,
          tool_ids: blueprint.tool_ids,
          mcp_server_ids: blueprint.mcp_server_ids,
          risk_policies: blueprint.risk_policies,
          memory_config: blueprint.memory_config,
        },
        status: 'ready',
      })
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to save agent: ${error.message}`);
    }

    return (data as Record<string, unknown>).id as string;
  }
}

function normalizeRiskLevel(value: unknown): 'low' | 'medium' | 'high' | 'critical' {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'critical') {
    return normalized;
  }
  return 'medium';
}

function normalizeApprovalThreshold(value: unknown): 'low' | 'medium' | 'high' {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return 'medium';
}

function clampTurns(value: unknown): number {
  const turns = Number(value ?? 10);
  if (!Number.isFinite(turns)) return 10;
  return Math.max(1, Math.min(50, Math.floor(turns)));
}

function slugify(value: string): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'generated_agent';
}

function inferDomain(...hints: string[]): string {
  const text = hints.join(' ').toLowerCase();
  if (/(finance|invoice|revenue|accounting|payment)/.test(text)) return 'finance';
  if (/(hr|employee|people|payroll|talent)/.test(text)) return 'hr';
  if (/(devops|deploy|infrastructure|incident|monitor)/.test(text)) return 'devops';
  if (/(crm|customer|lead|deal|sales|support)/.test(text)) return 'crm';
  return 'general';
}

let instance: AgentBuilder | null = null;
export function getAgentBuilder(): AgentBuilder {
  if (!instance) {
    instance = new AgentBuilder();
  }
  return instance;
}
