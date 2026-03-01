import OpenAI from 'openai';
import type { AgentEngine, AgentEngineRunInput, AgentEngineRunOutput, RuntimeTool, ToolRunResult } from './types';

const OPENAI_MAX_RETRIES = 3;
const OPENAI_RETRY_BASE_MS = 1_000;

/** Retries transient OpenAI errors (429 rate-limit, 5xx server errors) with exponential backoff. */
async function withOpenAIRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < OPENAI_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = (err as { status?: number })?.status;
      const isRetryable = status === 429 || (status != null && status >= 500 && status <= 599);
      if (!isRetryable || attempt === OPENAI_MAX_RETRIES - 1) throw err;
      const delay = OPENAI_RETRY_BASE_MS * Math.pow(2, attempt);
      console.warn(`[openai] Transient error (status=${status}), retrying in ${delay}ms (attempt ${attempt + 1}/${OPENAI_MAX_RETRIES})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export class OpenAIEngine implements AgentEngine {
  readonly name = 'openai';
  private readonly openai: OpenAI;

  constructor(apiKey: string) {
    this.openai = new OpenAI({ apiKey });
  }

  async run(input: AgentEngineRunInput): Promise<AgentEngineRunOutput> {
    const toolsForModel = input.tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));

    const toolMap = new Map(input.tools.map((tool) => [tool.name, tool]));
    const toolRuns: ToolRunResult[] = [];

    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.input },
    ];

    let output = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    for (let turn = 0; turn < Math.max(1, input.maxTurns); turn += 1) {
      const response = await withOpenAIRetry(() => this.openai.chat.completions.create({
        model: input.model,
        messages: messages as any,
        tools: toolsForModel.length > 0 ? (toolsForModel as any) : undefined,
        tool_choice: toolsForModel.length > 0 ? 'auto' : undefined,
      }));

      promptTokens += response.usage?.prompt_tokens ?? 0;
      completionTokens += response.usage?.completion_tokens ?? 0;
      totalTokens += response.usage?.total_tokens ?? 0;

      const message = response.choices[0]?.message;
      if (!message) break;

      messages.push(message as any);

      if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
        output = String(message.content ?? '').trim();
        break;
      }

      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== 'function') continue;
        const toolName = String(toolCall.function?.name ?? '').trim();
        const tool = toolMap.get(toolName);

        // Unknown tool: return error to LLM so it can recover (not run-killing throw).
        if (!tool) {
          const errMsg = `Unknown tool "${toolName || '(empty)'}". Use only the provided tool names.`;
          toolRuns.push({ toolName: toolName || '(unknown)', ok: false, turnIndex: turn, arguments: {}, error: errMsg });
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ success: false, error: errMsg }) });
          continue;
        }

        const args = parseArgs(toolCall.function?.arguments ?? '{}');

        // Validate required fields against the tool's JSON Schema before executing.
        const validationError = validateRequiredArgs(tool, args);
        if (validationError) {
          toolRuns.push({ toolName, ok: false, turnIndex: turn, arguments: args, error: validationError });
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ success: false, error: validationError }) });
          continue;
        }

        const toolResult = await executeTool(tool, args);
        toolRuns.push({ ...toolResult.summary, turnIndex: turn, arguments: args });

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult.payload),
        });
      }
    }

    if (!output && toolRuns.length > 0) {
      output = 'Tool execution completed.';
    }

    return {
      output,
      toolRuns,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
      },
    };
  }
}

async function executeTool(
  tool: RuntimeTool,
  params: Record<string, unknown>
): Promise<{ payload: unknown; summary: ToolRunResult }> {
  try {
    const data = await tool.execute(params);
    return {
      payload: { success: true, data },
      summary: {
        toolName: tool.name,
        ok: true,
        data,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      payload: { success: false, error: message },
      summary: {
        toolName: tool.name,
        ok: false,
        error: message,
      },
    };
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Validates that all required fields declared in the tool's JSON Schema are present.
 * Returns a human-readable error string, or null if valid.
 */
function validateRequiredArgs(tool: RuntimeTool, args: Record<string, unknown>): string | null {
  const schema = tool.parameters;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const required = (schema as Record<string, unknown>).required;
  if (!Array.isArray(required) || required.length === 0) return null;
  const missing = required
    .map((field) => String(field ?? '').trim())
    .filter((field) => field.length > 0 && !(field in args));
  if (missing.length === 0) return null;
  return `Missing required arguments for tool "${tool.name}": ${missing.join(', ')}`;
}
