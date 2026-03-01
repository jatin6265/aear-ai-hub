import { getSupabaseService } from '../../lib/supabase';

export type GovernancePolicyDecision = {
  allow: boolean;
  approval_required: boolean;
  reason: string;
  matched_rule: Record<string, unknown>;
  risk_level: string;
};

export type EvaluatePolicyInput = {
  tenantId: string;
  userId: string;
  resource: string;
  action: string;
  riskLevel: string;
  requiresWrite: boolean;
};

export async function evaluateActionPolicy(input: EvaluatePolicyInput): Promise<GovernancePolicyDecision> {
  const supabase = getSupabaseService();

  const { data, error } = await supabase.getClient().rpc('evaluate_action_policy_service', {
    p_tenant_id: input.tenantId,
    p_user_id: input.userId,
    p_resource: input.resource,
    p_action: input.action,
    p_risk_level: input.riskLevel,
    p_requires_write: input.requiresWrite,
  });

  if (error) {
    throw new Error(`evaluate_action_policy_service failed: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  const result = asRecord(row);
  return {
    allow: Boolean(result.allow),
    approval_required: Boolean(result.approval_required),
    reason: String(result.reason ?? 'No reason provided'),
    matched_rule: asRecord(result.matched_rule),
    risk_level: String(result.risk_level ?? input.riskLevel ?? 'medium').toLowerCase(),
  };
}

export async function createApprovalRequest(input: {
  tenantId: string;
  userId: string;
  action: string;
  resource: string;
  riskLevel: string;
  params: Record<string, unknown>;
  summary?: string;
  simulation?: Record<string, unknown>;
}): Promise<{ approvalId: string }> {
  const supabase = getSupabaseService();

  const { data, error } = await supabase.getClient().rpc('create_approval_request', {
    p_action: input.action,
    p_resource: input.resource,
    p_risk_level: input.riskLevel,
    p_params: input.params,
    p_simulation_preview: input.simulation ?? {},
    p_action_summary: input.summary ?? null,
    p_requested_by: input.userId,
    p_tenant_id: input.tenantId,
    p_expires_minutes: 24 * 60,
  });

  if (error) {
    throw new Error(`create_approval_request failed: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  const record = asRecord(row);
  const approvalId = String(record.id ?? '').trim();
  if (!approvalId) {
    throw new Error('create_approval_request returned empty id');
  }

  return { approvalId };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
