import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

type Operation = "run" | "cancel" | "request_approval" | "approve_execute" | "reject" | "undo" | "retry";
type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type RaciRole = "Responsible" | "Consulted" | "Accountable";

type ActionProposalPreviewRow = {
  field: string;
  before: string;
  after: string;
};

type ActionProposalPayload = {
  runId: string;
  riskLevel: RiskLevel;
  summary: string;
  raci: {
    userRole: string;
    role: RaciRole;
    roleStatus: string;
  };
  approval: {
    required: boolean;
    status: "none" | "pending" | "approved" | "denied";
    requestId: string | null;
    approverName: string | null;
    requiredApprovals?: number;
    approvedCount?: number;
    rejectedCount?: number;
    pendingApprovals?: number;
  };
  simulation: {
    impactSummary: string;
    reversible: boolean;
    recordCount: number;
    previewRows: ActionProposalPreviewRow[];
  };
  state: {
    status: "proposed" | "blocked" | "executed" | "failed" | "cancelled";
    successMessage: string | null;
    errorMessage: string | null;
    undoExpiresAt: string | null;
    revertedAt: string | null;
  };
};

type ActionRunRow = {
  id: string;
  tenant_id: string;
  requested_by: string | null;
  status: string;
  action_summary: string | null;
  action_payload: Record<string, unknown> | null;
  simulation_preview: Record<string, unknown> | null;
  error: string | null;
  approval_request_id: string | null;
  executed_at: string | null;
  undo_expires_at: string | null;
  reverted_at: string | null;
};

type ApprovalRow = {
  id: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  required_approvals?: number | null;
  approved_count?: number | null;
  rejected_count?: number | null;
  pending_approvals?: number | null;
};

type AuthedSupabase = Extract<
  Awaited<ReturnType<typeof getAuthedClient>>,
  { ok: true }
>["supabase"];

function mapRaciTypeToRole(value: unknown): RaciRole {
  const raciType = String(value ?? "").trim().toUpperCase();
  if (raciType === "A") return "Accountable";
  if (raciType === "R") return "Responsible";
  return "Consulted";
}

function normalizeRaciRole(value: unknown): RaciRole {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "accountable") return "Accountable";
  if (normalized === "responsible") return "Responsible";
  return "Consulted";
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim().toLowerCase()).filter((item) => item.length > 0);
}

function normalizeRisk(value: unknown): RiskLevel {
  const risk = String(value ?? "").toUpperCase();
  if (risk === "LOW" || risk === "MEDIUM" || risk === "HIGH" || risk === "CRITICAL") return risk;
  return "MEDIUM";
}

function mapApprovalStatus(value: string | null | undefined): "none" | "pending" | "approved" | "denied" {
  const status = String(value ?? "").toLowerCase();
  if (status === "pending" || status === "approved" || status === "denied") return status;
  if (status === "rejected") return "denied";
  return "none";
}

function mapStateStatus(value: string): ActionProposalPayload["state"]["status"] {
  const status = value.toLowerCase();
  if (status === "executed") return "executed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "blocked" || status === "approved") return "blocked";
  return "proposed";
}

function toPreviewRows(value: unknown): ActionProposalPreviewRow[] {
  if (!Array.isArray(value)) return [];
  const rows: ActionProposalPreviewRow[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    rows.push({
      field: String(row.field ?? "value"),
      before: String(row.before ?? "current"),
      after: String(row.after ?? "updated"),
    });
    if (rows.length >= 5) break;
  }
  return rows;
}

function buildProposal(args: {
  run: ActionRunRow;
  approval: ApprovalRow | null;
  raciRole: RaciRole;
  userRoleLabel: string;
  approverName?: string | null;
}): ActionProposalPayload {
  const payload = args.run.action_payload ?? {};
  const payloadSimulation =
    payload.simulation && typeof payload.simulation === "object"
      ? (payload.simulation as Record<string, unknown>)
      : {};
  const payloadApproval =
    payload.approval && typeof payload.approval === "object"
      ? (payload.approval as Record<string, unknown>)
      : {};
  const runSimulation = args.run.simulation_preview ?? {};

  const payloadPreviewRows = toPreviewRows(payloadSimulation.previewRows);
  const runPreviewRows = toPreviewRows(runSimulation.previewRows);
  const previewRows =
    payloadPreviewRows.length > 0
      ? payloadPreviewRows
      : runPreviewRows.length > 0
        ? runPreviewRows
        : [
            {
              field: "value",
              before: "current",
              after: "updated",
            },
          ];

  const rawCount = Number(payloadSimulation.recordCount ?? runSimulation.recordCount ?? 1);
  const recordCount = Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 1;

  const riskLevel = normalizeRisk(payload.riskLevel);
  const raciRole = normalizeRaciRole(args.raciRole);
  const approvalStatus = mapApprovalStatus(args.approval?.status);
  const requiredApprovalsRaw = Number(args.approval?.required_approvals ?? (payloadApproval.requiredApprovals as number | undefined) ?? 1);
  const approvedCountRaw = Number(args.approval?.approved_count ?? (payloadApproval.approvedCount as number | undefined) ?? 0);
  const rejectedCountRaw = Number(args.approval?.rejected_count ?? (payloadApproval.rejectedCount as number | undefined) ?? 0);
  const pendingApprovalsRaw = Number(args.approval?.pending_approvals ?? (payloadApproval.pendingApprovals as number | undefined) ?? 0);
  const requiredApprovals = Number.isFinite(requiredApprovalsRaw) ? Math.max(1, Math.floor(requiredApprovalsRaw)) : 1;
  const approvedCount = Number.isFinite(approvedCountRaw) ? Math.max(0, Math.floor(approvedCountRaw)) : 0;
  const rejectedCount = Number.isFinite(rejectedCountRaw) ? Math.max(0, Math.floor(rejectedCountRaw)) : 0;
  const pendingApprovals = Number.isFinite(pendingApprovalsRaw)
    ? Math.max(0, Math.floor(pendingApprovalsRaw))
    : Math.max(requiredApprovals - approvedCount, 0);
  const approvalRequired =
    approvalStatus !== "none" ||
    riskLevel === "CRITICAL" ||
    raciRole === "Consulted" ||
    Boolean(payloadApproval.required);
  const stateStatus = mapStateStatus(args.run.status);

  let successMessage: string | null = null;
  if (stateStatus === "executed") {
    successMessage = `Action completed. ${recordCount} record${recordCount === 1 ? "" : "s"} updated.`;
  } else if (args.run.reverted_at) {
    successMessage = "Action rollback completed.";
  }

  return {
    runId: args.run.id,
    riskLevel,
    summary: String(payload.summary ?? args.run.action_summary ?? "Proposed action"),
    raci: {
      userRole: args.userRoleLabel,
      role: raciRole,
      roleStatus:
        raciRole === "Responsible"
          ? "Responsible ✓"
          : raciRole === "Accountable"
            ? "Accountable"
            : "Consulted - cannot execute",
    },
    approval: {
      required: approvalRequired,
      status: approvalStatus,
      requestId: args.approval?.id ?? args.run.approval_request_id,
      approverName: args.approverName ?? (payloadApproval.approverName ? String(payloadApproval.approverName) : null),
      requiredApprovals,
      approvedCount,
      rejectedCount,
      pendingApprovals,
    },
    simulation: {
      impactSummary: String(payloadSimulation.impactSummary ?? runSimulation.impactSummary ?? "1 record will be updated. Reversible: Yes."),
      reversible: Boolean(payloadSimulation.reversible ?? runSimulation.reversible ?? true),
      recordCount,
      previewRows: previewRows.length > 0 ? previewRows : [{ field: "value", before: "current", after: "updated" }],
    },
    state: {
      status: stateStatus,
      successMessage,
      errorMessage: stateStatus === "failed" ? args.run.error ?? "Action failed." : null,
      undoExpiresAt: args.run.undo_expires_at,
      revertedAt: args.run.reverted_at,
    },
  };
}

async function loadActionContext(supabase: AuthedSupabase, actionRunId: string) {
  const { data: runRow, error: runError } = await supabase
    .from("agent_action_runs")
    .select(
      "id, tenant_id, requested_by, status, action_summary, action_payload, simulation_preview, error, approval_request_id, executed_at, undo_expires_at, reverted_at",
    )
    .eq("id", actionRunId)
    .single();
  if (runError || !runRow) {
    throw new Error(runError?.message ?? "Action run not found");
  }

  const actionRun = runRow as unknown as ActionRunRow;
  let approval: ApprovalRow | null = null;
  if (actionRun.approval_request_id) {
    const { data: approvalState, error: approvalStateError } = await supabase.rpc("get_approval_request_state", {
      p_request_id: actionRun.approval_request_id,
    });
    if (!approvalStateError && approvalState && typeof approvalState === "object") {
      const state = approvalState as Record<string, unknown>;
      approval = {
        id: String(state.id ?? actionRun.approval_request_id),
        status: String(state.status ?? "pending"),
        decided_by: state.decidedBy ? String(state.decidedBy) : null,
        decided_at: state.decidedAt ? String(state.decidedAt) : null,
        required_approvals: Number(state.requiredApprovals ?? 1),
        approved_count: Number(state.approvedCount ?? 0),
        rejected_count: Number(state.rejectedCount ?? 0),
        pending_approvals: Number(state.pendingApprovals ?? 0),
      };
    } else {
      const { data: approvalRow } = await supabase
        .from("approval_requests")
        .select("id, status, decided_by, decided_at, required_approvals")
        .eq("id", actionRun.approval_request_id)
        .maybeSingle();
      if (approvalRow) {
        approval = approvalRow as unknown as ApprovalRow;
      }
    }
  }
  return { actionRun, approval };
}

async function resolveRaciContext(args: {
  supabase: AuthedSupabase;
  tenantId: string;
  userId: string;
  resource: string;
  action: string;
}) {
  const { data } = await args.supabase.rpc("resolve_user_raci_context", {
    p_resource: args.resource,
    p_action: args.action,
    p_tenant_id: args.tenantId,
    p_user_id: args.userId,
  });
  const row = (data?.[0] ?? {}) as Record<string, unknown>;
  const profileRole = String(row.profile_role ?? "member").toLowerCase();
  const effectiveRoles = toStringList(row.effective_roles);
  const matchedRoles = toStringList(row.matched_roles);
  const raciRole = mapRaciTypeToRole(row.matched_raci_type);
  const canApprove = Boolean(row.can_approve);
  const canExecute = Boolean(row.can_execute);
  return {
    raciRole,
    canApprove,
    canExecute,
    userRoleLabel: matchedRoles[0] ?? effectiveRoles[0] ?? profileRole,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let actionRunId = "";
  let operation: Operation = "run";
  try {
    const body = await req.json();
    actionRunId = String(body?.actionRunId ?? "").trim();
    operation = String(body?.operation ?? "run").trim().toLowerCase() as Operation;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const allowedOperations = new Set<Operation>([
    "run",
    "cancel",
    "request_approval",
    "approve_execute",
    "reject",
    "undo",
    "retry",
  ]);
  if (!actionRunId || !allowedOperations.has(operation)) {
    return errorResponse(400, "actionRunId and valid operation are required");
  }

  const { data: profileRow, error: profileError } = await auth.supabase
    .from("profiles")
    .select("tenant_id")
    .eq("id", auth.user.id)
    .maybeSingle();
  if (profileError || !profileRow?.tenant_id) {
    return errorResponse(400, "Could not resolve profile context", profileError?.message ?? null);
  }

  let context: { actionRun: ActionRunRow; approval: ApprovalRow | null };
  try {
    context = await loadActionContext(auth.supabase, actionRunId);
  } catch (error) {
    return errorResponse(404, error instanceof Error ? error.message : "Action run not found");
  }

  if (context.actionRun.tenant_id !== profileRow.tenant_id) {
    return errorResponse(403, "Not authorized for this action run");
  }

  const raciContext = await resolveRaciContext({
    supabase: auth.supabase,
    tenantId: context.actionRun.tenant_id,
    userId: auth.user.id,
    resource: context.actionRun.resource || "chat_action_execution",
    action: "execute",
  });
  const isAccountable = raciContext.canApprove;

  let approverName: string | null = null;

  try {
    if (operation === "cancel") {
      await auth.supabase
        .from("agent_action_runs")
        .update({
          status: "cancelled",
          error: null,
        })
        .eq("id", actionRunId);
    } else if (operation === "request_approval") {
      if (context.approval?.status !== "pending") {
        const { data: approvalRows, error: approvalInsertError } = await auth.supabase.rpc("create_approval_request", {
          p_action: "chat.action.execute",
          p_resource: context.actionRun.resource || "chat_action_execution",
          p_risk_level: normalizeRisk((context.actionRun.action_payload ?? {}).riskLevel).toLowerCase(),
          p_params: {
            actionRunId,
            summary: context.actionRun.action_summary,
          },
          p_simulation_preview: context.actionRun.simulation_preview ?? {},
          p_action_summary: context.actionRun.action_summary,
          p_requested_by: auth.user.id,
          p_tenant_id: context.actionRun.tenant_id,
        });
        if (approvalInsertError) throw approvalInsertError;

        const approvalRow = Array.isArray(approvalRows) ? approvalRows[0] : null;
        const approvers = approvalRow?.approvers && Array.isArray(approvalRow.approvers)
          ? (approvalRow.approvers as Array<Record<string, unknown>>)
          : [];
        approverName = approvers[0]?.name ? String(approvers[0].name) : null;

        await auth.supabase
          .from("agent_action_runs")
          .update({
            status: "blocked",
            approval_request_id: approvalRow?.id ?? null,
            error: null,
          })
          .eq("id", actionRunId);
      }
    } else if (operation === "approve_execute") {
      if (!isAccountable) return errorResponse(403, "Only accountable roles can approve and execute");
      if (!context.actionRun.approval_request_id) return errorResponse(400, "Approval request is missing for this action");

      if (context.approval?.status === "pending") {
        const { data, error } = await auth.supabase.rpc("decide_approval_request", {
          p_request_id: context.actionRun.approval_request_id,
          p_decision: "approved",
        });
        if (error) throw error;

        const decisionRow = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
        const decisionStatus = String(decisionRow?.status ?? "pending").toLowerCase();
        if (decisionStatus !== "approved") {
          await auth.supabase
            .from("agent_action_runs")
            .update({
              status: "blocked",
              error: null,
            })
            .eq("id", actionRunId);
          const refreshed = await loadActionContext(auth.supabase, actionRunId);
          const actionProposal = buildProposal({
            run: refreshed.actionRun,
            approval: refreshed.approval,
            raciRole: raciContext.raciRole,
            userRoleLabel: raciContext.userRoleLabel,
            approverName,
          });
          await auth.supabase
            .from("agent_action_runs")
            .update({
              action_payload: actionProposal,
              action_summary: actionProposal.summary,
            })
            .eq("id", actionRunId);

          return jsonResponse(200, {
            ok: true,
            actionProposal,
          });
        }
      }

      const latestApprovalState = await loadActionContext(auth.supabase, actionRunId);
      if (latestApprovalState.approval?.status !== "approved") {
        return errorResponse(409, "Approval quorum not reached yet.");
      }

      await auth.supabase
        .from("agent_action_runs")
        .update({
          status: "executed",
          error: null,
          executed_at: new Date().toISOString(),
          undo_expires_at: new Date(Date.now() + 30_000).toISOString(),
        })
        .eq("id", actionRunId);
    } else if (operation === "reject") {
      if (!isAccountable) return errorResponse(403, "Only accountable roles can reject approvals");
      if (!context.actionRun.approval_request_id) return errorResponse(400, "Approval request is missing for this action");

      if (context.approval?.status === "pending") {
        const { data, error } = await auth.supabase.rpc("decide_approval_request", {
          p_request_id: context.actionRun.approval_request_id,
          p_decision: "denied",
        });
        if (error) throw error;

        const decisionRow = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
        const decisionStatus = String(decisionRow?.status ?? "pending").toLowerCase();
        if (decisionStatus !== "rejected") {
          return errorResponse(409, "Rejection not finalized");
        }
      }

      await auth.supabase
        .from("agent_action_runs")
        .update({
          status: "cancelled",
          error: "Rejected by approver",
        })
        .eq("id", actionRunId);
    } else if (operation === "undo") {
      if (context.actionRun.status !== "executed") return errorResponse(400, "Only executed actions can be undone");
      if (!context.actionRun.undo_expires_at) return errorResponse(400, "Undo window has expired");

      const undoUntil = new Date(context.actionRun.undo_expires_at).getTime();
      if (!Number.isFinite(undoUntil) || undoUntil < Date.now()) {
        return errorResponse(400, "Undo window has expired");
      }

      await auth.supabase
        .from("agent_action_runs")
        .update({
          status: "cancelled",
          reverted_at: new Date().toISOString(),
          error: null,
        })
        .eq("id", actionRunId);
    } else {
      const riskLevel = normalizeRisk((context.actionRun.action_payload ?? {}).riskLevel);
      if (riskLevel === "CRITICAL") {
        return errorResponse(400, "Critical actions require approval");
      }
      if (!raciContext.canExecute || raciContext.raciRole !== "Responsible") {
        return errorResponse(403, "Your role cannot execute directly. Request approval instead.");
      }
      if (context.approval?.status === "pending") {
        return errorResponse(409, "Approval is still pending");
      }
      if (context.actionRun.approval_request_id && context.approval?.status !== "approved") {
        return errorResponse(409, "Action cannot execute until approval quorum is reached.");
      }

      await auth.supabase
        .from("agent_action_runs")
        .update({
          status: "executed",
          error: null,
          executed_at: new Date().toISOString(),
          undo_expires_at: new Date(Date.now() + 30_000).toISOString(),
        })
        .eq("id", actionRunId);
    }
  } catch (error) {
    await auth.supabase
      .from("agent_action_runs")
      .update({
        status: "failed",
        error: error instanceof Error ? error.message : "Action update failed",
      })
      .eq("id", actionRunId);

    const refreshed = await loadActionContext(auth.supabase, actionRunId);
    const failedProposal = buildProposal({
      run: refreshed.actionRun,
      approval: refreshed.approval,
      raciRole: raciContext.raciRole,
      userRoleLabel: raciContext.userRoleLabel,
      approverName,
    });

    return jsonResponse(200, {
      ok: false,
      actionProposal: failedProposal,
      error: error instanceof Error ? error.message : "Action update failed",
    });
  }

  const refreshed = await loadActionContext(auth.supabase, actionRunId);
  const actionProposal = buildProposal({
    run: refreshed.actionRun,
    approval: refreshed.approval,
    raciRole: raciContext.raciRole,
    userRoleLabel: raciContext.userRoleLabel,
    approverName,
  });

  await auth.supabase
    .from("agent_action_runs")
    .update({
      action_payload: actionProposal,
      action_summary: actionProposal.summary,
    })
    .eq("id", actionRunId);

  return jsonResponse(200, {
    ok: true,
    actionProposal,
  });
});
