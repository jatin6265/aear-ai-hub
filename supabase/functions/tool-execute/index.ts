import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

type ToolDef = {
  id: string;
  code: string;
  display_name: string;
  description: string | null;
  input_schema: Record<string, unknown>;
  handler_key: string;
  requires_credential_service: string | null;
  risk_level: "low" | "medium" | "high" | "critical";
  raci_required: "R" | "A" | "C" | "I" | "none";
  is_write_action: boolean;
  default_config: Record<string, unknown>;
};

type ExecuteRequest = {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  runId?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  dryRun?: boolean;
};

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function normalizeRisk(value: string | null | undefined): "low" | "medium" | "high" | "critical" {
  const normalized = String(value ?? "low").trim().toLowerCase();
  if (normalized === "medium" || normalized === "high" || normalized === "critical") return normalized;
  return "low";
}

async function executeBuiltInTool(args: {
  supabase: ReturnType<typeof getAuthedClient> extends Promise<infer T>
    ? T extends { ok: true; supabase: infer S }
      ? S
      : never
    : never;
  tool: ToolDef;
  input: Record<string, unknown>;
}) {
  const startedAt = Date.now();

  switch (args.tool.code) {
    case "rag_search": {
      const query = String(args.input.query ?? "").trim();
      const limit = Math.max(1, Math.min(10, Number(args.input.limit ?? 5)));
      if (!query) throw new Error("query is required for rag_search");

      const { data, error } = await args.supabase.rpc("search_knowledge_documents_hybrid", {
        p_query: query,
        p_limit: limit,
      });
      if (error) throw new Error(error.message);

      return {
        status: "success" as const,
        latencyMs: Date.now() - startedAt,
        output: {
          query,
          sources: data ?? [],
          sourceCount: (data ?? []).length,
        },
      };
    }

    case "database_query": {
      const sql = String(args.input.sql ?? "").trim();
      const connectionId = String(args.input.connectionId ?? "").trim();
      const limit = Math.max(1, Math.min(500, Number(args.input.limit ?? 200)));
      if (!sql) throw new Error("sql is required for database_query");
      if (!connectionId) throw new Error("connectionId is required for database_query");

      const { data, error } = await args.supabase.rpc("execute_tenant_sql_governed", {
        p_connection_id: connectionId,
        p_sql: sql,
        p_limit: limit,
        p_resource: "tool_execution",
        p_action: "database_query",
      });
      if (error) throw new Error(error.message);

      return {
        status: "success" as const,
        latencyMs: Date.now() - startedAt,
        output: {
          rows: data ?? [],
        },
      };
    }

    case "http_request":
    case "webhook_call": {
      const method = String(args.input.method ?? "POST").trim().toUpperCase();
      const url = String(args.input.url ?? "").trim();
      const headers = asRecord(args.input.headers);
      const payload = args.input.body ?? args.input.payload ?? null;
      if (!url) throw new Error("url is required");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const response = await fetch(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...Object.fromEntries(
              Object.entries(headers).map(([key, value]) => [key, String(value)]),
            ),
          },
          body: payload === null || method === "GET" ? undefined : JSON.stringify(payload),
          signal: controller.signal,
        });

        const text = await response.text();
        return {
          status: response.ok ? ("success" as const) : ("error" as const),
          latencyMs: Date.now() - startedAt,
          output: {
            status: response.status,
            ok: response.ok,
            body: text.slice(0, 6000),
          },
        };
      } finally {
        clearTimeout(timeout);
      }
    }

    case "file_reader": {
      const documentId = String(args.input.documentId ?? "").trim();
      if (!documentId) throw new Error("documentId is required");

      const [{ data: doc, error: docError }, { data: chunks, error: chunksError }] = await Promise.all([
        args.supabase
          .from("knowledge_documents")
          .select("id, title, excerpt, status, file_name")
          .eq("id", documentId)
          .maybeSingle(),
        args.supabase
          .from("knowledge_document_chunks")
          .select("chunk_index, content")
          .eq("document_id", documentId)
          .order("chunk_index", { ascending: true })
          .limit(5),
      ]);

      if (docError) throw new Error(docError.message);
      if (chunksError) throw new Error(chunksError.message);
      if (!doc) throw new Error("document not found");

      return {
        status: "success" as const,
        latencyMs: Date.now() - startedAt,
        output: {
          document: doc,
          chunks: chunks ?? [],
        },
      };
    }

    default:
      throw new Error(
        `${args.tool.code} is registered but has no executable handler configured in this environment.`,
      );
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let body: ExecuteRequest;
  try {
    body = (await req.json()) as ExecuteRequest;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const toolName = String(body.toolName ?? "").trim().toLowerCase();
  if (!toolName) return errorResponse(400, "toolName is required");

  const toolInput = asRecord(body.toolInput);
  const runId = body.runId ? String(body.runId) : null;
  const sessionId = body.sessionId ? String(body.sessionId) : null;
  const agentId = body.agentId ? String(body.agentId) : null;

  const { data: toolRows, error: toolError } = await auth.supabase.rpc("resolve_tool_definition", {
    p_tool_name: toolName,
    p_agent_id: agentId,
    p_tenant_id: null,
  });

  if (toolError) return errorResponse(400, "Failed to resolve tool", toolError.message);
  const tool = toolRows?.[0] as ToolDef | undefined;
  if (!tool) return errorResponse(404, "Tool not found or inactive");

  const { data: policyRows, error: policyError } = await auth.supabase.rpc("evaluate_action_policy", {
    p_resource: `tool:${tool.code}`,
    p_action: "execute",
    p_risk_level: normalizeRisk(tool.risk_level),
    p_requires_write: Boolean(tool.is_write_action),
  });

  if (policyError) return errorResponse(400, "Policy evaluation failed", policyError.message);

  const decision = (policyRows?.[0] ?? {
    allow: false,
    approval_required: true,
    reason: "Policy evaluator returned no decision",
    matched_rule: {},
  }) as {
    allow: boolean;
    approval_required: boolean;
    reason?: string | null;
    matched_rule?: Record<string, unknown>;
  };

  if (body.dryRun) {
    return jsonResponse(200, {
      ok: true,
      dryRun: true,
      tool,
      policyDecision: {
        allow: Boolean(decision.allow),
        approvalRequired: Boolean(decision.approval_required),
        reason: decision.reason ?? null,
        matchedRule: decision.matched_rule ?? {},
      },
    });
  }

  if (!decision.allow || decision.approval_required) {
    let approvalRef: string | null = null;
    let requiredApprovals = 1;
    let pendingApprovals = 0;
    let approvers: Array<Record<string, unknown>> = [];

    if (decision.approval_required) {
      const tenantLookup = await auth.supabase.rpc("get_user_tenant_id");
      const { data: approvalRows, error: approvalError } = await auth.supabase.rpc("create_approval_request", {
        p_action: "tool.execute",
        p_resource: tool.code,
        p_risk_level: tool.risk_level,
        p_params: {
          toolInput,
          runId,
          sessionId,
          agentId,
        },
        p_action_summary: `${tool.display_name} tool execution`,
        p_requested_by: auth.user.id,
        p_tenant_id: tenantLookup.data,
      });

      const approvalRow = Array.isArray(approvalRows) ? (approvalRows[0] as Record<string, unknown> | undefined) : undefined;
      approvalRef = approvalRow?.id ? String(approvalRow.id) : null;
      requiredApprovals = Number(approvalRow?.required_approvals ?? 1);
      pendingApprovals = Number(approvalRow?.pending_approvals ?? requiredApprovals);
      approvers = Array.isArray(approvalRow?.approvers) ? (approvalRow?.approvers as Array<Record<string, unknown>>) : [];
      if (approvalError) {
        approvers = [];
      }
    }

    if (runId) {
      await auth.supabase.rpc("record_tool_execution", {
        p_run_id: runId,
        p_tool_name: tool.code,
        p_status: "blocked",
        p_tool_input: toolInput,
        p_tool_output: {
          approvalRef,
          reason: decision.reason ?? "Blocked by policy",
          requiredApprovals,
          pendingApprovals,
          approvers,
        },
        p_latency_ms: 0,
        p_error: decision.reason ?? "Blocked by policy",
        p_risk_level: tool.risk_level,
        p_agent_id: agentId,
        p_session_id: sessionId,
        p_cost_credits: 0,
      });

      await auth.supabase.rpc("complete_agent_run_step", {
        p_run_id: runId,
        p_step_type: "tool_call",
        p_status: "error",
        p_data: {
          tool: tool.code,
          blocked: true,
          reason: decision.reason ?? "Blocked by policy",
          approvalRef,
          requiredApprovals,
          pendingApprovals,
        },
        p_tool_name: tool.code,
        p_latency_ms: 0,
        p_cost_credits: 0,
      });
    }

    return errorResponse(403, "Tool execution blocked by policy", {
      approvalRef,
      requiredApprovals,
      pendingApprovals,
      approvers,
      decision,
    });
  }

  const startedAt = Date.now();
  try {
    if (runId) {
      await auth.supabase.rpc("complete_agent_run_step", {
        p_run_id: runId,
        p_step_type: "tool_call",
        p_status: "running",
        p_data: {
          tool: tool.code,
          input: toolInput,
        },
        p_tool_name: tool.code,
        p_latency_ms: null,
        p_cost_credits: 0,
      });
    }

    const exec = await executeBuiltInTool({
      supabase: auth.supabase,
      tool,
      input: toolInput,
    });

    if (runId) {
      await auth.supabase.rpc("record_tool_execution", {
        p_run_id: runId,
        p_tool_name: tool.code,
        p_status: exec.status,
        p_tool_input: toolInput,
        p_tool_output: exec.output,
        p_latency_ms: exec.latencyMs,
        p_error: null,
        p_risk_level: tool.risk_level,
        p_agent_id: agentId,
        p_session_id: sessionId,
        p_cost_credits: 0,
      });

      await auth.supabase.rpc("complete_agent_run_step", {
        p_run_id: runId,
        p_step_type: "tool_result",
        p_status: exec.status,
        p_data: {
          tool: tool.code,
          output: exec.output,
        },
        p_tool_name: tool.code,
        p_latency_ms: exec.latencyMs,
        p_cost_credits: 0,
      });
    }

    return jsonResponse(200, {
      ok: true,
      tool: {
        code: tool.code,
        risk: tool.risk_level,
        raciRequired: tool.raci_required,
      },
      latencyMs: exec.latencyMs,
      output: exec.output,
      totalLatencyMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed";

    if (runId) {
      await auth.supabase.rpc("record_tool_execution", {
        p_run_id: runId,
        p_tool_name: tool.code,
        p_status: "error",
        p_tool_input: toolInput,
        p_tool_output: {},
        p_latency_ms: Date.now() - startedAt,
        p_error: message,
        p_risk_level: tool.risk_level,
        p_agent_id: agentId,
        p_session_id: sessionId,
        p_cost_credits: 0,
      });

      await auth.supabase.rpc("complete_agent_run_step", {
        p_run_id: runId,
        p_step_type: "tool_result",
        p_status: "error",
        p_data: {
          tool: tool.code,
          error: message,
        },
        p_tool_name: tool.code,
        p_latency_ms: Date.now() - startedAt,
        p_cost_credits: 0,
      });
    }

    return errorResponse(500, "Tool execution failed", message);
  }
});
