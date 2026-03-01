import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/service.ts";

type Operation = "get_payload" | "decide" | "get_review_detail" | "review_decide";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeDecision(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === "denied") return "rejected";
  return normalized;
}

async function loadPayload(
  supabase: { rpc: (...args: unknown[]) => Promise<{ data: unknown; error: { message?: string } | null }> },
  filters: {
    statusFilter: string;
    search: string;
    riskFilter: string;
    dateFrom: string;
    dateTo: string;
  },
) {
  const { data, error } = await supabase.rpc("get_approvals_queue_payload", {
    p_status_filter: filters.statusFilter || "all",
    p_search: filters.search || null,
    p_risk_filter: filters.riskFilter || "all",
    p_date_from: filters.dateFrom || null,
    p_date_to: filters.dateTo || null,
  });

  if (error) throw new Error(error.message || "Failed to load approvals queue payload");

  return (
    data ?? {
      profileRole: "member",
      isAccountable: false,
      counts: { all: 0, pending: 0, approved: 0, rejected: 0, expired: 0 },
      pendingNeedingDecision: 0,
      rows: [],
    }
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let operation: Operation = "get_payload";
  let body: Record<string, unknown> = {};

  try {
    body = (await req.json()) as Record<string, unknown>;
    operation = clean(body.operation || "get_payload").toLowerCase() as Operation;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const filters = {
    statusFilter: clean(body.statusFilter || "all").toLowerCase(),
    search: clean(body.search),
    riskFilter: clean(body.riskFilter || "all").toLowerCase(),
    dateFrom: clean(body.dateFrom),
    dateTo: clean(body.dateTo),
  };

  try {
    if (operation === "decide") {
      const approvalId = clean(body.approvalId);
      const decision = normalizeDecision(clean(body.decision));
      const note = clean(body.note);

      if (!approvalId || !decision) {
        return errorResponse(400, "approvalId and decision are required");
      }

      const { data, error } = await auth.supabase.rpc("decide_approval_request_queue", {
        p_request_id: approvalId,
        p_decision: decision,
        p_note: note || null,
      });

      if (error) return errorResponse(400, "Failed to update approval", error.message);

      const payload = await loadPayload(auth.supabase, filters);
      const row = Array.isArray(data) ? data[0] : null;

      return jsonResponse(200, {
        ok: true,
        operation,
        status: row?.status ?? null,
        decidedAt: row?.decided_at ?? null,
        payload,
      });
    }

    if (operation === "get_review_detail") {
      const approvalId = clean(body.approvalId);
      if (!approvalId) return errorResponse(400, "approvalId is required");

      const { data, error } = await auth.supabase.rpc("get_approval_review_payload", {
        p_request_id: approvalId,
      });

      if (error) return errorResponse(400, "Failed to load approval review detail", error.message);

      return jsonResponse(200, {
        ok: true,
        operation,
        review: data ?? null,
      });
    }

    if (operation === "review_decide") {
      const approvalId = clean(body.approvalId);
      const decision = normalizeDecision(clean(body.decision));
      const reason = clean(body.reason);

      if (!approvalId || !decision) {
        return errorResponse(400, "approvalId and decision are required");
      }

      const { data, error } = await auth.supabase.rpc("submit_approval_review_decision", {
        p_request_id: approvalId,
        p_decision: decision,
        p_reason: reason || null,
      });

      if (error) return errorResponse(400, "Failed to submit approval review decision", error.message);

      // CRITICAL: If the approval quorum is now reached, re-enqueue any agent runs
      // that were paused waiting for this approval (status='waiting_approval').
      // The governance wrapper will consume the execution token on re-run so the
      // high-risk tool is not blocked by a second approval request.
      const resultData = data as Record<string, unknown> | null;
      if (resultData?.status === "approved") {
        const svc = getServiceClient();
        if (svc.ok) {
          await svc.supabase.rpc("resume_approved_agent_runs", {
            p_approval_request_id: approvalId,
          }).then(() => null).catch(() => null); // non-fatal: log but don't block response
        }
      }

      const payload = await loadPayload(auth.supabase, filters);
      const reviewRows = await auth.supabase.rpc("get_approval_review_payload", {
        p_request_id: approvalId,
      });

      return jsonResponse(200, {
        ok: true,
        operation,
        result: data ?? null,
        review: reviewRows.error ? null : (reviewRows.data ?? null),
        payload,
      });
    }

    if (operation !== "get_payload") {
      return errorResponse(400, "Unsupported operation");
    }

    const payload = await loadPayload(auth.supabase, filters);
    return jsonResponse(200, {
      ok: true,
      operation,
      payload,
    });
  } catch (error) {
    return errorResponse(500, "Unexpected approvals queue error", error instanceof Error ? error.message : null);
  }
});
