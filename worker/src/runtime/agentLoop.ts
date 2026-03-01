import { getSupabaseService } from '../lib/supabase';
import { routeToAgent } from '../services/router/multiAgent';
import { OpsAIAgent } from '../services/agent-core';
import { ApprovalRequiredError, GovernanceDeniedError } from '../services/governance/errors';

export class AgentLoop {
  /**
   * Executes a single turn of the agent loop through the OpsAI service layer.
   */
  async runTurn(runId: string): Promise<void> {
    const supabase = getSupabaseService();

    const { data: run, error: fetchError } = await supabase.getClient()
      .from('agent_runs')
      .select('*, ai_agents(*)')
      .eq('id', runId)
      .single();

    if (fetchError || !run) {
      throw new Error(`Run not found: ${runId}`);
    }

    try {
      const requestedBy = String(run.requested_by ?? '').trim();
      if (!requestedBy) {
        throw new Error('agent_runs.requested_by is required for governed execution');
      }

      const runInput = normalizeRunInput(run.input);
      const prompt = stringifyInput(runInput);

      const selectedAgent = await resolveAgentForRun({
        runAgent: run.ai_agents,
        runAgentId: String(run.agent_id ?? ''),
        tenantId: String(run.tenant_id),
        query: prompt,
      });

      if (!selectedAgent) {
        throw new Error(`Agent not found for run ${runId}`);
      }

      const opsAgent = new OpsAIAgent({
        tenantId: String(run.tenant_id),
        userId: requestedBy,
        runId,
        sessionId: run.session_id ? String(run.session_id) : undefined,
        agent: {
          id: selectedAgent.id,
          name: selectedAgent.name,
          domain: selectedAgent.domain,
          model: selectedAgent.model,
          systemPrompt: selectedAgent.systemPrompt,
          config: selectedAgent.config,
        },
      });

      const execution = await opsAgent.run(prompt);

      const { promptTokens, completionTokens, totalTokens } = execution.result.usage;
      // 40 tokens ≈ 1 credit (conservative; covers both input and output at blended rate).
      const totalCostCredits = totalTokens > 0 ? Math.max(1, Math.round(totalTokens / 40)) : 0;

      if (totalTokens > 0) {
        await supabase.getClient().from('usage_events').insert({
          tenant_id: run.tenant_id,
          metric_type: 'agent_tokens',
          quantity: totalTokens,
        });
      }

      // Persist each tool call as a first-class row for analytics / audit.
      // Runs concurrently with the agent_runs update; failure is non-fatal.
      const toolCallRows = execution.result.toolRuns.map((tr) => ({
        tenant_id: run.tenant_id,
        run_id: runId,
        turn_index: tr.turnIndex ?? 0,
        tool_name: tr.toolName,
        arguments: tr.arguments ?? {},
        result: tr.ok ? (tr.data !== undefined ? (tr.data as Record<string, unknown>) : null) : null,
        ok: tr.ok,
        error_message: tr.error ?? null,
      }));

      const [runUpdate] = await Promise.all([
        supabase.getClient()
          .from('agent_runs')
          .update({
            status: 'success',
            output: {
              content: execution.result.output,
              engine: execution.engine,
              tool_runs: execution.result.toolRuns,
              context: {
                semantic_hits: execution.context.semantic.length,
                structured_hits: execution.context.structured.length,
                timeline_hits: execution.context.timeline.length,
                user_role: execution.context.userRole,
              },
            },
            input_tokens: promptTokens,
            output_tokens: completionTokens,
            total_cost_credits: totalCostCredits,
            completed_at: new Date().toISOString(),
          })
          .eq('id', runId),
        toolCallRows.length > 0
          ? (async () => { try { await supabase.getClient().from('agent_tool_calls').insert(toolCallRows); } catch { /* non-fatal */ } })()
          : Promise.resolve(),
      ]);

      if (runUpdate.error) {
        throw new Error(`Failed to update agent_run ${runId}: ${runUpdate.error.message}`);
      }
    } catch (error) {
      await handleRunFailure(runId, error);
    }
  }
}

async function handleRunFailure(runId: string, error: unknown): Promise<void> {
  const supabase = getSupabaseService();

  if (error instanceof ApprovalRequiredError) {
    const approvalOutput = {
      content: 'Execution paused pending approval.',
      approvalRequired: true,
      approvalId: error.approvalId,
      riskLevel: error.riskLevel,
      simulation: error.simulation,
    };

    const waitingUpdate = await supabase.getClient()
      .from('agent_runs')
      .update({
        status: 'waiting_approval',
        output: approvalOutput,
        error: null,
        completed_at: null,
      })
      .eq('id', runId);

    // Backward compatibility if waiting_approval status is not available yet.
    if (waitingUpdate.error) {
      await supabase.getClient()
        .from('agent_runs')
        .update({
          status: 'failed',
          output: approvalOutput,
          error: `approval_required:${error.approvalId}`,
          completed_at: new Date().toISOString(),
        })
        .eq('id', runId);
    }
    return;
  }

  const errorMessage = error instanceof GovernanceDeniedError
    ? error.message
    : (error instanceof Error ? error.message : String(error));

  console.error(`Agent loop turn failed for run ${runId}:`, error);
  await supabase.getClient()
    .from('agent_runs')
    .update({
      status: 'failed',
      error: errorMessage,
      completed_at: new Date().toISOString(),
    })
    .eq('id', runId);
}

async function resolveAgentForRun(input: {
  runAgent: unknown;
  runAgentId: string;
  tenantId: string;
  query: string;
}): Promise<{
  id: string;
  name: string;
  domain: string;
  model: string;
  systemPrompt: string;
  config: Record<string, unknown>;
} | null> {
  const direct = normalizeAgentRow(input.runAgent, input.runAgentId);
  if (direct) return direct;

  const routed = await routeToAgent(input.query, input.tenantId);
  if (!routed) return null;

  return {
    id: routed.id,
    name: routed.name,
    domain: routed.domain,
    model: String((routed.config.model as string | undefined) ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'),
    systemPrompt: String((routed.config.system_prompt as string | undefined) ?? 'You are an OpsAI enterprise agent.'),
    config: routed.config,
  };
}

function normalizeAgentRow(
  row: unknown,
  fallbackId: string
): {
  id: string;
  name: string;
  domain: string;
  model: string;
  systemPrompt: string;
  config: Record<string, unknown>;
} | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const config = asRecord(record.config);

  return {
    id: String(record.id ?? fallbackId),
    name: String(record.name ?? 'OpsAI Agent'),
    domain: String(record.domain ?? 'general'),
    model: String(config.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'),
    systemPrompt: String(config.system_prompt ?? 'You are an OpsAI enterprise agent.'),
    config,
  };
}

function normalizeRunInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { message: String(value ?? '') };
}

function stringifyInput(input: Record<string, unknown>): string {
  const message = String(input.message ?? input.prompt ?? '').trim();
  if (message.length > 0) return message;
  return JSON.stringify(input);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

let instance: AgentLoop | null = null;
export function getAgentLoop(): AgentLoop {
  if (!instance) {
    instance = new AgentLoop();
  }
  return instance;
}
