import { getSupabaseService } from '../lib/supabase';
import { getRetriever } from '../pipeline/retriever';
import OpenAI from 'openai';

import { getGovernanceMiddleware } from '../governance/governanceMiddleware';
import { getMcpRouter } from '../mcp/mcpRouter';

export class AgentLoop {
  private openai: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is missing');
    }
    this.openai = new OpenAI({ apiKey });
  }

  /**
   * Executes a single turn of the agent loop.
   */
  async runTurn(runId: string): Promise<void> {
    const supabase = getSupabaseService();
    const retriever = getRetriever();
    const governance = getGovernanceMiddleware();
    const mcpRouter = getMcpRouter();

    // 1. Fetch run details
    const { data: run, error: fetchError } = await supabase.getClient()
      .from('agent_runs')
      .select('*, ai_agents(*)')
      .eq('id', runId)
      .single();

    if (fetchError || !run) {
      throw new Error(`Run not found: ${runId}`);
    }

    try {
      // 2. Pre-execution Governance Check
      const decision = await governance.evaluateAction(
        run.tenant_id,
        run.requested_by,
        'agent_execution', // Core agent turn
        { agent_id: run.agent_id }
      );

      if (!decision.allowed) {
        throw new Error(`Governance Block: ${decision.reason}`);
      }

      // 3. Load context (Semantic memory)
      const context = await retriever.search(run.tenant_id, JSON.stringify(run.input));
      const contextText = context.map(c => c.content).join('\n---\n');

      const agentConfig = (run.ai_agents?.config && isRecord(run.ai_agents.config))
        ? run.ai_agents.config
        : {};
      const allowedToolIds = toStringArray(agentConfig.tool_ids);
      const allowedServerIds = toStringArray(agentConfig.mcp_server_ids);

      // 4. Load tenant MCP servers/tools and pass through governance-enforced execution.
      const discoveredTools = await mcpRouter.listAvailableTools(run.tenant_id);
      const filteredTools = discoveredTools
        .filter((tool) => {
          if (allowedServerIds.length > 0 && !allowedServerIds.includes(tool.serverId)) return false;
          if (allowedToolIds.length === 0) return true;
          const normalized = normalizeToolName(tool.name);
          return allowedToolIds.includes(tool.name) || allowedToolIds.includes(normalized);
        })
        .slice(0, 40);

      const toolMap = new Map(filteredTools.map((tool) => [tool.name, tool]));
      const toolsForModel = filteredTools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || `Execute ${tool.name} via MCP`,
          parameters: tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true },
        },
      }));

      const systemPrompt = [
        String(run.ai_agents?.system_prompt ?? 'You are an OpsAI enterprise agent.'),
        '',
        'Governance policy:',
        '- All tool calls are governed by RACI and risk policy checks.',
        '- If a high-risk action requires approval, explain that approval is pending.',
        '- Never fabricate tool execution results.',
        '',
        'Context from hybrid memory:',
        contextText || '(no context found)',
      ].join('\n');

      const userInput = JSON.stringify(run.input);
      const firstResponse = await this.openai.chat.completions.create({
        model: String(run.ai_agents?.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userInput },
        ],
        tools: toolsForModel as any,
        tool_choice: toolsForModel.length > 0 ? 'auto' : undefined,
      });

      const firstMessage = firstResponse.choices[0]?.message;
      let output = firstMessage?.content ?? '';
      const toolRunSummary: Array<Record<string, unknown>> = [];
      let totalPromptTokens = firstResponse.usage?.prompt_tokens ?? 0;
      let totalCompletionTokens = firstResponse.usage?.completion_tokens ?? 0;
      let totalTokens = firstResponse.usage?.total_tokens ?? 0;

      if (Array.isArray(firstMessage?.tool_calls) && firstMessage.tool_calls.length > 0) {
        const toolMessages: Array<{ role: 'tool'; tool_call_id: string; content: string }> = [];

        for (const toolCall of firstMessage.tool_calls) {
          if (toolCall.type !== 'function') continue;
          const toolName = String(toolCall.function?.name ?? '').trim();
          if (!toolName || !toolMap.has(toolName)) {
            throw new Error(`Unknown tool call rejected: ${toolName || '(empty)'}`);
          }

          const toolMeta = toolMap.get(toolName)!;
          const parsedArgs = safeParseToolArgs(toolCall.function?.arguments ?? '{}');
          const result = await mcpRouter.callTool({
            toolName,
            serverId: toolMeta.serverId,
            params: parsedArgs,
            tenantId: run.tenant_id,
            userId: run.requested_by,
          });

          toolRunSummary.push({
            toolName,
            serverId: toolMeta.serverId,
            ok: result.success,
            error: result.error ?? null,
          });

          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }

        const secondResponse = await this.openai.chat.completions.create({
          model: String(run.ai_agents?.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userInput },
            firstMessage as any,
            ...toolMessages,
          ],
        });

        output = secondResponse.choices[0]?.message?.content ?? output;

        totalPromptTokens += secondResponse.usage?.prompt_tokens ?? 0;
        totalCompletionTokens += secondResponse.usage?.completion_tokens ?? 0;
        totalTokens += secondResponse.usage?.total_tokens ?? 0;
        if (totalTokens > 0) {
          await supabase.getClient().from('usage_events').insert({
            tenant_id: run.tenant_id,
            metric_type: 'agent_tokens',
            quantity: totalTokens,
          });
        }
      } else if (totalTokens > 0) {
        await supabase.getClient().from('usage_events').insert({
          tenant_id: run.tenant_id,
          metric_type: 'agent_tokens',
          quantity: totalTokens,
        });
      }

      // 5. Update run with result
      await supabase.getClient()
        .from('agent_runs')
        .update({
          status: 'success',
          output: {
            content: output,
            tool_runs: toolRunSummary,
            context_sources: context.map((item) => ({
              source_kind: item.source_kind,
              source_id: item.source_id,
              similarity: item.similarity,
            })),
          },
          input_tokens: totalPromptTokens || null,
          output_tokens: totalCompletionTokens || null,
          completed_at: new Date().toISOString()
        })
        .eq('id', runId);

    } catch (err) {
      console.error(`Agent loop turn failed for run ${runId}:`, err);
      await supabase.getClient()
        .from('agent_runs')
        .update({
          status: 'failed',
          error: String(err),
          completed_at: new Date().toISOString()
        })
        .eq('id', runId);
    }
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0);
}

function safeParseToolArgs(raw: string): Record<string, unknown> {
  const text = String(raw ?? '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

function normalizeToolName(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

let instance: AgentLoop | null = null;
export function getAgentLoop(): AgentLoop {
  if (!instance) {
    instance = new AgentLoop();
  }
  return instance;
}
