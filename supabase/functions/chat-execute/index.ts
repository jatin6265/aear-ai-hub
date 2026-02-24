import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type Confidence = "High confidence" | "Medium confidence" | "Based on limited data";

type SqlResultPayload = {
  sql: string;
  executionMs: number;
  columns: Array<{ key: string; label: string; type?: "number" | "date" | "text"; pii?: boolean }>;
  rows: Record<string, unknown>[];
  explanation: string;
  followUps: string[];
  error?: string;
  noResultsHint?: string;
  runId?: string;
};

type KnowledgeResultPayload = {
  query: string;
  confidence: Confidence;
  runId?: string;
  sources: Array<{
    id: string;
    title: string;
    fileType: string;
    sourceType: string;
    relevance: number;
    excerpt: string;
    externalUrl: string | null;
    storagePath: string | null;
  }>;
};

type RaciRole = "Responsible" | "Consulted" | "Accountable";

type ActionProposalPreviewRow = {
  field: string;
  before: string;
  after: string;
};

type ActionProposalPayload = {
  runId: string | null;
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

type ExecuteSqlRpcRow = {
  success: boolean;
  execution_ms: number;
  columns: Array<{ key: string; label: string }> | null;
  rows: Record<string, unknown>[] | null;
  error: string | null;
};

type ExecuteSqlGovernedRpcRow = ExecuteSqlRpcRow & {
  approval_required?: boolean;
  policy_decision?: Record<string, unknown> | null;
};

type ChatExecuteRequest = {
  prompt?: string;
  sessionId?: string | null;
  retryRunId?: string | null;
  retrySql?: string | null;
  retryError?: string | null;
};

type ToolRun = {
  tool: string;
  status: "success" | "error" | "blocked";
  latencyMs?: number | null;
  meta?: Record<string, unknown>;
};

type RetrievalMeta = {
  strategy: "hybrid" | "lexical";
  candidateCount: number;
  vectorWeight: number;
  lexicalWeight: number;
  topScore?: number;
};

type PolicyDecision = {
  allow: boolean;
  approvalRequired: boolean;
  reason: string;
  matchedRule: Record<string, unknown>;
};

type TenantContextSummary = {
  totalConnections: number;
  activeConnections: number;
  syncingConnections: number;
  totalAgents: number;
  readyAgents: number;
  indexedDocuments: number;
  pendingApprovals: number;
  recentConnectionNames: string[];
};

type AuthedSupabase = Extract<
  Awaited<ReturnType<typeof getAuthedClient>>,
  { ok: true }
>["supabase"];

function sanitizeSql(sql: string) {
  return sql.replace(/;+/g, "").trim();
}

type AgentCandidate = {
  name: string;
  domain: string | null;
  description: string | null;
  config: Record<string, unknown> | null;
  status: string;
};

function tokenizePrompt(input: string) {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map((value) => value.trim())
    .filter((value) => value.length >= 3);
}

function scoreAgentCandidate(promptTokens: string[], agent: AgentCandidate) {
  const config = agent.config && typeof agent.config === "object" ? agent.config : {};
  const corpus = [
    String(agent.name ?? ""),
    String(agent.domain ?? ""),
    String(agent.description ?? ""),
    ...(Array.isArray(config.entity_groups) ? config.entity_groups.map((value) => String(value ?? "")) : []),
    ...(Array.isArray(config.sensitivities) ? config.sensitivities.map((value) => String(value ?? "")) : []),
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const token of promptTokens) {
    if (corpus.includes(token)) score += 1;
  }

  const normalizedDomain = String(agent.domain ?? "").toLowerCase();
  if (normalizedDomain && promptTokens.includes(normalizedDomain)) score += 2;
  if (agent.status === "ready") score += 1;
  return score;
}

async function detectAgent(prompt: string, supabase: AuthedSupabase, tenantId: string) {
  const { data, error } = await supabase
    .from("ai_agents")
    .select("name, domain, description, config, status")
    .eq("tenant_id", tenantId)
    .neq("status", "disabled")
    .order("updated_at", { ascending: false })
    .limit(40);

  if (error || !data || data.length === 0) return "AEAR Core";
  const candidates = data as AgentCandidate[];
  const promptTokens = tokenizePrompt(prompt);
  if (promptTokens.length === 0) return candidates[0]?.name ?? "AEAR Core";

  let best: AgentCandidate | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = scoreAgentCandidate(promptTokens, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best?.name ?? candidates[0]?.name ?? "AEAR Core";
}

function detectRisk(prompt: string): RiskLevel | null {
  const value = prompt.toLowerCase();
  if (/(drop|delete|remove|shutdown|terminate|wipe|truncate|alter)/.test(value)) return "CRITICAL";
  if (/(approve|transfer|payment|invoice|write|publish)/.test(value)) return "HIGH";
  if (/(update|change|modify|sync|rerun)/.test(value)) return "MEDIUM";
  if (/(show|list|find|summarize|what|how|query|search)/.test(value)) return "LOW";
  return null;
}

function isKnowledgePrompt(prompt: string) {
  return /(document|documents|knowledge|policy|handbook|playbook|guide|notion|google doc|file|pdf|txt|docx|source)/i.test(
    prompt,
  );
}

function isSqlPrompt(prompt: string) {
  return /(sql|query|database|table|revenue|invoice|customer|orders|count|total|list|show|trend|top|group by|select)/i.test(
    prompt,
  );
}

function isActionPrompt(prompt: string) {
  return /\b(update|change|modify|set|execute|run action|trigger|approve|delete|remove|block|unblock|assign)\b/i.test(prompt);
}

function isAgentStudioPrompt(prompt: string) {
  return /\b(create|build|generate|setup|configure|deploy)\b[\s\w-]{0,40}\bagent\b/i.test(prompt) ||
    /\bcustom agent\b/i.test(prompt) ||
    /\bagent for\b/i.test(prompt);
}

function hasDestructiveIntent(prompt: string) {
  return /\b(drop|delete|truncate|alter|insert|update|remove|wipe)\b/i.test(prompt);
}

function isWorkspaceContextPrompt(prompt: string) {
  const value = prompt.toLowerCase();
  if (/\b(how many|count|number of|total)\b.*\b(connection|connections|source|sources|agent|agents|document|documents|approval|approvals)\b/.test(value)) {
    return true;
  }
  if (/\b(connection|connections|data source|sources)\b/.test(value) && /\b(do i have|in my workspace|status|summary|overview)\b/.test(value)) {
    return true;
  }
  if (/\b(agent|agents)\b/.test(value) && /\b(ready|active|generated|status)\b/.test(value)) {
    return true;
  }
  if (/\b(knowledge|document|documents|embedding|embeddings|rag)\b/.test(value) && /\b(status|coverage|indexed|count)\b/.test(value)) {
    return true;
  }
  if (/\b(approval|approvals)\b/.test(value) && /\b(pending|queue|status)\b/.test(value)) {
    return true;
  }
  return false;
}

function pluralize(count: number, singular: string, pluralWord?: string) {
  if (count === 1) return singular;
  return pluralWord ?? `${singular}s`;
}

async function loadTenantContextSummary(supabase: AuthedSupabase, tenantId: string): Promise<TenantContextSummary | null> {
  const isMissingArchiveColumnError = (error: { code?: string | null; message?: string | null } | null) => {
    if (!error) return false;
    const code = String(error.code ?? "");
    const message = String(error.message ?? "").toLowerCase();
    return code === "42703" || message.includes("is_archived");
  };

  const connectionWithArchive = await supabase
    .from("api_connections")
    .select("name, status")
    .eq("tenant_id", tenantId)
    .eq("is_archived", false)
    .order("created_at", { ascending: false })
    .limit(50);

  let connectionRows = connectionWithArchive.data;
  if (connectionWithArchive.error) {
    const fallbackConnections = await supabase
      .from("api_connections")
      .select("name, status")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (!fallbackConnections.error) {
      connectionRows = fallbackConnections.data;
    } else if (!isMissingArchiveColumnError(connectionWithArchive.error)) {
      // Keep best-effort summary even if connection query failed.
      connectionRows = [];
    }
  }

  const safeConnections = (connectionRows ?? []).map((row) => ({
    name: String((row as Record<string, unknown>).name ?? "Unnamed connection"),
    status: String((row as Record<string, unknown>).status ?? "pending").toLowerCase(),
  }));

  const activeConnections = safeConnections.filter((row) => row.status === "active").length;
  const syncingConnections = safeConnections.filter((row) => row.status === "syncing" || row.status === "pending").length;

  const { data: agentRows } = await supabase
    .from("ai_agents")
    .select("status")
    .eq("tenant_id", tenantId)
    .neq("status", "disabled")
    .limit(200);

  const safeAgents = (agentRows ?? []).map((row) => String((row as Record<string, unknown>).status ?? "draft").toLowerCase());
  const readyAgents = safeAgents.filter((status) => status === "ready" || status === "active").length;

  const { count: indexedDocuments, error: indexedDocumentsError } = await supabase
    .from("knowledge_documents")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("status", "indexed");

  const { count: pendingApprovals, error: pendingApprovalsError } = await supabase
    .from("approval_requests")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("status", "pending");

  return {
    totalConnections: safeConnections.length,
    activeConnections,
    syncingConnections,
    totalAgents: safeAgents.length,
    readyAgents,
    indexedDocuments: indexedDocumentsError ? 0 : Math.max(0, Number(indexedDocuments ?? 0)),
    pendingApprovals: pendingApprovalsError ? 0 : Math.max(0, Number(pendingApprovals ?? 0)),
    recentConnectionNames: safeConnections.slice(0, 5).map((row) => row.name),
  };
}

function buildTenantContextAnswer(prompt: string, summary: TenantContextSummary) {
  const input = prompt.toLowerCase();

  if (/\b(connection|connections|source|sources)\b/.test(input)) {
    return [
      `You currently have **${summary.totalConnections}** data ${pluralize(summary.totalConnections, "connection")} in this workspace.`,
      `Active: **${summary.activeConnections}**. Syncing/Pending: **${summary.syncingConnections}**.`,
      summary.recentConnectionNames.length > 0
        ? `Recent sources: ${summary.recentConnectionNames.map((name) => `**${name}**`).join(", ")}.`
        : "No sources are configured yet. Add a connection to enable SQL and RAG grounding.",
    ].join("\n");
  }

  if (/\b(agent|agents)\b/.test(input)) {
    return [
      `Agents available: **${summary.totalAgents}** total, **${summary.readyAgents}** ready.`,
      summary.totalAgents === 0
        ? "No domain agents are ready yet. Finish connector sync/discovery to auto-generate them."
        : "Use `/dashboard/agents` to inspect lifecycle, tools, and recent executions.",
    ].join("\n");
  }

  if (/\b(knowledge|document|documents|embedding|embeddings|rag)\b/.test(input)) {
    return [
      `Indexed knowledge documents: **${summary.indexedDocuments}**.`,
      summary.indexedDocuments > 0
        ? "RAG retrieval will use indexed chunks plus lexical fallback during chat."
        : "No indexed documents yet. Upload files or finish connection indexing to populate the knowledge base.",
    ].join("\n");
  }

  if (/\b(approval|approvals)\b/.test(input)) {
    return [
      `Pending approvals: **${summary.pendingApprovals}**.`,
      summary.pendingApprovals > 0
        ? "Open `/dashboard/approvals` to review and resolve queued decisions."
        : "No approvals are currently pending.",
    ].join("\n");
  }

  return [
    "I checked live workspace context for this request.",
    `Connections: **${summary.totalConnections}** (active **${summary.activeConnections}**)`,
    `Agents: **${summary.totalAgents}** total (**${summary.readyAgents}** ready)`,
    `Indexed docs: **${summary.indexedDocuments}**`,
    `Pending approvals: **${summary.pendingApprovals}**`,
  ].join("\n");
}

function toStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0);
}

function mapRaciTypeToRole(value: unknown): RaciRole {
  const raciType = String(value ?? "").trim().toUpperCase();
  if (raciType === "A") return "Accountable";
  if (raciType === "R") return "Responsible";
  return "Consulted";
}

function normalizeRaciRole(value: unknown): RaciRole {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "accountable") return "Accountable";
  if (normalized === "consulted") return "Consulted";
  if (normalized === "responsible") return "Responsible";
  return "Consulted";
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim().toLowerCase()).filter((item) => item.length > 0);
}

function extractNumberTransitions(prompt: string): ActionProposalPreviewRow[] {
  const transitionPattern = /([a-z_][a-z0-9_ ]{1,40})\s+(\d+(?:\.\d+)?)\s*(?:->|to)\s*(\d+(?:\.\d+)?)/gi;
  const rows: ActionProposalPreviewRow[] = [];

  let match: RegExpExecArray | null = transitionPattern.exec(prompt);
  while (match && rows.length < 3) {
    rows.push({
      field: String(match[1]).trim().replace(/\s+/g, "_"),
      before: String(match[2]),
      after: String(match[3]),
    });
    match = transitionPattern.exec(prompt);
  }

  if (rows.length > 0) return rows;
  return [
    {
      field: "value",
      before: "current",
      after: "updated",
    },
  ];
}

function buildActionSummary(prompt: string) {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (compact.length <= 140) return compact;
  return `${compact.slice(0, 137)}...`;
}

function buildActionProposal(args: {
  prompt: string;
  riskLevel: RiskLevel;
  raciRole: RaciRole;
  userRoleLabel: string;
  approvalRequired: boolean;
  approvalRef?: string | null;
  requiredApprovals?: number;
  approvedCount?: number;
  rejectedCount?: number;
  pendingApprovals?: number;
}): ActionProposalPayload {
  const raciRole = normalizeRaciRole(args.raciRole);
  const previewRows = extractNumberTransitions(args.prompt);
  const summary = buildActionSummary(args.prompt);

  return {
    runId: null,
    riskLevel: args.riskLevel,
    summary,
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
      required: args.approvalRequired,
      status: args.approvalRef ? "pending" : "none",
      requestId: args.approvalRef ?? null,
      approverName: args.approvalRef ? "Finance Manager" : null,
      requiredApprovals: Math.max(1, Math.floor(Number(args.requiredApprovals ?? 1))),
      approvedCount: Math.max(0, Math.floor(Number(args.approvedCount ?? 0))),
      rejectedCount: Math.max(0, Math.floor(Number(args.rejectedCount ?? 0))),
      pendingApprovals: Math.max(
        0,
        Math.floor(
          Number(
            args.pendingApprovals ??
              (args.approvalRequired ? args.requiredApprovals ?? 1 : 0),
          ),
        ),
      ),
    },
    simulation: {
      impactSummary: "1 record will be updated. Reversible: Yes.",
      reversible: true,
      recordCount: 1,
      previewRows,
    },
    state: {
      status: args.approvalRequired ? "blocked" : "proposed",
      successMessage: null,
      errorMessage: null,
      undoExpiresAt: null,
      revertedAt: null,
    },
  };
}

function inferType(value: unknown): "number" | "date" | "text" {
  if (typeof value === "number") return "number";
  if (typeof value === "string") {
    if (!Number.isNaN(Date.parse(value)) && /(date|time|at)/i.test(value) === false) return "date";
    if (!Number.isNaN(Number(value)) && value.trim() !== "") return "number";
  }
  return "text";
}

function inferColumns(rows: Record<string, unknown>[]) {
  const first = rows[0] ?? {};
  return Object.keys(first).map((key) => ({
    key,
    label: key.replaceAll("_", " ").replace(/\b\w/g, (match) => match.toUpperCase()),
    type: inferType(first[key]),
    pii: /(email|phone|mobile|ssn|tax|dob|birth|address|customer_name|full_name|name)$/i.test(key),
  }));
}

function mapConfidence(count: number): Confidence {
  if (count >= 3) return "High confidence";
  if (count >= 1) return "Medium confidence";
  return "Based on limited data";
}

function fallbackSqlFromPrompt(prompt: string): { sql: string; explanation: string; followUps: string[] } {
  const input = prompt.toLowerCase();

  if (/(trend|daily|weekly|monthly|last 7|last 30|time series|revenue)/.test(input)) {
    return {
      sql: "SELECT paid_at::date AS day, SUM(amount) AS revenue_usd FROM invoices WHERE paid_at >= NOW() - interval '7 days' GROUP BY 1 ORDER BY 1",
      explanation: "Shows day-wise revenue for the last 7 days.",
      followUps: ["Break this down by region", "Compare to previous 7 days", "Highlight anomalies in this trend"],
    };
  }

  if (/(status|distribution|group by|segment|overdue)/.test(input)) {
    return {
      sql: "SELECT status, COUNT(*) AS invoice_count, SUM(amount) AS total_amount FROM invoices GROUP BY status ORDER BY total_amount DESC",
      explanation: "Summarizes invoice value distribution by status.",
      followUps: ["Show top overdue accounts", "Compare status split vs last month", "Show overdue by country"],
    };
  }

  if (/(total|count|how many|kpi)/.test(input)) {
    return {
      sql: "SELECT SUM(amount) AS total_revenue_usd FROM invoices WHERE paid_at >= date_trunc('month', NOW())",
      explanation: "Returns current-month paid revenue.",
      followUps: ["Compare to last month", "Break down by product", "Show top contributing customers"],
    };
  }

  return {
    sql: "SELECT customer_name, email, country, amount_due, due_date, status FROM customer_invoices ORDER BY amount_due DESC LIMIT 25",
    explanation: "Lists highest due balances first for collection prioritization.",
    followUps: ["Only show >15 days overdue", "Summarize by country", "Draft reminders for top 3 accounts"],
  };
}

function heuristicFixSql(failedSql: string) {
  let fixed = sanitizeSql(failedSql);
  if (!fixed) return fixed;

  fixed = fixed.replace(/\border\s+(?!by\b)([a-z_][a-z0-9_]*)(\s+(asc|desc))?/gi, (_match, column, direction) => {
    return `ORDER BY ${String(column)}${String(direction ?? "")}`;
  });

  fixed = fixed.replace(/\s+/g, " ").trim();
  return fixed;
}

async function generateSqlWithLlm(prompt: string): Promise<string | null> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return null;

  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";
  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a SQL generator for analytics. Return exactly one read-only PostgreSQL query and nothing else. Rules: single statement, no semicolon, no comments, no INSERT/UPDATE/DELETE/DDL.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0.1,
    max_tokens: 220,
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) return null;
  const json = await response.json();
  const text = String(json?.choices?.[0]?.message?.content ?? "").trim();
  if (!text) return null;
  return sanitizeSql(text);
}

async function generateFixedSqlWithLlm(args: {
  prompt: string;
  failedSql: string;
  errorMessage?: string | null;
}): Promise<string | null> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return null;
  if (!args.failedSql.trim()) return null;

  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";
  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You fix SQL queries for PostgreSQL. Return exactly one corrected read-only query. Rules: single statement, no semicolon, no comments, no INSERT/UPDATE/DELETE/DDL.",
      },
      {
        role: "user",
        content: [
          `User request: ${args.prompt}`,
          `Failed SQL: ${args.failedSql}`,
          `Database error: ${args.errorMessage ?? "unknown"}`,
          "Return only corrected SQL.",
        ].join("\n"),
      },
    ],
    temperature: 0,
    max_tokens: 260,
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) return null;
  const json = await response.json();
  const text = String(json?.choices?.[0]?.message?.content ?? "").trim();
  if (!text) return null;
  return sanitizeSql(text);
}

function toVectorLiteral(vector: number[]) {
  return `[${vector.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

async function generateQueryEmbedding(query: string): Promise<string | null> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return null;
  const input = query.trim();
  if (!input) return null;

  const model = Deno.env.get("OPENAI_EMBEDDING_MODEL") ?? "text-embedding-3-small";
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input,
    }),
  });

  if (!response.ok) return null;
  const payload = await response.json();
  const embedding = payload?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) return null;
  const numeric = embedding.map((value: unknown) => Number(value)).filter((value: number) => Number.isFinite(value));
  if (numeric.length === 0) return null;
  return toVectorLiteral(numeric);
}

async function pickConnectionIdForSql(args: {
  supabase: AuthedSupabase;
  preferredConnectionId?: string | null;
}): Promise<{ id: string } | null> {
  const isMissingArchiveColumnError = (error: { code?: string | null; message?: string | null } | null) => {
    if (!error) return false;
    const code = String(error.code ?? "");
    const message = String(error.message ?? "").toLowerCase();
    return code === "42703" || message.includes("is_archived");
  };

  const preferredId = args.preferredConnectionId?.trim() || null;

  if (preferredId) {
    const preferredWithArchiveFilter = await args.supabase
      .from("api_connections")
      .select("id")
      .eq("id", preferredId)
      .eq("is_archived", false)
      .in("status", ["active", "syncing", "pending"])
      .limit(1)
      .maybeSingle();

    if (!preferredWithArchiveFilter.error && preferredWithArchiveFilter.data?.id) {
      return { id: String(preferredWithArchiveFilter.data.id) };
    }

    if (preferredWithArchiveFilter.error && isMissingArchiveColumnError(preferredWithArchiveFilter.error)) {
      const preferredFallback = await args.supabase
        .from("api_connections")
        .select("id")
        .eq("id", preferredId)
        .in("status", ["active", "syncing", "pending"])
        .limit(1)
        .maybeSingle();

      if (!preferredFallback.error && preferredFallback.data?.id) {
        return { id: String(preferredFallback.data.id) };
      }
    }
  }

  const primaryLookup = await args.supabase
    .from("api_connections")
    .select("id")
    .eq("is_archived", false)
    .in("status", ["active", "syncing", "pending"])
    .order("created_at", { ascending: true })
    .limit(1);

  if (primaryLookup.error && !isMissingArchiveColumnError(primaryLookup.error)) {
    throw primaryLookup.error;
  }

  let connectionRows = primaryLookup.data;
  if (primaryLookup.error && isMissingArchiveColumnError(primaryLookup.error)) {
    const fallbackLookup = await args.supabase
      .from("api_connections")
      .select("id")
      .in("status", ["active", "syncing", "pending"])
      .order("created_at", { ascending: true })
      .limit(1);
    if (fallbackLookup.error) throw fallbackLookup.error;
    connectionRows = fallbackLookup.data;
  }

  const connection = connectionRows?.[0];
  if (!connection) return null;
  return { id: String(connection.id) };
}

async function executeSql(args: {
  supabase: AuthedSupabase;
  connectionId: string;
  sql: string;
  explanation: string;
  followUps: string[];
}): Promise<SqlResultPayload> {
  const sanitizedSql = sanitizeSql(args.sql);

  let execRows: ExecuteSqlGovernedRpcRow[] | null = null;
  let execError: { message: string } | null = null;

  const governedAttempt = await args.supabase.rpc("execute_tenant_sql_governed", {
    p_connection_id: args.connectionId,
    p_sql: sanitizedSql,
    p_limit: 200,
    p_resource: "chat_sql_execution",
    p_action: "sql_query",
  });

  if (governedAttempt.error) {
    const readAttempt = await args.supabase.rpc("execute_tenant_read_sql", {
      p_connection_id: args.connectionId,
      p_sql: sanitizedSql,
      p_limit: 200,
    });
    execRows = (readAttempt.data as ExecuteSqlGovernedRpcRow[] | null) ?? null;
    execError = readAttempt.error ? { message: readAttempt.error.message } : null;
  } else {
    execRows = (governedAttempt.data as ExecuteSqlGovernedRpcRow[] | null) ?? null;
    execError = null;
  }

  if (execError) {
    return {
      sql: sanitizedSql,
      executionMs: 0,
      columns: [],
      rows: [],
      explanation: "Guarded SQL execution failed.",
      followUps: args.followUps,
      error: execError.message,
    };
  }

  const exec = execRows?.[0] as ExecuteSqlGovernedRpcRow | undefined;
  const rows = Array.isArray(exec?.rows) ? exec.rows : [];
  const columns = Array.isArray(exec?.columns)
    ? exec.columns.map((col) => ({
        key: String(col.key),
        label: String(col.label),
        type: inferType(rows[0]?.[String(col.key)]),
        pii: /(email|phone|mobile|ssn|tax|dob|birth|address|customer_name|full_name|name)$/i.test(String(col.key)),
      }))
    : inferColumns(rows);

  return {
    sql: sanitizedSql,
    executionMs: Number(exec?.execution_ms ?? 0),
    columns,
    rows,
    explanation: args.explanation,
    followUps: args.followUps,
    error: exec?.success === false ? String(exec.error ?? "Execution failed") : undefined,
    noResultsHint: rows.length === 0 ? "Try broadening the time range or relaxing filters." : undefined,
  };
}

async function persistSqlRun(args: {
  supabase: AuthedSupabase;
  tenantId: string;
  sessionId: string;
  requestedBy: string;
  connectionId: string | null;
  agent: string;
  prompt: string;
  sqlResult: SqlResultPayload;
}): Promise<string | null> {
  const { data, error } = await args.supabase
    .from("chat_sql_runs")
    .insert({
      tenant_id: args.tenantId,
      session_id: args.sessionId,
      requested_by: args.requestedBy,
      connection_id: args.connectionId,
      agent: args.agent,
      prompt: args.prompt,
      sql_query: args.sqlResult.sql,
      execution_ms: args.sqlResult.executionMs,
      success: !args.sqlResult.error,
      error: args.sqlResult.error ?? null,
      result_columns: args.sqlResult.columns,
      result_rows: args.sqlResult.rows,
      row_count: args.sqlResult.rows.length,
      explanation: args.sqlResult.explanation,
      follow_ups: args.sqlResult.followUps,
    })
    .select("id")
    .single();

  if (error) return null;
  return data?.id ? String(data.id) : null;
}

async function persistKnowledgeRun(args: {
  supabase: AuthedSupabase;
  tenantId: string;
  sessionId: string;
  requestedBy: string;
  prompt: string;
  confidence: Confidence;
  sources: KnowledgeResultPayload["sources"];
}): Promise<string | null> {
  const { data, error } = await args.supabase
    .from("chat_knowledge_runs")
    .insert({
      tenant_id: args.tenantId,
      session_id: args.sessionId,
      requested_by: args.requestedBy,
      prompt: args.prompt,
      confidence: args.confidence,
      source_count: args.sources.length,
      sources: args.sources,
    })
    .select("id")
    .single();

  if (error) return null;
  return data?.id ? String(data.id) : null;
}

async function persistToolRun(args: {
  supabase: AuthedSupabase;
  tenantId: string;
  sessionId: string | null;
  requestedBy: string;
  agentName: string;
  toolRun: ToolRun;
}) {
  if (!args.sessionId) return;
  try {
    await args.supabase.from("agent_tool_runs").insert({
      tenant_id: args.tenantId,
      session_id: args.sessionId,
      agent_name: args.agentName,
      tool_name: args.toolRun.tool,
      tool_input: args.toolRun.meta ?? {},
      tool_output: args.toolRun.meta ?? {},
      status: args.toolRun.status,
      latency_ms: args.toolRun.latencyMs ?? null,
      error: args.toolRun.status === "error" ? String(args.toolRun.meta?.error ?? "Tool execution failed") : null,
    });
  } catch {
    // Ignore optional telemetry persistence failures to avoid blocking chat responses.
  }
}

function estimateUsage(prompt: string, assistant: string, knowledgeSources: number, sqlRows: number) {
  const promptTokens = Math.max(1, Math.round(prompt.length / 4));
  const completionTokens = Math.max(1, Math.round(assistant.length / 4));
  const retrievalTokens = Math.max(0, knowledgeSources * 120);
  const sqlTokens = Math.max(0, sqlRows * 6);
  return {
    promptTokens,
    completionTokens,
    retrievalTokens,
    sqlTokens,
    totalTokens: promptTokens + completionTokens + retrievalTokens + sqlTokens,
  };
}

function buildKnowledgeAnswer(knowledgeResult: KnowledgeResultPayload) {
  if (knowledgeResult.sources.length === 0) {
    return [
      "I searched your knowledge base but found no relevant documents.",
      "",
      "Try uploading documents or connecting a knowledge source.",
      "",
      `Confidence: **${knowledgeResult.confidence}**.`,
    ].join("\n");
  }

  const citations = knowledgeResult.sources
    .slice(0, 5)
    .map((source, index) => `[${index + 1}](#source-${source.id})`)
    .join(" ");

  return [
    `I found relevant context in your knowledge base ${citations}.`,
    "",
    `Confidence: **${knowledgeResult.confidence}**.`,
    "I listed the most relevant excerpts in **Sources Used** below.",
  ].join("\n");
}

function buildAssistantText(args: {
  prompt: string;
  agent: string;
  riskLevel: RiskLevel | null;
  sqlResult: SqlResultPayload | null;
  knowledgeResult: KnowledgeResultPayload | null;
  actionProposal: ActionProposalPayload | null;
  approvalCreated: boolean;
  tenantContext: TenantContextSummary | null;
}) {
  if (args.actionProposal) {
    return [
      `I drafted a governed action proposal through **${args.agent}**.`,
      "Review the **Proposed Action** card to simulate impact and execute safely.",
      "",
      `Risk context: **${args.actionProposal.riskLevel}**`,
      "",
      `> Request: ${args.prompt}`,
    ].join("\n");
  }

  if (args.approvalCreated) {
    return [
      `This request has been routed through **${args.agent}** and requires approval before execution.`,
      "",
      `Risk context: **${args.riskLevel ?? "HIGH"}**`,
      "",
      `> Request: ${args.prompt}`,
    ].join("\n");
  }

  if (args.knowledgeResult && args.sqlResult) {
    return [
      buildKnowledgeAnswer(args.knowledgeResult),
      "",
      "I also attached structured SQL output in the query result card.",
      args.riskLevel ? `Risk context: **${args.riskLevel}**` : "Risk context: no privileged action detected",
      "",
      `> Request: ${args.prompt}`,
    ].join("\n");
  }

  if (args.knowledgeResult) {
    return [
      buildKnowledgeAnswer(args.knowledgeResult),
      args.riskLevel ? `Risk context: **${args.riskLevel}**` : "Risk context: no privileged action detected",
      "",
      `> Request: ${args.prompt}`,
    ].join("\n");
  }

  if (args.sqlResult?.error) {
    return [
      `I attempted a guarded SQL execution through **${args.agent}**, but it failed.`,
      "Review the error card and retry with a refined query.",
      "",
      `> Request: ${args.prompt}`,
    ].join("\n");
  }

  if (args.sqlResult) {
    return [
      `I executed a guarded SQL query through **${args.agent}** and attached the result card.`,
      args.riskLevel ? `Risk context: **${args.riskLevel}**` : "Risk context: no privileged action detected",
      "",
      `> Request: ${args.prompt}`,
    ].join("\n");
  }

  if (args.tenantContext) {
    return buildTenantContextAnswer(args.prompt, args.tenantContext);
  }

  return [
    `I processed this through **${args.agent}**.`,
    "No SQL/data source execution was needed for this request.",
    "",
    `> Request: ${args.prompt}`,
  ].join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let payload: ChatExecuteRequest;
  try {
    payload = (await req.json()) as ChatExecuteRequest;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const isRetryRequest = Boolean(payload.retryRunId || payload.retrySql);
  const sessionId = payload.sessionId ? String(payload.sessionId) : null;
  const retryRunId = payload.retryRunId ? String(payload.retryRunId) : null;
  const retrySql = payload.retrySql ? String(payload.retrySql) : null;
  const retryError = payload.retryError ? String(payload.retryError) : null;

  let prompt = String(payload.prompt ?? "").trim();
  if (!prompt && isRetryRequest) {
    prompt = "Retry failed SQL execution";
  }

  if (!prompt) return errorResponse(400, "prompt is required");

  const { data: tenantId, error: tenantError } = await auth.supabase.rpc("get_user_tenant_id");
  if (tenantError || !tenantId) {
    return errorResponse(400, "Could not resolve tenant context", tenantError?.message ?? null);
  }

  let agent = await detectAgent(prompt, auth.supabase, tenantId);
  const detectedRiskLevel = detectRisk(prompt);
  const agentStudioRequested = !isRetryRequest && isAgentStudioPrompt(prompt);
  const actionRequested = !isRetryRequest && !agentStudioRequested && isActionPrompt(prompt);
  const riskLevel = detectedRiskLevel ?? (actionRequested ? "MEDIUM" : null);
  const workspaceContextRequested = !isRetryRequest && !actionRequested && !agentStudioRequested && isWorkspaceContextPrompt(prompt);
  const knowledgeRequested = !isRetryRequest && !actionRequested && !agentStudioRequested && isKnowledgePrompt(prompt);
  const sqlRequested = !actionRequested && !agentStudioRequested && (isRetryRequest || isSqlPrompt(prompt));
  const destructive = hasDestructiveIntent(retrySql ?? prompt);

  let approvalCreated = false;
  let approvalRef: string | null = null;
  let approvalRequiredApprovals = 1;
  let approvalPendingApprovals = 0;
  let approvalPrimaryApproverName: string | null = null;
  let sqlResult: SqlResultPayload | null = null;
  let knowledgeResult: KnowledgeResultPayload | null = null;
  let actionProposal: ActionProposalPayload | null = null;
  let studioAssistant: string | null = null;
  let retrievalMeta: RetrievalMeta | null = null;
  let tenantContext: TenantContextSummary | null = null;
  const toolRuns: ToolRun[] = [];

  let policyDecision: PolicyDecision = {
    allow: true,
    approvalRequired: false,
    reason: "Policy engine unavailable, defaulting to read-safe path",
    matchedRule: {},
  };

  const { data: policyRows, error: policyError } = await auth.supabase.rpc("evaluate_action_policy", {
    p_resource: "chat_request",
    p_action: isRetryRequest
      ? "retry_sql"
      : agentStudioRequested
        ? "agent_build"
      : actionRequested
        ? "governed_action"
        : knowledgeRequested && sqlRequested
          ? "hybrid_query"
          : sqlRequested
            ? "sql_query"
            : "knowledge_query",
    p_risk_level: (riskLevel ?? "LOW").toLowerCase(),
    p_requires_write: destructive,
  });

  if (!policyError && policyRows?.[0]) {
    const row = policyRows[0] as Record<string, unknown>;
    policyDecision = {
      allow: Boolean(row.allow),
      approvalRequired: Boolean(row.approval_required),
      reason: String(row.reason ?? ""),
      matchedRule:
        row.matched_rule && typeof row.matched_rule === "object"
          ? (row.matched_rule as Record<string, unknown>)
          : {},
    };
  }

  if (!actionRequested && (destructive || policyDecision.approvalRequired || !policyDecision.allow)) {
    const { data: approvalRows, error: approvalError } = await auth.supabase.rpc("create_approval_request", {
      p_action: "chat.destructive_request",
      p_resource: "chat_sql_execution",
      p_risk_level: "critical",
      p_params: { prompt, retryRunId, retrySql, policyDecision },
      p_simulation_preview: { prompt, retryRunId, retrySql },
      p_action_summary: "Destructive request from chat",
      p_requested_by: auth.user.id,
      p_tenant_id: tenantId,
    });

    approvalCreated = true;
    if (approvalError) {
      policyDecision = {
        ...policyDecision,
        allow: false,
        approvalRequired: true,
        reason: approvalError.message || "Approval creation failed. Configure Accountable reviewers in RACI.",
      };
    } else {
      const approvalRow = Array.isArray(approvalRows) ? (approvalRows[0] as Record<string, unknown> | undefined) : undefined;
      approvalRef = approvalRow?.id ? String(approvalRow.id) : null;
      approvalRequiredApprovals = Number(approvalRow?.required_approvals ?? 1);
      approvalPendingApprovals = Number(approvalRow?.pending_approvals ?? approvalRequiredApprovals);
      const approvers = Array.isArray(approvalRow?.approvers)
        ? (approvalRow.approvers as Array<Record<string, unknown>>)
        : [];
      approvalPrimaryApproverName = approvers[0]?.name ? String(approvers[0].name) : null;
    }
  }

  if (actionRequested) {
    const { data: raciRows } = await auth.supabase.rpc("resolve_user_raci_context", {
      p_resource: "chat_action_execution",
      p_action: "execute",
      p_tenant_id: tenantId,
      p_user_id: auth.user.id,
    });

    const raciRow = (raciRows?.[0] ?? {}) as Record<string, unknown>;
    const profileRole = String(raciRow.profile_role ?? "member").toLowerCase();
    const effectiveRoles = toStringList(raciRow.effective_roles);
    const matchedRoles = toStringList(raciRow.matched_roles);
    const raciRole = mapRaciTypeToRole(raciRow.matched_raci_type);
    const userRoleLabel = matchedRoles[0] ?? effectiveRoles[0] ?? profileRole;

    const requiresApproval =
      riskLevel === "CRITICAL" ||
      raciRole !== "Responsible" ||
      policyDecision.approvalRequired ||
      !policyDecision.allow;

    actionProposal = buildActionProposal({
      prompt,
      riskLevel: riskLevel ?? "MEDIUM",
      raciRole,
      userRoleLabel,
      approvalRequired: requiresApproval,
      approvalRef,
      requiredApprovals: approvalRef ? approvalRequiredApprovals : riskLevel === "CRITICAL" ? 2 : 1,
      pendingApprovals: approvalRef ? approvalPendingApprovals : undefined,
    });
    if (actionProposal.approval.status === "pending" && approvalPrimaryApproverName) {
      actionProposal.approval.approverName = approvalPrimaryApproverName;
    }

    if (sessionId) {
      const { data: actionRow } = await auth.supabase
        .from("agent_action_runs")
        .insert({
          tenant_id: tenantId,
          session_id: sessionId,
          requested_by: auth.user.id,
          resource: "chat_action_execution",
          action: "proposal",
          params: { prompt },
          policy_decision: policyDecision,
          approval_request_id: null,
          status: requiresApproval ? "blocked" : "pending",
          action_summary: actionProposal.summary,
          action_payload: actionProposal,
          simulation_preview: actionProposal.simulation,
        })
        .select("id")
        .single();

      if (actionRow?.id) {
        actionProposal = { ...actionProposal, runId: String(actionRow.id) };
        await auth.supabase
          .from("agent_action_runs")
          .update({
            action_payload: actionProposal,
          })
          .eq("id", String(actionRow.id));
      }
    }

    toolRuns.push({
      tool: "action_proposal",
      status: "success",
      latencyMs: null,
      meta: {
        requiresApproval,
        riskLevel: actionProposal.riskLevel,
        raciRole: actionProposal.raci.role,
      },
    });
  }

  if (workspaceContextRequested || (!knowledgeRequested && !sqlRequested && !actionRequested && !agentStudioRequested)) {
    tenantContext = await loadTenantContextSummary(auth.supabase, tenantId);
    if (tenantContext) {
      toolRuns.push({
        tool: "workspace_context",
        status: "success",
        latencyMs: null,
        meta: {
          totalConnections: tenantContext.totalConnections,
          activeConnections: tenantContext.activeConnections,
          readyAgents: tenantContext.readyAgents,
          indexedDocuments: tenantContext.indexedDocuments,
          pendingApprovals: tenantContext.pendingApprovals,
        },
      });
    }
  }

  if (agentStudioRequested) {
    if (approvalCreated || policyDecision.approvalRequired || !policyDecision.allow) {
      toolRuns.push({
        tool: "agent_studio",
        status: "blocked",
        latencyMs: null,
        meta: {
          approvalRequired: true,
          approvalRef,
          reason: policyDecision.reason,
        },
      });

      studioAssistant = [
        "This custom-agent request is policy-gated and cannot run yet.",
        "",
        approvalRef
          ? `Approval request queued: **${approvalRef}**`
          : "Approval request queued. Please review in the Approvals queue.",
        "",
        `Policy reason: ${policyDecision.reason || "Approval required before agent provisioning."}`,
      ].join("\n");
    } else {
      const studioStartedAt = Date.now();
      const { data: createData, error: createError } = await auth.supabase.rpc(
        "create_custom_agent_from_chat_prompt",
        {
          p_prompt: prompt,
          p_session_id: sessionId,
        },
      );

      if (createError) {
        toolRuns.push({
          tool: "agent_studio",
          status: "error",
          latencyMs: Date.now() - studioStartedAt,
          meta: { error: createError.message },
        });
        studioAssistant = [
          "I could not create the custom agent from that prompt.",
          "",
          `Error: ${createError.message}`,
          "",
          "Try refining your request with domain + connected system details.",
        ].join("\n");
      } else {
        const payload = (createData ?? {}) as Record<string, unknown>;
        const provision = (payload.provision ?? {}) as Record<string, unknown>;
        const blueprint = (payload.blueprint ?? {}) as Record<string, unknown>;
        const questions = toStringArray(payload.questions).slice(0, 3);

        const createdAgentName =
          String(provision.name ?? blueprint.name ?? "Custom Copilot").trim() || "Custom Copilot";
        const createdAgentStatus = String(provision.status ?? "syncing").trim() || "syncing";
        const syncJobs = Number(provision.syncJobsQueued ?? 0);
        const embeddingJobs = Number(provision.embeddingJobsQueued ?? 0);

        agent = createdAgentName;

        studioAssistant = [
          `I created and deployed **${createdAgentName}** from your prompt.`,
          "",
          `Status: **${createdAgentStatus}**`,
          `Connector sync jobs queued: **${syncJobs}**`,
          `Embedding jobs queued: **${embeddingJobs}**`,
          "",
          "The agent is now bound to your tenant connections and will enforce existing RACI + guardrails.",
          questions.length > 0 ? "" : "",
          ...(questions.length > 0
            ? [
                "**To finalize behavior, confirm:**",
                ...questions.map((question, index) => `${index + 1}. ${question}`),
              ]
            : []),
        ].filter((line) => line.length > 0).join("\n");

        toolRuns.push({
          tool: "agent_studio",
          status: "success",
          latencyMs: Date.now() - studioStartedAt,
          meta: {
            agentId: provision.agentId ?? null,
            status: createdAgentStatus,
            syncJobsQueued: syncJobs,
            embeddingJobsQueued: embeddingJobs,
          },
        });
      }
    }
  }

  if (knowledgeRequested) {
    const retrievalStartedAt = Date.now();
    const queryEmbedding = await generateQueryEmbedding(prompt);
    const vectorWeight = queryEmbedding ? 0.65 : 0;
    const lexicalWeight = queryEmbedding ? 0.35 : 1;

    const { data, error } = await auth.supabase.rpc("search_knowledge_documents_hybrid", {
      p_query: prompt,
      p_limit: 5,
      p_query_embedding: queryEmbedding,
      p_vector_weight: vectorWeight,
      p_lexical_weight: lexicalWeight,
    });

    if (!error) {
      const sources = (data ?? []).slice(0, 5).map((row: Record<string, unknown>) => ({
        id: String(row.id),
        title: String(row.title ?? "Untitled source"),
        fileType: String(row.file_type ?? "txt"),
        sourceType: String(row.source_type ?? "upload"),
        relevance: Number(row.relevance ?? 0),
        excerpt: String(row.excerpt ?? "No indexed snippet available yet."),
        externalUrl: row.external_url ? String(row.external_url) : null,
        storagePath: row.storage_path ? String(row.storage_path) : null,
      }));

      const firstScore = (data?.[0] as Record<string, unknown> | undefined)?.score_breakdown;
      const topScore =
        firstScore && typeof firstScore === "object"
          ? Number((firstScore as Record<string, unknown>).hybrid ?? 0)
          : undefined;

      retrievalMeta = {
        strategy: queryEmbedding ? "hybrid" : "lexical",
        candidateCount: sources.length,
        vectorWeight,
        lexicalWeight,
        topScore: Number.isFinite(topScore) ? topScore : undefined,
      };

      knowledgeResult = {
        query: prompt,
        confidence: mapConfidence(sources.length),
        sources,
      };

      toolRuns.push({
        tool: "knowledge_search",
        status: "success",
        latencyMs: Date.now() - retrievalStartedAt,
        meta: {
          strategy: queryEmbedding ? "hybrid" : "lexical",
          sourceCount: sources.length,
          usedEmbedding: Boolean(queryEmbedding),
        },
      });

      if (sessionId) {
        const runId = await persistKnowledgeRun({
          supabase: auth.supabase,
          tenantId: String(tenantId),
          sessionId,
          requestedBy: auth.user.id,
          prompt,
          confidence: knowledgeResult.confidence,
          sources: knowledgeResult.sources,
        });

        if (runId) {
          knowledgeResult.runId = runId;
        }
      }
    } else {
      const { data: fallbackData, error: fallbackError } = await auth.supabase.rpc("search_knowledge_documents", {
        p_query: prompt,
        p_limit: 5,
      });
      if (!fallbackError) {
        const sources = (fallbackData ?? []).slice(0, 5).map((row: Record<string, unknown>) => ({
          id: String(row.id),
          title: String(row.title ?? "Untitled source"),
          fileType: String(row.file_type ?? "txt"),
          sourceType: String(row.source_type ?? "upload"),
          relevance: Number(row.relevance ?? 0),
          excerpt: String(row.excerpt ?? "No indexed snippet available yet."),
          externalUrl: row.external_url ? String(row.external_url) : null,
          storagePath: row.storage_path ? String(row.storage_path) : null,
        }));

        retrievalMeta = {
          strategy: "lexical",
          candidateCount: sources.length,
          vectorWeight: 0,
          lexicalWeight: 1,
          topScore: Number(sources[0]?.relevance ?? 0) / 100,
        };
        knowledgeResult = {
          query: prompt,
          confidence: mapConfidence(sources.length),
          sources,
        };

        toolRuns.push({
          tool: "knowledge_search",
          status: "success",
          latencyMs: Date.now() - retrievalStartedAt,
          meta: {
            strategy: "lexical",
            sourceCount: sources.length,
            fallback: true,
          },
        });
      } else {
        toolRuns.push({
          tool: "knowledge_search",
          status: "error",
          latencyMs: Date.now() - retrievalStartedAt,
          meta: { error: fallbackError.message },
        });
      }
    }
  }

  if (!approvalCreated && sqlRequested) {
    const fallback = fallbackSqlFromPrompt(prompt);
    const retryHints = [
      "Explain why the first query failed",
      "Optimize this query for performance",
      "Add a date filter for the last 30 days",
    ];

    let preferredConnectionId: string | null = null;
    let retryBaseSql = retrySql ?? null;
    let retryBaseError = retryError ?? null;

    if (retryRunId) {
      const { data: previousRun } = await auth.supabase
        .from("chat_sql_runs")
        .select("connection_id, sql_query, error")
        .eq("id", retryRunId)
        .limit(1)
        .maybeSingle();

      if (previousRun) {
        preferredConnectionId = previousRun.connection_id ? String(previousRun.connection_id) : null;
        retryBaseSql = retryBaseSql ?? String(previousRun.sql_query ?? "");
        retryBaseError = retryBaseError ?? (previousRun.error ? String(previousRun.error) : null);
      }
    }

    try {
      const connection = await pickConnectionIdForSql({
        supabase: auth.supabase,
        preferredConnectionId,
      });

      if (!connection) {
        sqlResult = {
          sql: "",
          executionMs: 0,
          columns: [],
          rows: [],
          explanation: "No active data connections are available yet.",
          followUps: ["Add a data connection", "Run onboarding data setup"],
          error: "No active connection available",
        };
        toolRuns.push({
          tool: "sql_query",
          status: "error",
          latencyMs: null,
          meta: { error: "No active connection available" },
        });
      } else {
        let sql = "";
        let explanation = fallback.explanation;
        let followUps = fallback.followUps;

        if (isRetryRequest) {
          const failedSql = sanitizeSql(retryBaseSql ?? fallback.sql);
          const llmFixed = await generateFixedSqlWithLlm({
            prompt,
            failedSql,
            errorMessage: retryBaseError,
          });
          const heuristic = heuristicFixSql(failedSql);
          sql = sanitizeSql(llmFixed ?? heuristic ?? fallback.sql);
          explanation = "Retried the query with corrected SQL and guardrail-safe execution.";
          followUps = retryHints;
        } else {
          const llmSql = await generateSqlWithLlm(prompt);
          sql = sanitizeSql(llmSql ?? fallback.sql);
          explanation = fallback.explanation;
          followUps = fallback.followUps;
        }

        sqlResult = await executeSql({
          supabase: auth.supabase,
          connectionId: connection.id,
          sql,
          explanation,
          followUps,
        });

        toolRuns.push({
          tool: "sql_query",
          status: sqlResult.error ? "error" : "success",
          latencyMs: sqlResult.executionMs,
          meta: {
            connectionId: connection.id,
            sql: sqlResult.sql,
            rowCount: sqlResult.rows.length,
            error: sqlResult.error ?? null,
          },
        });

        if (sessionId) {
          const runId = await persistSqlRun({
            supabase: auth.supabase,
            tenantId: String(tenantId),
            sessionId,
            requestedBy: auth.user.id,
            connectionId: connection.id,
            agent,
            prompt,
            sqlResult,
          });

          if (runId) {
            sqlResult.runId = runId;
          }
        }
      }
    } catch (error) {
      sqlResult = {
        sql: sanitizeSql(retryBaseSql ?? fallback.sql),
        executionMs: 0,
        columns: [],
        rows: [],
        explanation: "Connection lookup failed.",
        followUps: ["Verify your data connections", "Retry after refreshing"],
        error: error instanceof Error ? error.message : "Connection lookup failed",
      };
      toolRuns.push({
        tool: "sql_query",
        status: "error",
        latencyMs: null,
        meta: { error: sqlResult.error ?? "Connection lookup failed" },
      });
    }
  }

  const assistant = studioAssistant ?? buildAssistantText({
    prompt,
    agent,
    riskLevel,
    sqlResult,
    knowledgeResult,
    actionProposal,
    approvalCreated,
    tenantContext,
  });

  for (const run of toolRuns) {
    await persistToolRun({
      supabase: auth.supabase,
      tenantId: String(tenantId),
      sessionId,
      requestedBy: auth.user.id,
      agentName: agent,
      toolRun: run,
    });
  }

  if (sessionId && !actionRequested && (destructive || policyDecision.approvalRequired)) {
    await auth.supabase.from("agent_action_runs").insert({
      tenant_id: tenantId,
      session_id: sessionId,
      requested_by: auth.user.id,
      resource: "chat_sql_execution",
      action: isRetryRequest ? "retry" : "execute",
      params: { prompt, retryRunId, retrySql },
      policy_decision: policyDecision,
      approval_request_id: approvalRef,
      status: approvalCreated ? "blocked" : "pending",
      simulation_preview: {
        agent,
        riskLevel,
      },
    });
  }

  const usage = estimateUsage(prompt, assistant, knowledgeResult?.sources.length ?? 0, sqlResult?.rows.length ?? 0);

  return jsonResponse(200, {
    ok: true,
    sessionId,
    agent,
    riskLevel,
    assistant,
    sqlResult,
    knowledgeResult,
    actionProposal,
    approvalRequired: approvalCreated,
    approvalRef,
    toolRuns,
    retrievalMeta,
    policyDecision,
    usage,
  });
});
