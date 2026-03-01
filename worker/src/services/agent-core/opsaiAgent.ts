import { buildHybridContext, type HybridContext } from '../memory/builder';
import { loadTenantTools } from '../integration/registry';
import { OpenAIEngine } from './openaiEngine';
import { OpenClawRpcEngine } from './openclawRpcEngine';
import type { AgentEngine, AgentEngineRunOutput } from './types';

export type OpsAIAgentConfig = {
  tenantId: string;
  userId: string;
  runId: string;
  sessionId?: string;
  agent: {
    id: string;
    name: string;
    domain?: string;
    model?: string;
    systemPrompt: string;
    config: Record<string, unknown>;
  };
};

export class OpsAIAgent {
  private readonly config: OpsAIAgentConfig;

  constructor(config: OpsAIAgentConfig) {
    this.config = config;
  }

  async run(input: string): Promise<{ engine: string; result: AgentEngineRunOutput; context: HybridContext }> {
    const context = await buildHybridContext({
      query: input,
      tenantId: this.config.tenantId,
      userId: this.config.userId,
      limit: 10,
    });

    const allowedToolCodes = arrayOfStrings(this.config.agent.config.tool_ids);
    const allowedMcpServerIds = arrayOfStrings(this.config.agent.config.mcp_server_ids);

    const tools = await loadTenantTools({
      tenantId: this.config.tenantId,
      userId: this.config.userId,
      runId: this.config.runId,
      sessionId: this.config.sessionId,
      agentId: this.config.agent.id,
      allowedToolCodes,
      allowedMcpServerIds,
    });

    const model = String(this.config.agent.model || this.config.agent.config.model || process.env.OPENAI_MODEL || 'gpt-4.1-mini');
    const systemPrompt = buildEnhancedPrompt(this.config.agent.systemPrompt, context);

    const engine = createEngine();
    const result = await runWithCutover(engine, {
      model,
      input,
      systemPrompt,
      tools,
      maxTurns: 8,
    });

    return {
      engine: result.engine,
      result: result.output,
      context,
    };
  }
}

function createEngine(): AgentEngine {
  const preferred = String(process.env.AGENT_RUNTIME_ENGINE || 'openclaw').toLowerCase();

  if (preferred === 'openclaw') {
    return new OpenClawRpcEngine();
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for openai agent runtime');
  }
  return new OpenAIEngine(apiKey);
}

async function runWithCutover(
  engine: AgentEngine,
  input: { model: string; input: string; systemPrompt: string; tools: any[]; maxTurns: number }
): Promise<{ engine: string; output: AgentEngineRunOutput }> {
  try {
    const output = await engine.run(input);
    return { engine: engine.name, output };
  } catch (error) {
    const strict = String(process.env.OPENCLAW_STRICT || 'false').toLowerCase() === 'true';
    if (engine.name !== 'openclaw-rpc' || strict) {
      throw error;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw error;
    }

    // Compat fallback during Phase-1 rollout. Disable with OPENCLAW_STRICT=true.
    const fallback = new OpenAIEngine(apiKey);
    const output = await fallback.run(input);
    return { engine: fallback.name, output };
  }
}

// Maximum characters per section injected into the system prompt.
// Keeps total context overhead within ~2500 tokens (generous, avoids LLM overload).
const CTX_SEMANTIC_ITEM_MAX = 500;   // per semantic chunk
const CTX_TIMELINE_ITEM_MAX = 300;   // per timeline event
const CTX_STRUCTURED_ITEM_MAX = 200; // per structured entity description
const CTX_SCHEMA_MAX = 1500;         // total schema block

function buildEnhancedPrompt(basePrompt: string, context: HybridContext): string {
  const semantic = context.semantic.length > 0
    ? context.semantic
        .map((item) => `- (${item.source_kind}) ${cap(item.content, CTX_SEMANTIC_ITEM_MAX)}`)
        .join('\n')
    : '- none';

  const timeline = context.timeline.length > 0
    ? context.timeline
        .slice(0, 20)
        .map((item) => `- ${item.occurred_at || 'unknown'}: ${cap(item.content, CTX_TIMELINE_ITEM_MAX)}`)
        .join('\n')
    : '- none';

  const structured = context.structured.length > 0
    ? context.structured
        .map((item) => `- ${item.entity} [risk:${item.risk_level}] ${cap(item.description, CTX_STRUCTURED_ITEM_MAX)}`)
        .join('\n')
    : '- none';

  const schema = cap(context.schema || '- none', CTX_SCHEMA_MAX);

  return [
    basePrompt,
    '',
    '# CONTEXT FROM MEMORY',
    semantic,
    '',
    '# STRUCTURED ENTITY HINTS',
    structured,
    '',
    '# SCHEMA CONTEXT',
    schema,
    '',
    '# RECENT EVENTS',
    timeline,
    '',
    '# GOVERNANCE RULES',
    '- Respect RACI permissions before every action.',
    '- HIGH/CRITICAL actions require approval.',
    '- Never fabricate tool outputs.',
    `- User role: ${context.userRole}`,
    `- Allowed resources: ${context.allowedResources.join(', ') || 'none'}`,
  ].join('\n');
}

/** Truncate a string to maxLen characters, appending '…' if cut. */
function cap(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0);
}
