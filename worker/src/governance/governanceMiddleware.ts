import { getSupabaseService } from '../lib/supabase';

export type PolicyDecision = {
  allowed: boolean;
  reason?: string;
  requires_approval: boolean;
  risk_level?: string;
};

export class GovernanceMiddleware {
  /**
   * Checks if an action is allowed based on RACI and risk policies.
   * Uses service-role compatible RPC with explicit tenant/user scope.
   */
  async evaluateAction(
    tenantId: string,
    userId: string,
    toolCode: string,
    params: Record<string, unknown>
  ): Promise<PolicyDecision> {
    const supabase = getSupabaseService();

    const resource = normalizeResource(toolCode);
    const action = inferAction(toolCode, Boolean(params?.is_write_action));
    const riskLevel = normalizeRiskLevel(params?.risk_level);
    const requiresWrite = Boolean(params?.is_write_action) || action !== 'read';

    const { data, error } = await supabase.getClient().rpc('evaluate_action_policy_service', {
      p_tenant_id: tenantId,
      p_user_id: userId,
      p_resource: resource,
      p_action: action,
      p_risk_level: riskLevel,
      p_requires_write: requiresWrite,
    });

    if (error) {
      console.error('Governance check failed:', error);
      return { allowed: false, reason: 'Governance engine unavailable', requires_approval: false, risk_level: riskLevel };
    }

    const row = Array.isArray(data) ? data[0] : data;
    const record = asRecord(row);
    return {
      allowed: Boolean(record.allow),
      requires_approval: Boolean(record.approval_required),
      reason: String(record.reason ?? ''),
      risk_level: String(record.risk_level ?? riskLevel),
    };
  }
}

function normalizeResource(toolCode: string): string {
  return String(toolCode || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_') || 'agent_execution';
}

function inferAction(toolCode: string, requiresWrite: boolean): string {
  if (!requiresWrite) return 'read';
  const value = String(toolCode || '').toLowerCase();
  if (value.includes('delete') || value.includes('remove') || value.includes('drop')) return 'delete';
  if (value.includes('create') || value.includes('insert') || value.includes('add')) return 'create';
  if (value.includes('update') || value.includes('patch') || value.includes('modify')) return 'update';
  return 'execute';
}

function normalizeRiskLevel(value: unknown): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'critical') {
    return normalized;
  }
  return 'medium';
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

let instance: GovernanceMiddleware | null = null;
export function getGovernanceMiddleware(): GovernanceMiddleware {
  if (!instance) {
    instance = new GovernanceMiddleware();
  }
  return instance;
}
