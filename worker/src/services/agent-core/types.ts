export type RuntimeTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
  metadata?: Record<string, unknown>;
};

export type ToolRunResult = {
  toolName: string;
  ok: boolean;
  /** Turn index within the agent loop (0-based). Used for ordered persistence. */
  turnIndex?: number;
  /** Arguments passed to the tool. Used for audit trail persistence. */
  arguments?: Record<string, unknown>;
  data?: unknown;
  error?: string;
};

export type AgentEngineRunInput = {
  model: string;
  input: string;
  systemPrompt: string;
  tools: RuntimeTool[];
  maxTurns: number;
};

export type AgentEngineRunOutput = {
  output: string;
  toolRuns: ToolRunResult[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

export interface AgentEngine {
  readonly name: string;
  run(input: AgentEngineRunInput): Promise<AgentEngineRunOutput>;
}
