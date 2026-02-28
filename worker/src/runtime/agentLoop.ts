import { getSupabaseService } from '../lib/supabase';
import { getRetriever } from '../pipeline/retriever';
import OpenAI from 'openai';

import { getGovernanceMiddleware } from '../governance/governanceMiddleware';

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

      // 4. Generate response via OpenAI
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: `${run.ai_agents.system_prompt}\n\nContext from memory:\n${contextText}` },
          { role: 'user', content: JSON.stringify(run.input) }
        ],
      });

      const output = response.choices[0].message.content;

      // 5. Update run with result
      await supabase.getClient()
        .from('agent_runs')
        .update({
          status: 'success',
          output: { content: output },
          input_tokens: response.usage?.prompt_tokens,
          output_tokens: response.usage?.completion_tokens,
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

let instance: AgentLoop | null = null;
export function getAgentLoop(): AgentLoop {
  if (!instance) {
    instance = new AgentLoop();
  }
  return instance;
}
