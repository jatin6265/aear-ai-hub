import { getSupabaseService } from '../../lib/supabase';
import { ApprovalRequiredError, GovernanceDeniedError } from './errors';
import { createApprovalRequest, evaluateActionPolicy } from './policy';

export type GovernanceWrappedExecuteInput = {
  tenantId: string;
  userId: string;
  toolName: string;
  resource: string;
  action: string;
  params: Record<string, unknown>;
  riskLevel: string;
  requiresWrite: boolean;
  context: {
    runId?: string;
    agentId?: string;
    sessionId?: string;
  };
  execute: () => Promise<unknown>;
};

export async function governanceWrappedExecute(input: GovernanceWrappedExecuteInput): Promise<unknown> {
  // Fast path: check for a pre-approved execution token from a prior approval decision.
  // This fires on the re-run of a paused agent run. If a valid token exists for this
  // resource+action, consume it atomically and bypass the approval_required path so
  // we don't create a second approval request in an infinite loop.
  const supabase = getSupabaseService();
  const { data: tokenConsumed } = await supabase.getClient().rpc('consume_approval_token_for_resource', {
    p_tenant_id: input.tenantId,
    p_resource: input.resource,
    p_action: input.action,
  });

  if (tokenConsumed === true) {
    const startedAt = Date.now();
    try {
      const result = await input.execute();
      await insertAuditLog({
        tenantId: input.tenantId,
        userId: input.userId,
        actionType: 'tool.execute',
        resourceType: 'tool',
        resourceId: input.toolName,
        outcome: 'success_via_approval_token',
        payload: {
          tool: input.toolName,
          resource: input.resource,
          action: input.action,
          durationMs: Date.now() - startedAt,
          context: input.context,
          note: 'Executed under pre-approved execution token',
        },
        result,
      });
      return result;
    } catch (error) {
      await insertAuditLog({
        tenantId: input.tenantId,
        userId: input.userId,
        actionType: 'tool.execute',
        resourceType: 'tool',
        resourceId: input.toolName,
        outcome: 'error',
        payload: {
          tool: input.toolName,
          resource: input.resource,
          action: input.action,
          durationMs: Date.now() - startedAt,
          context: input.context,
          note: 'Executed under pre-approved token but threw',
        },
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  const decision = await evaluateActionPolicy({
    tenantId: input.tenantId,
    userId: input.userId,
    resource: input.resource,
    action: input.action,
    riskLevel: input.riskLevel,
    requiresWrite: input.requiresWrite,
  });

  if (!decision.allow) {
    await insertAuditLog({
      tenantId: input.tenantId,
      userId: input.userId,
      actionType: 'tool.governance.block',
      resourceType: 'tool',
      resourceId: input.toolName,
      outcome: 'blocked',
      payload: {
        tool: input.toolName,
        resource: input.resource,
        action: input.action,
        reason: decision.reason,
        context: input.context,
      },
    });
    throw new GovernanceDeniedError(decision.reason);
  }

  if (decision.approval_required) {
    const simulation = buildSimulationPreview(input.params);
    const { approvalId } = await createApprovalRequest({
      tenantId: input.tenantId,
      userId: input.userId,
      action: input.action,
      resource: input.resource,
      riskLevel: decision.risk_level,
      params: {
        ...input.params,
        toolName: input.toolName,
        context: input.context,
      },
      summary: `Tool ${input.toolName} requires approval`,
      simulation,
    });

    await insertAuditLog({
      tenantId: input.tenantId,
      userId: input.userId,
      actionType: 'tool.governance.pending_approval',
      resourceType: 'tool',
      resourceId: input.toolName,
      outcome: 'pending_approval',
      payload: {
        tool: input.toolName,
        approvalId,
        riskLevel: decision.risk_level,
        context: input.context,
      },
    });

    throw new ApprovalRequiredError(approvalId, decision.risk_level, simulation);
  }

  const startedAt = Date.now();
  try {
    const result = await input.execute();

    await insertAuditLog({
      tenantId: input.tenantId,
      userId: input.userId,
      actionType: 'tool.execute',
      resourceType: 'tool',
      resourceId: input.toolName,
      outcome: 'success',
      payload: {
        tool: input.toolName,
        resource: input.resource,
        action: input.action,
        durationMs: Date.now() - startedAt,
        context: input.context,
      },
      result,
    });

    return result;
  } catch (error) {
    await insertAuditLog({
      tenantId: input.tenantId,
      userId: input.userId,
      actionType: 'tool.execute',
      resourceType: 'tool',
      resourceId: input.toolName,
      outcome: 'error',
      payload: {
        tool: input.toolName,
        resource: input.resource,
        action: input.action,
        durationMs: Date.now() - startedAt,
        context: input.context,
      },
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function buildSimulationPreview(params: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(params).slice(0, 10);
  return {
    impactSummary: 'Execution halted pending approval.',
    reversible: false,
    recordCount: 0,
    previewRows: entries.map(([field, value]) => ({
      field,
      before: 'unknown',
      after: JSON.stringify(value),
    })),
  };
}

async function insertAuditLog(input: {
  tenantId: string;
  userId: string;
  actionType: string;
  resourceType: string;
  resourceId: string;
  outcome: string;
  payload: Record<string, unknown>;
  result?: unknown;
  errorMessage?: string;
}): Promise<void> {
  const supabase = getSupabaseService();
  await supabase.getClient().from('audit_logs').insert({
    tenant_id: input.tenantId,
    user_id: input.userId,
    action: input.actionType,
    resource: input.resourceId || input.resourceType,
    risk_level: String(input.payload.riskLevel ?? 'medium').toLowerCase(),
    status: input.outcome,
    details: {
      resourceType: input.resourceType,
      payload: input.payload,
      result: input.result ?? null,
      error: input.errorMessage ?? null,
    },
  });
}
