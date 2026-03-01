import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AgentEngine, AgentEngineRunInput, AgentEngineRunOutput, RuntimeTool, ToolRunResult } from './types';

/**
 * Experimental OpenClaw bridge.
 *
 * We run OpenClaw in RPC/JSON mode and parse response lines.
 * If OpenClaw cannot be reached, caller decides whether to fail hard (strict) or fallback.
 */
export class OpenClawRpcEngine implements AgentEngine {
  readonly name = 'openclaw-rpc';

  async run(input: AgentEngineRunInput): Promise<AgentEngineRunOutput> {
    const command = buildCommand();
    const toolMap = new Map(input.tools.map((tool) => [tool.name, tool]));
    const toolRuns: ToolRunResult[] = [];
    const history: Array<{
      tool: string;
      arguments: Record<string, unknown>;
      ok: boolean;
      data?: unknown;
      error?: string;
    }> = [];

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let lastAssistantText = '';

    for (let turn = 0; turn < Math.max(1, input.maxTurns); turn += 1) {
      const plannerPrompt = buildPlannerPrompt({
        userInput: input.input,
        tools: input.tools,
        toolHistory: history,
        turn,
      });

      const turnResult = await invokeOpenClawTurn({
        command,
        model: input.model,
        systemPrompt: input.systemPrompt,
        prompt: plannerPrompt,
      });

      lastAssistantText = turnResult.text.trim();
      promptTokens += turnResult.usage.promptTokens;
      completionTokens += turnResult.usage.completionTokens;
      totalTokens += turnResult.usage.totalTokens;

      const decision = parsePlannerDecision(lastAssistantText);
      if (decision.type === 'final') {
        return {
          output: decision.answer || lastAssistantText || 'Completed.',
          toolRuns,
          usage: {
            promptTokens,
            completionTokens,
            totalTokens,
          },
        };
      }

      if (!Array.isArray(decision.tool_calls) || decision.tool_calls.length === 0) {
        return {
          output: lastAssistantText || 'Completed.',
          toolRuns,
          usage: {
            promptTokens,
            completionTokens,
            totalTokens,
          },
        };
      }

      for (const call of decision.tool_calls) {
        const toolName = String(call.name ?? '').trim();
        const args = asRecord(call.arguments);
        const tool = toolMap.get(toolName);

        if (!tool) {
          const unknownError = `Unknown tool call rejected: ${toolName || '(empty)'}`;
          toolRuns.push({
            toolName: toolName || '(unknown)',
            ok: false,
            error: unknownError,
          });
          history.push({
            tool: toolName || '(unknown)',
            arguments: args,
            ok: false,
            error: unknownError,
          });
          continue;
        }

        try {
          const data = await tool.execute(args);
          toolRuns.push({
            toolName,
            ok: true,
            data,
          });
          history.push({
            tool: toolName,
            arguments: args,
            ok: true,
            data,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          toolRuns.push({
            toolName,
            ok: false,
            error: message,
          });
          history.push({
            tool: toolName,
            arguments: args,
            ok: false,
            error: message,
          });
        }
      }
    }

    return {
      output: lastAssistantText || 'Max turns reached.',
      toolRuns,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
      },
    };
  }
}

function buildCommand(): { bin: string; args: string[] } {
  const custom = String(process.env.OPENCLAW_RPC_COMMAND ?? '').trim();
  if (custom.length > 0) {
    const parts = custom.split(/\s+/g).filter((part) => part.length > 0);
    return {
      bin: parts[0],
      args: parts.slice(1),
    };
  }

  return {
    bin: 'openclaw',
    args: ['agent', '--mode', 'rpc', '--json'],
  };
}

async function runCommand(bin: string, args: string[], stdin: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`OpenClaw command failed (${code}): ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function invokeOpenClawTurn(input: {
  command: { bin: string; args: string[] };
  model: string;
  systemPrompt: string;
  prompt: string;
}): Promise<{
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}> {
  const methods = resolveRpcMethods();
  let lastError: Error | null = null;

  for (const method of methods) {
    try {
      const payload = buildRpcPayload({
        method,
        model: input.model,
        systemPrompt: input.systemPrompt,
        prompt: input.prompt,
      });
      const rawOutput = await runCommand(
        input.command.bin,
        input.command.args,
        `${JSON.stringify(payload)}\n`
      );
      const parsed = parseJsonLines(rawOutput);

      const maybeError = extractRpcError(parsed);
      if (maybeError) {
        lastError = new Error(`OpenClaw RPC ${method} error: ${maybeError}`);
        continue;
      }

      return {
        text: extractFinalText(parsed) || rawOutput.trim(),
        usage: extractUsage(parsed),
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (lastError) throw lastError;
  throw new Error('OpenClaw RPC invocation failed');
}

function resolveRpcMethods(): string[] {
  const configured = String(process.env.OPENCLAW_RPC_METHODS ?? '').trim();
  if (configured.length > 0) {
    return configured
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return ['agent.run', 'agent'];
}

function buildRpcPayload(input: {
  method: string;
  model: string;
  systemPrompt: string;
  prompt: string;
}): Record<string, unknown> {
  if (input.method === 'agent') {
    return {
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'agent',
      params: {
        message: input.prompt,
        idempotencyKey: randomUUID(),
        deliver: false,
        timeout: Number(process.env.OPENCLAW_TURN_TIMEOUT_MS ?? 120000),
        extraSystemPrompt: input.systemPrompt,
      },
    };
  }

  return {
    jsonrpc: '2.0',
    id: randomUUID(),
    method: input.method,
    params: {
      model: input.model,
      input: input.prompt,
      system_prompt: input.systemPrompt,
      max_turns: 1,
    },
  };
}

function buildPlannerPrompt(input: {
  userInput: string;
  tools: RuntimeTool[];
  toolHistory: Array<{
    tool: string;
    arguments: Record<string, unknown>;
    ok: boolean;
    data?: unknown;
    error?: string;
  }>;
  turn: number;
}): string {
  const toolCatalog = input.tools.length === 0
    ? '- no tools available'
    : input.tools
      .map((tool) => {
        const schema = JSON.stringify(tool.parameters);
        return `- ${tool.name}: ${tool.description}\n  schema: ${schema}`;
      })
      .join('\n');

  const history = input.toolHistory.length === 0
    ? '- no tool calls yet'
    : input.toolHistory
      .map((entry) => JSON.stringify(entry))
      .join('\n');

  return [
    'You are the OpenClaw reasoning core for OpsAI.',
    'Decide the next step and return STRICT JSON only (no markdown).',
    '',
    'Allowed response formats:',
    '{"type":"tool_calls","tool_calls":[{"name":"tool_name","arguments":{},"reason":"why"}]}',
    '{"type":"final","answer":"final answer for the user"}',
    '',
    'Rules:',
    '- Use only listed tool names.',
    '- If tools fail, either retry with different arguments or return final with explanation.',
    '- Never invent tool outputs.',
    '',
    `Turn: ${input.turn + 1}`,
    `User request: ${input.userInput}`,
    '',
    '# Available Tools',
    toolCatalog,
    '',
    '# Tool Call History',
    history,
  ].join('\n');
}

function parsePlannerDecision(text: string): {
  type: 'tool_calls' | 'final';
  tool_calls?: Array<{ name?: string; arguments?: Record<string, unknown>; reason?: string }>;
  answer?: string;
} {
  const normalized = extractFirstJsonObject(text);
  if (!normalized) {
    return { type: 'final', answer: text.trim() };
  }

  const parsed = safeParse(normalized);
  const record = asRecord(parsed);
  const type = String(record.type ?? '').trim().toLowerCase();
  if (type === 'tool_calls') {
    const rawCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    const toolCalls = rawCalls.map((item) => {
      const call = asRecord(item);
      return {
        name: String(call.name ?? '').trim(),
        arguments: asRecord(call.arguments),
        reason: String(call.reason ?? '').trim(),
      };
    }).filter((item) => item.name.length > 0);
    return { type: 'tool_calls', tool_calls: toolCalls };
  }

  return {
    type: 'final',
    answer: String(record.answer ?? text).trim(),
  };
}

function extractFirstJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    const fenced = fenceMatch[1].trim();
    if (fenced.startsWith('{') && fenced.endsWith('}')) return fenced;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function extractRpcError(rows: Array<Record<string, unknown>>): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const error = asRecord(row.error);
    if (Object.keys(error).length === 0) continue;
    const message = String(error.message ?? '').trim();
    const code = String(error.code ?? '').trim();
    if (message || code) {
      return `${code}${code && message ? ': ' : ''}${message}`.trim();
    }
  }
  return null;
}

function parseJsonLines(text: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rows.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }
  return rows;
}

function extractFinalText(rows: Array<Record<string, unknown>>): string {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];

    const result = asRecord(row.result);
    if (typeof result.output === 'string' && result.output.trim().length > 0) {
      return result.output;
    }

    const message = String(row.message ?? result.message ?? '').trim();
    if (message.length > 0) {
      return message;
    }

    const content = String(row.content ?? result.content ?? '').trim();
    if (content.length > 0) {
      return content;
    }
  }

  return '';
}

function extractUsage(rows: Array<Record<string, unknown>>): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const usage = asRecord((asRecord(row.result)).usage ?? row.usage);
    const prompt = Number(usage.prompt_tokens ?? usage.promptTokens ?? 0);
    const completion = Number(usage.completion_tokens ?? usage.completionTokens ?? 0);
    const total = Number(usage.total_tokens ?? usage.totalTokens ?? prompt + completion);
    if (Number.isFinite(total) && total > 0) {
      return {
        promptTokens: Number.isFinite(prompt) ? prompt : 0,
        completionTokens: Number.isFinite(completion) ? completion : 0,
        totalTokens: total,
      };
    }
  }

  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
