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
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
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
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content ?? '{}';
    const blueprint = JSON.parse(content) as AgentBlueprint;

    // Validate that tool_ids only contain real tools
    const validToolCodes = new Set((tools ?? []).map((t: Record<string, unknown>) => t.code as string));
    blueprint.tool_ids = blueprint.tool_ids.filter((id) => validToolCodes.has(id));

    // Validate MCP server IDs
    const validMcpIds = new Set((mcpServers ?? []).map((s: Record<string, unknown>) => s.id as string));
    blueprint.mcp_server_ids = blueprint.mcp_server_ids.filter((id) => validMcpIds.has(id));

    return blueprint;
  }

  /**
   * Saves a generated blueprint as an agent in the database.
   */
  async saveAgent(tenantId: string, userId: string, blueprint: AgentBlueprint): Promise<string> {
    const supabase = getSupabaseService();

    const { data, error } = await supabase.getClient()
      .from('ai_agents')
      .insert({
        tenant_id: tenantId,
        created_by: userId,
        name: blueprint.name,
        description: blueprint.description,
        model: blueprint.model,
        system_prompt: blueprint.system_prompt,
        config: {
          tool_ids: blueprint.tool_ids,
          mcp_server_ids: blueprint.mcp_server_ids,
          risk_policies: blueprint.risk_policies,
          memory_config: blueprint.memory_config,
        },
        status: 'active',
      })
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to save agent: ${error.message}`);
    }

    return (data as Record<string, unknown>).id as string;
  }
}

let instance: AgentBuilder | null = null;
export function getAgentBuilder(): AgentBuilder {
  if (!instance) {
    instance = new AgentBuilder();
  }
  return instance;
}
