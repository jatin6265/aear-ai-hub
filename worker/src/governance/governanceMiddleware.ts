import { getSupabaseService } from '../lib/supabase';

export type PolicyDecision = {
  allowed: boolean;
  reason?: string;
  requires_approval: boolean;
};

export class GovernanceMiddleware {
  /**
   * Checks if an action is allowed based on RACI and Risk policies.
   */
  async evaluateAction(
    tenantId: string,
    userId: string,
    toolCode: string,
    params: Record<string, unknown>
  ): Promise<PolicyDecision> {
    const supabase = getSupabaseService();

    // Call evaluate_action_policy RPC
    const { data, error } = await supabase.getClient().rpc('evaluate_action_policy', {
      p_tenant_id: tenantId,
      p_user_id: userId,
      p_tool_code: toolCode,
      p_payload: params
    });

    if (error) {
      console.error('Governance check failed:', error);
      return { allowed: false, reason: 'Governance engine unavailable', requires_approval: false };
    }

    const decision = data as PolicyDecision;
    return decision;
  }
}

let instance: GovernanceMiddleware | null = null;
export function getGovernanceMiddleware(): GovernanceMiddleware {
  if (!instance) {
    instance = new GovernanceMiddleware();
  }
  return instance;
}
