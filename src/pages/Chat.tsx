import { type ChangeEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { differenceInCalendarDays, format } from "date-fns";
import Prism from "prismjs";
import "prismjs/components/prism-sql";
import "prismjs/themes/prism-tomorrow.css";
import { useSearchParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Bot,
  Camera,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Download,
  FileText,
  Hash,
  LineChart as LineChartIcon,
  Loader2,
  Mic,
  NotebookPen,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  PieChart as PieChartIcon,
  Plus,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Type,
  XCircle,
  Zap,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import SimulationPreview from "@/components/SimulationPreview";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { formatEdgeFunctionError } from "@/lib/edge-function-error";
import { invokeEdge } from "@/lib/edge-invoke";
import { supabase } from "@/integrations/supabase/client";
import type { Database as SupabaseDatabase } from "@/integrations/supabase/types";

type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type Operation = "run" | "cancel" | "request_approval" | "approve_execute" | "reject" | "undo" | "retry";
type ChatRole = "user" | "assistant";
type SessionGroup = "Today" | "Yesterday" | "This Week" | "Older";
type FeedbackValue = "up" | "down";
type ChartKind = "line" | "bar" | "pie";
type SortDirection = "asc" | "desc";
type SqlResultMode = "metric" | "table" | "chart" | "empty" | "error";
type SqlColumnType = "number" | "date" | "text";
type ConfidenceLevel = "High confidence" | "Medium confidence" | "Based on limited data";

type SqlResultPrimitive = string | number | null;
type SqlResultRow = Record<string, SqlResultPrimitive>;

type SqlResultColumn = {
  key: string;
  label: string;
  type?: SqlColumnType;
  pii?: boolean;
};

type SqlResultPayload = {
  sql: string;
  executionMs: number;
  columns: SqlResultColumn[];
  rows: SqlResultRow[];
  explanation: string;
  followUps: string[];
  runId?: string;
  error?: string;
  noResultsHint?: string;
};

type KnowledgeSource = {
  id: string;
  title: string;
  fileType: string;
  sourceType: string;
  relevance: number;
  excerpt: string;
  externalUrl: string | null;
  storagePath: string | null;
};

type KnowledgeResultPayload = {
  query: string;
  confidence: ConfidenceLevel;
  runId?: string;
  sources: KnowledgeSource[];
};

type ActionProposalState = "proposed" | "blocked" | "executed" | "failed" | "cancelled";
type ActionProposalApprovalStatus = "none" | "pending" | "approved" | "denied";
type ActionProposalRaciRole = "Responsible" | "Consulted" | "Accountable";

type ActionProposalPayload = {
  runId: string | null;
  riskLevel: RiskLevel;
  summary: string;
  raci: {
    userRole: string;
    role: ActionProposalRaciRole;
    roleStatus: string;
  };
  approval: {
    required: boolean;
    status: ActionProposalApprovalStatus;
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
    previewRows: Array<{
      field: string;
      before: string;
      after: string;
    }>;
  };
  state: {
    status: ActionProposalState;
    successMessage: string | null;
    errorMessage: string | null;
    undoExpiresAt: string | null;
    revertedAt: string | null;
  };
};

type ResolvedSqlResultColumn = {
  key: string;
  label: string;
  type: SqlColumnType;
  pii: boolean;
};

type SqlPresentation = {
  mode: SqlResultMode;
  metricKey?: string;
  xKey?: string;
  yKey?: string;
  defaultChart?: ChartKind;
};

type ChatSessionRow = Pick<
  SupabaseDatabase["public"]["Tables"]["chat_sessions"]["Row"],
  "id" | "title" | "created_at"
> & {
  updated_at?: string | null;
};
type ChatMessageRow = Pick<
  SupabaseDatabase["public"]["Tables"]["chat_messages"]["Row"],
  "id" | "session_id" | "role" | "content" | "created_at" | "risk_level" | "tool_used"
>;
type ChatSessionListRow =
  SupabaseDatabase["public"]["Functions"]["get_chat_sessions"]["Returns"][number];
type ChatContextSummaryRow =
  SupabaseDatabase["public"]["Functions"]["get_chat_context_summary"]["Returns"][number];
type ChatFeedbackMapRow =
  SupabaseDatabase["public"]["Functions"]["get_chat_feedback_map"]["Returns"][number];
type ConnectionRow = Pick<
  SupabaseDatabase["public"]["Tables"]["api_connections"]["Row"],
  "id" | "name" | "type" | "status"
>;
type SearchKnowledgeRow =
  SupabaseDatabase["public"]["Functions"]["search_knowledge_documents"]["Returns"][number];

type ChatSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  lastMessagePreview: string;
  messageCount: number;
};

type ChatMessage = {
  id: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  riskLevel: RiskLevel | null;
  agent: string | null;
  queryResult: SqlResultPayload | null;
  knowledgeResult: KnowledgeResultPayload | null;
  actionProposal: ActionProposalPayload | null;
};

type ChatExecuteResponse = {
  ok: boolean;
  assistant?: string;
  agent?: string;
  riskLevel?: string | null;
  sqlResult?: SqlResultPayload | null;
  knowledgeResult?: KnowledgeResultPayload | null;
  actionProposal?: ActionProposalPayload | null;
  approvalRequired?: boolean;
  approvalRef?: string | null;
  toolRuns?: Array<{
    tool: string;
    status: "success" | "error" | "blocked";
    latencyMs?: number | null;
    meta?: Record<string, unknown>;
  }>;
  retrievalMeta?: {
    strategy: "hybrid" | "lexical";
    candidateCount: number;
    vectorWeight: number;
    lexicalWeight: number;
    topScore?: number;
  } | null;
  policyDecision?: {
    allow: boolean;
    approvalRequired: boolean;
    reason: string;
    matchedRule: Record<string, unknown>;
  } | null;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    retrievalTokens: number;
    sqlTokens: number;
    totalTokens: number;
  } | null;
};

type ChatActionUpdateResponse = {
  ok: boolean;
  actionProposal?: ActionProposalPayload | null;
  error?: string | null;
};

type SpeechRecognitionAlternativeLike = {
  transcript: string;
};

type SpeechRecognitionResultLike = {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
};

type SpeechRecognitionResultListLike = {
  readonly length: number;
  [index: number]: SpeechRecognitionResultLike;
};

type SpeechRecognitionEventLike = Event & {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
};

type SpeechRecognitionErrorEventLike = Event & {
  readonly error?: string;
  readonly message?: string;
};

type SpeechRecognitionLike = EventTarget & {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const SESSION_GROUP_ORDER: SessionGroup[] = ["Today", "Yesterday", "This Week", "Older"];
const MAX_INPUT_HEIGHT = 112;
const SQL_RESULT_MARKER_REGEX = /<!--AEAR_SQL_RESULT:([^>]+)-->/;
const KNOWLEDGE_RESULT_MARKER_REGEX = /<!--AEAR_KNOWLEDGE_RESULT:([^>]+)-->/;
const ACTION_PROPOSAL_MARKER_REGEX = /<!--AEAR_ACTION_PROPOSAL:([^>]+)-->/;
const TABLE_PAGE_SIZE = 10;
const PII_COLUMN_REGEX = /(email|phone|mobile|ssn|tax|dob|birth|address|customer_name|full_name|name)$/i;
const CHART_COLORS = ["#7c3aed", "#06b6d4", "#22c55e", "#f59e0b", "#f43f5e", "#3b82f6"];
const ACCEPTED_DOCUMENT_EXTENSIONS = new Set(["pdf", "docx", "txt", "md", "png", "jpg", "jpeg", "webp"]);

function isMissingFunctionError(error: { code?: string | null; message?: string | null }) {
  const message = error.message?.toLowerCase() ?? "";
  return error.code === "PGRST202" || message.includes("could not find the function");
}

function sessionActivityTimestamp(session: ChatSession) {
  return new Date(session.lastMessageAt || session.updatedAt || session.createdAt).getTime();
}

function sortSessionsByActivity(sessionList: ChatSession[]) {
  return [...sessionList].sort((left, right) => sessionActivityTimestamp(right) - sessionActivityTimestamp(left));
}

function normalizeRisk(value: string | null): RiskLevel | null {
  if (!value) return null;
  const normalized = value.toUpperCase();
  if (normalized === "LOW" || normalized === "MEDIUM" || normalized === "HIGH" || normalized === "CRITICAL") {
    return normalized;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asTrimmedString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toSqlPrimitive(value: unknown): SqlResultPrimitive {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeFormatDateTime(value: string, pattern: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "--";
  return format(parsed, pattern);
}

function normalizeSqlResultPayload(value: unknown): SqlResultPayload | null {
  const row = asRecord(value);
  if (!row) return null;

  const columns = Array.isArray(row.columns)
    ? row.columns
        .map((column) => {
          const asColumn = asRecord(column);
          if (!asColumn) return null;
          const key = asTrimmedString(asColumn.key);
          if (!key) return null;
          const rawType = asTrimmedString(asColumn.type).toLowerCase();
          const type: SqlColumnType | undefined =
            rawType === "number" || rawType === "date" || rawType === "text"
              ? (rawType as SqlColumnType)
              : undefined;
          return {
            key,
            label: asTrimmedString(asColumn.label, key) || key,
            type,
            pii: Boolean(asColumn.pii),
          } satisfies SqlResultColumn;
        })
        .filter((column): column is SqlResultColumn => Boolean(column))
    : [];

  const rows = Array.isArray(row.rows)
    ? row.rows
        .map((resultRow) => {
          const asResultRow = asRecord(resultRow);
          if (!asResultRow) return null;
          const normalizedRow: SqlResultRow = {};
          Object.entries(asResultRow).forEach(([key, cellValue]) => {
            normalizedRow[key] = toSqlPrimitive(cellValue);
          });
          return normalizedRow;
        })
        .filter((resultRow): resultRow is SqlResultRow => Boolean(resultRow))
    : [];

  const followUps = Array.isArray(row.followUps)
    ? row.followUps
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];

  const error = asTrimmedString(row.error, "");
  const noResultsHint = asTrimmedString(row.noResultsHint, "");
  const runId = asTrimmedString(row.runId, "");

  return {
    sql: asTrimmedString(row.sql, ""),
    executionMs: Math.max(0, Math.floor(asNumber(row.executionMs, 0))),
    columns,
    rows,
    explanation: asTrimmedString(row.explanation, "Query executed."),
    followUps,
    runId: runId || undefined,
    error: error || undefined,
    noResultsHint: noResultsHint || undefined,
  };
}

function normalizeKnowledgeResultPayload(value: unknown): KnowledgeResultPayload | null {
  const row = asRecord(value);
  if (!row) return null;

  const sources = Array.isArray(row.sources)
    ? row.sources
        .map((source) => {
          const asSource = asRecord(source);
          if (!asSource) return null;
          const id = asTrimmedString(asSource.id);
          if (!id) return null;
          return {
            id,
            title: asTrimmedString(asSource.title, "Untitled source"),
            fileType: asTrimmedString(asSource.fileType, "txt"),
            sourceType: asTrimmedString(asSource.sourceType, "upload"),
            relevance: Math.max(0, Math.min(100, asNumber(asSource.relevance, 0))),
            excerpt: asTrimmedString(asSource.excerpt, "No indexed snippet available yet."),
            externalUrl: asTrimmedString(asSource.externalUrl, "") || null,
            storagePath: asTrimmedString(asSource.storagePath, "") || null,
          } satisfies KnowledgeSource;
        })
        .filter((source): source is KnowledgeSource => Boolean(source))
    : [];

  const rawConfidence = asTrimmedString(row.confidence, "");
  const confidence: ConfidenceLevel =
    rawConfidence === "High confidence" ||
    rawConfidence === "Medium confidence" ||
    rawConfidence === "Based on limited data"
      ? rawConfidence
      : mapConfidence(sources.length);

  const runId = asTrimmedString(row.runId, "");

  return {
    query: asTrimmedString(row.query),
    confidence,
    runId: runId || undefined,
    sources,
  };
}

function normalizeActionProposalPayload(value: unknown): ActionProposalPayload | null {
  const row = asRecord(value);
  if (!row) return null;

  const rawRisk = normalizeRisk(asTrimmedString(row.riskLevel).toUpperCase()) ?? "LOW";

  const rawRaci = asRecord(row.raci);
  const rawRole = asTrimmedString(rawRaci?.role, "Consulted");
  const role: ActionProposalRaciRole =
    rawRole === "Responsible" || rawRole === "Accountable" || rawRole === "Consulted"
      ? rawRole
      : "Consulted";

  const rawApproval = asRecord(row.approval);
  const rawApprovalStatus = asTrimmedString(rawApproval?.status, "none").toLowerCase();
  const approvalStatus: ActionProposalApprovalStatus =
    rawApprovalStatus === "pending" ||
    rawApprovalStatus === "approved" ||
    rawApprovalStatus === "denied" ||
    rawApprovalStatus === "none"
      ? (rawApprovalStatus as ActionProposalApprovalStatus)
      : "none";

  const rawSimulation = asRecord(row.simulation);
  const previewRows = Array.isArray(rawSimulation?.previewRows)
    ? rawSimulation.previewRows
        .map((previewRow) => {
          const asPreviewRow = asRecord(previewRow);
          if (!asPreviewRow) return null;
          const field = asTrimmedString(asPreviewRow.field);
          if (!field) return null;
          return {
            field,
            before: asTrimmedString(asPreviewRow.before, "-"),
            after: asTrimmedString(asPreviewRow.after, "-"),
          };
        })
        .filter((previewRow): previewRow is { field: string; before: string; after: string } => Boolean(previewRow))
    : [];

  const rawState = asRecord(row.state);
  const rawStateStatus = asTrimmedString(rawState?.status, "proposed");
  const stateStatus: ActionProposalState =
    rawStateStatus === "proposed" ||
    rawStateStatus === "blocked" ||
    rawStateStatus === "executed" ||
    rawStateStatus === "failed" ||
    rawStateStatus === "cancelled"
      ? rawStateStatus
      : "proposed";

  const summary = asTrimmedString(row.summary, "Action proposed");
  const runId = asTrimmedString(row.runId, "");

  return {
    runId: runId || null,
    riskLevel: rawRisk,
    summary,
    raci: {
      userRole: asTrimmedString(rawRaci?.userRole, "member"),
      role,
      roleStatus: asTrimmedString(rawRaci?.roleStatus, "Consulted - cannot execute"),
    },
    approval: {
      required: Boolean(rawApproval?.required),
      status: approvalStatus,
      requestId: asTrimmedString(rawApproval?.requestId, "") || null,
      approverName: asTrimmedString(rawApproval?.approverName, "") || null,
      requiredApprovals: Math.max(1, Math.floor(asNumber(rawApproval?.requiredApprovals, 1))),
      approvedCount: Math.max(0, Math.floor(asNumber(rawApproval?.approvedCount, 0))),
      rejectedCount: Math.max(0, Math.floor(asNumber(rawApproval?.rejectedCount, 0))),
      pendingApprovals: Math.max(0, Math.floor(asNumber(rawApproval?.pendingApprovals, 0))),
    },
    simulation: {
      impactSummary: asTrimmedString(rawSimulation?.impactSummary, "Dry run simulation available."),
      reversible: Boolean(rawSimulation?.reversible),
      recordCount: Math.max(0, Math.floor(asNumber(rawSimulation?.recordCount, 0))),
      previewRows,
    },
    state: {
      status: stateStatus,
      successMessage: asTrimmedString(rawState?.successMessage, "") || null,
      errorMessage: asTrimmedString(rawState?.errorMessage, "") || null,
      undoExpiresAt: asTrimmedString(rawState?.undoExpiresAt, "") || null,
      revertedAt: asTrimmedString(rawState?.revertedAt, "") || null,
    },
  };
}

function buildSessionTitle(input: string) {
  const clean = input.replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length > 54 ? `${clean.slice(0, 51)}...` : clean;
}

function toSessionGroup(createdAt: string): SessionGroup {
  const created = new Date(createdAt);
  if (!Number.isFinite(created.getTime())) return "Older";
  const diff = differenceInCalendarDays(new Date(), created);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff <= 7) return "This Week";
  return "Older";
}

function detectAgent(prompt: string) {
  if (!prompt.trim()) return "AEAR Core";
  return "AEAR Core";
}

function detectRisk(prompt: string): RiskLevel | null {
  const value = prompt.toLowerCase();
  if (/(drop|delete|remove|shutdown|terminate|wipe)/.test(value)) return "CRITICAL";
  if (/(approve|transfer|payment|invoice|write|publish)/.test(value)) return "HIGH";
  if (/(update|change|modify|sync|rerun)/.test(value)) return "MEDIUM";
  if (/(show|list|find|summarize|what|how|query)/.test(value)) return "LOW";
  return null;
}

function seededRange(seed: string, min: number, max: number) {
  let value = 0;
  for (let i = 0; i < seed.length; i += 1) {
    value = (value * 31 + seed.charCodeAt(i)) % 1_000_003;
  }
  return min + (value % (max - min + 1));
}

function inferColumnType(key: string, values: SqlResultPrimitive[]): SqlColumnType {
  if (/(date|day|month|year|time|at)$/i.test(key)) return "date";

  const nonNullValues = values.filter((value) => value !== null);
  if (nonNullValues.length === 0) return "text";

  const numberLike = nonNullValues.every((value) =>
    typeof value === "number" || (!Number.isNaN(Number(value)) && value !== ""),
  );
  if (numberLike) return "number";

  const dateLike = nonNullValues.every((value) => {
    if (typeof value !== "string") return false;
    return !Number.isNaN(Date.parse(value));
  });

  return dateLike ? "date" : "text";
}

function resolveColumns(result: SqlResultPayload): ResolvedSqlResultColumn[] {
  const safeColumns = Array.isArray(result.columns) ? result.columns : [];
  const safeRows = Array.isArray(result.rows) ? result.rows : [];
  const keys = safeColumns.length > 0 ? safeColumns.map((column) => column.key) : Object.keys(safeRows[0] ?? {});

  return keys.map((key) => {
    const existing = safeColumns.find((column) => column.key === key);
    const values = safeRows.map((row) => row[key] ?? null);
    return {
      key,
      label: existing?.label ?? key,
      type: existing?.type ?? inferColumnType(key, values),
      pii: existing?.pii ?? PII_COLUMN_REGEX.test(key),
    };
  });
}

function getSqlPresentation(result: SqlResultPayload, columns: ResolvedSqlResultColumn[]): SqlPresentation {
  if (result.error) return { mode: "error" };
  if (result.rows.length === 0) return { mode: "empty" };
  if (columns.length === 1 && result.rows.length === 1) {
    return { mode: "metric", metricKey: columns[0]?.key };
  }

  const numericColumn = columns.find((column) => column.type === "number");
  const dateColumn = columns.find((column) => column.type === "date");
  const textColumn = columns.find((column) => column.type === "text" && !column.pii);

  if (dateColumn && numericColumn) {
    return {
      mode: "chart",
      xKey: dateColumn.key,
      yKey: numericColumn.key,
      defaultChart: "line",
    };
  }

  if (textColumn && numericColumn) {
    return {
      mode: "chart",
      xKey: textColumn.key,
      yKey: numericColumn.key,
      defaultChart: "bar",
    };
  }

  if (columns.length <= 2 && result.rows.length > 1) return { mode: "table" };
  if (columns.length > 10) return { mode: "table" };
  return { mode: "table" };
}

function appendToolPayloads(
  content: string,
  payloads: {
    sqlResult: SqlResultPayload | null;
    knowledgeResult: KnowledgeResultPayload | null;
    actionProposal: ActionProposalPayload | null;
  },
) {
  let next = content;
  if (payloads.sqlResult) {
    const serialized = encodeURIComponent(JSON.stringify(payloads.sqlResult));
    next = `${next}\n\n<!--AEAR_SQL_RESULT:${serialized}-->`;
  }
  if (payloads.knowledgeResult) {
    const serialized = encodeURIComponent(JSON.stringify(payloads.knowledgeResult));
    next = `${next}\n\n<!--AEAR_KNOWLEDGE_RESULT:${serialized}-->`;
  }
  if (payloads.actionProposal) {
    const serialized = encodeURIComponent(JSON.stringify(payloads.actionProposal));
    next = `${next}\n\n<!--AEAR_ACTION_PROPOSAL:${serialized}-->`;
  }
  return next;
}

function extractToolPayloads(content: string): {
  cleanContent: string;
  sqlResult: SqlResultPayload | null;
  knowledgeResult: KnowledgeResultPayload | null;
  actionProposal: ActionProposalPayload | null;
} {
  let cleanContent = content;
  let sqlResult: SqlResultPayload | null = null;
  let knowledgeResult: KnowledgeResultPayload | null = null;
  let actionProposal: ActionProposalPayload | null = null;

  const sqlMatch = cleanContent.match(SQL_RESULT_MARKER_REGEX);
  if (sqlMatch) {
    try {
      const decoded = decodeURIComponent(sqlMatch[1]);
      sqlResult = normalizeSqlResultPayload(JSON.parse(decoded));
    } catch {
      sqlResult = null;
    }
    cleanContent = cleanContent.replace(sqlMatch[0], "").trim();
  }

  const knowledgeMatch = cleanContent.match(KNOWLEDGE_RESULT_MARKER_REGEX);
  if (knowledgeMatch) {
    try {
      const decoded = decodeURIComponent(knowledgeMatch[1]);
      knowledgeResult = normalizeKnowledgeResultPayload(JSON.parse(decoded));
    } catch {
      knowledgeResult = null;
    }
    cleanContent = cleanContent.replace(knowledgeMatch[0], "").trim();
  }

  const actionMatch = cleanContent.match(ACTION_PROPOSAL_MARKER_REGEX);
  if (actionMatch) {
    try {
      const decoded = decodeURIComponent(actionMatch[1]);
      actionProposal = normalizeActionProposalPayload(JSON.parse(decoded));
    } catch {
      actionProposal = null;
    }
    cleanContent = cleanContent.replace(actionMatch[0], "").trim();
  }

  return { cleanContent, sqlResult, knowledgeResult, actionProposal };
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDocumentFileType(fileName: string, contentType?: string) {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (extension) return extension;

  if (contentType?.includes("pdf")) return "pdf";
  if (contentType?.includes("wordprocessingml.document")) return "docx";
  if (contentType?.includes("markdown")) return "md";
  if (contentType?.includes("image/png")) return "png";
  if (contentType?.includes("image/jpeg")) return "jpg";
  if (contentType?.includes("image/webp")) return "webp";
  return "txt";
}

function describeUploadError(error: unknown) {
  const fallback = error instanceof Error ? error.message : "Please try again.";
  const message = fallback.toLowerCase();

  if (message.includes("mime type") && message.includes("not supported")) {
    return "Image uploads are blocked by current bucket MIME rules. Allow PNG/JPG/WEBP on `knowledge-documents` and retry.";
  }
  if (message.includes("jwt") || message.includes("session") || message.includes("authorization")) {
    return "Your session token was rejected during upload. Sign out/in and retry.";
  }
  if (message.includes("row-level security") || message.includes("policy")) {
    return "Upload permission denied by storage policy. Confirm your tenant folder and auth session.";
  }
  return fallback;
}

function sourceIconForType(sourceType: string, fileType: string) {
  if (sourceType === "notion") return NotebookPen;
  if (sourceType === "google_doc") return FileText;
  if (fileType === "pdf") return FileText;
  return FileText;
}

function confidenceClass(confidence: ConfidenceLevel) {
  if (confidence === "High confidence") return "bg-emerald-100 text-emerald-700";
  if (confidence === "Medium confidence") return "bg-amber-100 text-amber-700";
  return "bg-slate-100 text-slate-700";
}

function toNumeric(value: SqlResultPrimitive) {
  if (value === null) return Number.NaN;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function formatCell(value: SqlResultPrimitive, type: SqlColumnType) {
  if (value === null) return "-";
  if (type === "number") {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return String(value);
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(numeric);
  }
  if (type === "date") {
    const parsed = new Date(String(value));
    if (Number.isNaN(parsed.getTime())) return String(value);
    return format(parsed, "MMM d, yyyy");
  }
  return String(value);
}

function buildCsv(rows: SqlResultRow[], columns: ResolvedSqlResultColumn[]) {
  const escape = (value: SqlResultPrimitive) => {
    const text = value === null ? "" : String(value);
    if (text.includes(",") || text.includes("\"") || text.includes("\n")) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const header = columns.map((column) => escape(column.label)).join(",");
  const body = rows
    .map((row) => columns.map((column) => escape(row[column.key] ?? null)).join(","))
    .join("\n");

  return `${header}\n${body}`;
}

function downloadTextFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function buildKnowledgeAnswer(result: KnowledgeResultPayload) {
  if (result.sources.length === 0) {
    return [
      "I searched your knowledge base but found no relevant documents.",
      "",
      "Try uploading documents or connecting a knowledge source.",
    ].join("\n");
  }

  const citations = result.sources
    .slice(0, 5)
    .map((source, index) => `[${index + 1}](#source-${source.id})`)
    .join(" ");

  return [
    `I found relevant context in your knowledge base ${citations}.`,
    "",
    `Confidence: **${result.confidence}**.`,
    "I listed the most relevant excerpts in **Sources Used** below.",
  ].join("\n");
}

function buildAssistantReply(
  prompt: string,
  agent: string,
  risk: RiskLevel | null,
  queryResult: SqlResultPayload | null,
  knowledgeResult: KnowledgeResultPayload | null,
) {
  if (knowledgeResult && queryResult) {
    return [
      buildKnowledgeAnswer(knowledgeResult),
      "",
      "I also attached structured SQL output in the query result card.",
      risk ? `Risk context: **${risk}**` : "Risk context: no privileged action detected",
      "",
      `> Request: ${prompt}`,
    ].join("\n");
  }

  if (knowledgeResult) {
    return [
      buildKnowledgeAnswer(knowledgeResult),
      "",
      risk ? `Risk context: **${risk}**` : "Risk context: no privileged action detected",
      "",
      `> Request: ${prompt}`,
    ].join("\n");
  }

  if (queryResult?.error) {
    return [
      `I ran a SQL attempt through **${agent}** and it failed validation.`,
      "",
      "I attached the error details below with a retry option.",
      risk ? `Risk context: **${risk}**` : "Risk context: no privileged action detected",
      "",
      `> Request: ${prompt}`,
    ].join("\n");
  }

  if (queryResult && queryResult.rows.length === 0) {
    return [
      `I executed a SQL query through **${agent}**.`,
      "",
      "The query returned no records right now. Review the suggestion in the result card.",
      risk ? `Risk context: **${risk}**` : "Risk context: no privileged action detected",
      "",
      `> Request: ${prompt}`,
    ].join("\n");
  }

  if (queryResult) {
    return [
      `I executed a SQL query through **${agent}** and attached structured results below.`,
      "",
      risk ? `Risk context: **${risk}**` : "Risk context: no privileged action detected",
      "",
      `> Request: ${prompt}`,
    ].join("\n");
  }

  return [
    `I can help with this through **${agent}**.`,
    "",
    "### Proposed execution",
    "- I will query connected data sources and align with active RACI rules.",
    "- I will return a concise summary and suggested next action.",
    risk ? `- Risk assessment: **${risk}**` : "- Risk assessment: no privileged action detected",
    "",
    `> Request: ${prompt}`,
  ].join("\n");
}

function isKnowledgePrompt(prompt: string) {
  return /(document|documents|knowledge|policy|handbook|playbook|guide|notion|google doc|file|pdf|txt|docx|source)/i.test(
    prompt,
  );
}

function mapConfidence(resultCount: number): ConfidenceLevel {
  if (resultCount >= 3) return "High confidence";
  if (resultCount >= 1) return "Medium confidence";
  return "Based on limited data";
}

function buildKnowledgePayloadFromRows(prompt: string, rows: SearchKnowledgeRow[]): KnowledgeResultPayload {
  const sources: KnowledgeSource[] = rows.slice(0, 5).map((row) => ({
    id: row.id,
    title: row.title,
    fileType: row.file_type,
    sourceType: row.source_type,
    relevance: Number(row.relevance ?? 0),
    excerpt: row.excerpt,
    externalUrl: row.external_url,
    storagePath: row.storage_path,
  }));

  return {
    query: prompt,
    confidence: mapConfidence(sources.length),
    sources,
  };
}

function generateQueryResultFromPrompt(prompt: string): SqlResultPayload | null {
  const input = prompt.toLowerCase();
  const queryLike = /(sql|query|database|table|revenue|invoice|customer|orders|count|total|list|show|trend)/.test(input);
  if (!queryLike) return null;

  const executionMs = seededRange(prompt, 24, 95);

  if (/(error|invalid|syntax)/.test(input)) {
    return {
      sql: "SELECT customer_id, SUM(amount) FROM invoices WHERE status = 'paid' GROUP BY customer_id ORDER amount DESC;",
      executionMs,
      columns: [],
      rows: [],
      error: "Syntax error near ORDER. Did you mean ORDER BY amount DESC?",
      explanation: "The query failed before execution because SQL syntax is invalid.",
      followUps: [
        "Fix SQL syntax and run again",
        "Use a safer grouped query template",
        "Return top 10 customers by paid amount",
      ],
    };
  }

  if (/(no result|no records|empty)/.test(input)) {
    return {
      sql: "SELECT * FROM invoices WHERE due_date < NOW() AND status = 'paid';",
      executionMs,
      columns: [
        { key: "invoice_id", label: "Invoice ID", type: "text" },
        { key: "due_date", label: "Due Date", type: "date" },
        { key: "status", label: "Status", type: "text" },
      ],
      rows: [],
      explanation: "No paid invoices are currently past due, which usually indicates collections are healthy.",
      noResultsHint: "Try widening the time range or using status = 'overdue'.",
      followUps: [
        "Show unpaid invoices due in next 7 days",
        "Show overdue invoices by customer",
        "Compare overdue count vs last month",
      ],
    };
  }

  if (/(total|count|how many|single value|kpi)/.test(input)) {
    return {
      sql: "SELECT SUM(amount) AS total_revenue_usd FROM invoices WHERE paid_at >= date_trunc('month', NOW());",
      executionMs,
      columns: [{ key: "total_revenue_usd", label: "Total Revenue (USD)", type: "number" }],
      rows: [{ total_revenue_usd: 428530 }],
      explanation: "Revenue this month is 428.53K USD from paid invoices only.",
      followUps: [
        "Break this down by region",
        "Compare to last month",
        "Show top 5 customers contributing to revenue",
      ],
    };
  }

  if (/(trend|daily|weekly|monthly|last 30|time series)/.test(input) || /revenue/.test(input)) {
    const rows = [
      { day: "2026-02-14", revenue_usd: 18200 },
      { day: "2026-02-15", revenue_usd: 17640 },
      { day: "2026-02-16", revenue_usd: 19120 },
      { day: "2026-02-17", revenue_usd: 20510 },
      { day: "2026-02-18", revenue_usd: 19830 },
      { day: "2026-02-19", revenue_usd: 22100 },
      { day: "2026-02-20", revenue_usd: 23240 },
    ];

    return {
      sql: "SELECT paid_at::date AS day, SUM(amount) AS revenue_usd FROM invoices WHERE paid_at >= NOW() - interval '7 days' GROUP BY 1 ORDER BY 1;",
      executionMs,
      columns: [
        { key: "day", label: "Day", type: "date" },
        { key: "revenue_usd", label: "Revenue (USD)", type: "number" },
      ],
      rows,
      explanation: "Revenue is trending upward over the past week with a stronger finish in the last two days.",
      followUps: [
        "Show this by product line",
        "Flag anomalies in this trend",
        "Forecast next 7 days revenue",
      ],
    };
  }

  if (/(segment|category|status|group by|distribution|overdue)/.test(input)) {
    const rows = [
      { status: "Paid", invoices: 1240, total_usd: 412300 },
      { status: "Overdue", invoices: 74, total_usd: 82100 },
      { status: "Pending", invoices: 191, total_usd: 102400 },
      { status: "Draft", invoices: 62, total_usd: 18050 },
    ];

    return {
      sql: "SELECT status, COUNT(*) AS invoices, SUM(amount) AS total_usd FROM invoices GROUP BY status ORDER BY total_usd DESC;",
      executionMs,
      columns: [
        { key: "status", label: "Invoice Status", type: "text" },
        { key: "invoices", label: "Invoice Count", type: "number" },
        { key: "total_usd", label: "Total (USD)", type: "number" },
      ],
      rows,
      explanation: "Most value is in paid invoices, while overdue balances are concentrated in a smaller bucket.",
      followUps: [
        "List top overdue customers",
        "Compare status distribution to last month",
        "Show aging buckets for overdue invoices",
      ],
    };
  }

  const rows = [
    {
      customer_name: "Acme Corp",
      email: "finance@acme.com",
      country: "US",
      amount_due: 18400,
      due_date: "2026-02-13",
      status: "Overdue",
    },
    {
      customer_name: "Globex Industries",
      email: "ap@globex.io",
      country: "UK",
      amount_due: 9200,
      due_date: "2026-02-15",
      status: "Overdue",
    },
    {
      customer_name: "Initech",
      email: "billing@initech.ai",
      country: "DE",
      amount_due: 7500,
      due_date: "2026-02-19",
      status: "Pending",
    },
  ];

  return {
    sql: "SELECT customer_name, email, country, amount_due, due_date, status FROM customer_invoices ORDER BY amount_due DESC LIMIT 25;",
    executionMs,
    columns: [
      { key: "customer_name", label: "Customer", type: "text", pii: true },
      { key: "email", label: "Email", type: "text", pii: true },
      { key: "country", label: "Country", type: "text" },
      { key: "amount_due", label: "Amount Due", type: "number" },
      { key: "due_date", label: "Due Date", type: "date" },
      { key: "status", label: "Status", type: "text" },
    ],
    rows,
    explanation: "A few high-value accounts are driving the current outstanding balance.",
    followUps: [
      "Show only invoices overdue by more than 15 days",
      "Draft reminders for top 3 overdue accounts",
      "Summarize overdue totals by country",
    ],
  };
}

function buildFixedQueryResult(failedResult: SqlResultPayload): SqlResultPayload {
  return {
    sql: "SELECT customer_id, SUM(amount) AS total_paid FROM invoices WHERE status = 'paid' GROUP BY customer_id ORDER BY total_paid DESC LIMIT 10;",
    executionMs: Math.max(22, failedResult.executionMs - 8),
    columns: [
      { key: "customer_id", label: "Customer ID", type: "text" },
      { key: "total_paid", label: "Total Paid", type: "number" },
    ],
    rows: [
      { customer_id: "CUST-1001", total_paid: 89200 },
      { customer_id: "CUST-1004", total_paid: 78440 },
      { customer_id: "CUST-1012", total_paid: 65910 },
      { customer_id: "CUST-1015", total_paid: 61120 },
    ],
    explanation: "The corrected query now returns the top paying customers by total paid amount.",
    followUps: [
      "Include company names for these customer IDs",
      "Add last payment date to this result",
      "Filter this list for current quarter only",
    ],
  };
}

function riskBadgeClass(risk: RiskLevel) {
  if (risk === "LOW") return "bg-emerald-100 text-emerald-700";
  if (risk === "MEDIUM") return "bg-amber-100 text-amber-700";
  if (risk === "HIGH") return "bg-orange-100 text-orange-700";
  return "bg-rose-100 text-rose-700";
}

function actionRiskBadgeClass(risk: RiskLevel) {
  if (risk === "LOW") return "bg-emerald-100 text-emerald-700";
  if (risk === "MEDIUM") return "bg-amber-100 text-amber-700";
  if (risk === "HIGH") return "bg-rose-100 text-rose-700";
  return "bg-red-950 text-red-100";
}

function RiskIcon({ risk }: { risk: RiskLevel }) {
  if (risk === "LOW") return <ShieldCheck className="h-3.5 w-3.5" />;
  if (risk === "MEDIUM") return <ShieldQuestion className="h-3.5 w-3.5" />;
  if (risk === "HIGH") return <ShieldAlert className="h-3.5 w-3.5" />;
  return <ShieldX className="h-3.5 w-3.5" />;
}

function AgentBadge({ agent }: { agent: string }) {
  return (
    <Badge className="border-0 bg-violet-100 text-violet-700">
      <Sparkles className="mr-1 h-3.5 w-3.5" />
      {agent}
    </Badge>
  );
}

type SqlResultCardProps = {
  result: SqlResultPayload;
  onFollowUp: (question: string) => void;
  onRetryWithFix: () => void;
};

function SQLResultCard({ result, onFollowUp, onRetryWithFix }: SqlResultCardProps) {
  const { toast } = useToast();
  const chartRef = useRef<HTMLDivElement | null>(null);

  const [showSql, setShowSql] = useState(false);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [page, setPage] = useState(1);

  const resolvedColumns = useMemo(() => resolveColumns(result), [result]);
  const presentation = useMemo(() => getSqlPresentation(result, resolvedColumns), [result, resolvedColumns]);
  const [chartType, setChartType] = useState<ChartKind>(presentation.defaultChart ?? "bar");

  useEffect(() => {
    setChartType(presentation.defaultChart ?? "bar");
  }, [presentation.defaultChart, result]);

  useEffect(() => {
    setPage(1);
  }, [result, sortKey, sortDirection]);

  const highlightedSql = useMemo(() => {
    const grammar = Prism.languages.sql;
    if (!grammar) return result.sql;
    return Prism.highlight(result.sql, grammar, "sql");
  }, [result.sql]);

  const sortedRows = useMemo(() => {
    if (!sortKey) return result.rows;

    const column = resolvedColumns.find((item) => item.key === sortKey);
    if (!column) return result.rows;

    const rows = [...result.rows];
    rows.sort((left, right) => {
      const leftValue = left[sortKey] ?? null;
      const rightValue = right[sortKey] ?? null;

      if (leftValue === null && rightValue === null) return 0;
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;

      let comparison = 0;
      if (column.type === "number") {
        comparison = toNumeric(leftValue) - toNumeric(rightValue);
      } else if (column.type === "date") {
        comparison = new Date(String(leftValue)).getTime() - new Date(String(rightValue)).getTime();
      } else {
        comparison = String(leftValue).localeCompare(String(rightValue));
      }

      return sortDirection === "asc" ? comparison : -comparison;
    });
    return rows;
  }, [resolvedColumns, result.rows, sortDirection, sortKey]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / TABLE_PAGE_SIZE));
  const paginatedRows = useMemo(() => {
    const start = (page - 1) * TABLE_PAGE_SIZE;
    return sortedRows.slice(start, start + TABLE_PAGE_SIZE);
  }, [page, sortedRows]);

  const chartData = useMemo(() => {
    if (!presentation.xKey || !presentation.yKey) return [];

    return sortedRows.map((row) => ({
      x: row[presentation.xKey ?? ""] ?? "",
      y: toNumeric(row[presentation.yKey ?? ""]),
    }));
  }, [presentation.xKey, presentation.yKey, sortedRows]);

  const toggleSort = (key: string) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDirection("asc");
      return;
    }
    setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
  };

  const handleExportCsv = () => {
    const csv = buildCsv(sortedRows, resolvedColumns);
    downloadTextFile("query-result.csv", csv, "text/csv;charset=utf-8");
  };

  const handleCopyCsv = async () => {
    const csv = buildCsv(sortedRows, resolvedColumns);
    try {
      await navigator.clipboard.writeText(csv);
      toast({
        title: "Copied",
        description: "CSV copied to clipboard.",
      });
    } catch {
      toast({
        title: "Copy failed",
        description: "Clipboard permission was denied.",
        variant: "destructive",
      });
    }
  };

  const handleDownloadChartPng = async () => {
    try {
      const svg = chartRef.current?.querySelector("svg");
      if (!svg) {
        toast({
          title: "Download failed",
          description: "Chart is not ready yet.",
          variant: "destructive",
        });
        return;
      }

      const serializer = new XMLSerializer();
      const source = serializer.serializeToString(svg);
      const svgBlob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(svgBlob);

      await new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          const width = svg.clientWidth || 900;
          const height = svg.clientHeight || 320;
          const canvas = document.createElement("canvas");
          canvas.width = width * 2;
          canvas.height = height * 2;

          const context = canvas.getContext("2d");
          if (!context) {
            reject(new Error("Canvas context unavailable"));
            return;
          }

          context.scale(2, 2);
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, width, height);
          context.drawImage(image, 0, 0, width, height);
          canvas.toBlob((blob) => {
            if (!blob) {
              reject(new Error("Unable to encode PNG"));
              return;
            }
            const pngUrl = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = pngUrl;
            link.download = "query-chart.png";
            link.click();
            URL.revokeObjectURL(pngUrl);
            resolve();
          }, "image/png");
        };
        image.onerror = () => reject(new Error("Could not render chart image"));
        image.src = url;
      });

      URL.revokeObjectURL(url);
    } catch (error) {
      toast({
        title: "Download failed",
        description: error instanceof Error ? error.message : "Could not export chart.",
        variant: "destructive",
      });
    }
  };

  const columnIcon = (column: ResolvedSqlResultColumn) => {
    if (column.type === "number") return <Hash className="h-3.5 w-3.5" />;
    if (column.type === "date") return <CalendarDays className="h-3.5 w-3.5" />;
    return <Type className="h-3.5 w-3.5" />;
  };

  const metricValue =
    presentation.mode === "metric" && presentation.metricKey
      ? result.rows[0]?.[presentation.metricKey] ?? null
      : null;

  const relatedQuestions = result.followUps.slice(0, 3);

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-slate-900">Query Result</p>
          <Badge className="border-0 bg-slate-200 text-slate-700">{result.executionMs}ms</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {presentation.mode === "table" && (
            <>
              <Button type="button" size="sm" variant="outline" onClick={handleExportCsv}>
                <Download className="h-3.5 w-3.5" />
                CSV
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void handleCopyCsv()}>
                <Copy className="h-3.5 w-3.5" />
                Copy
              </Button>
            </>
          )}

          {presentation.mode === "chart" && (
            <Button type="button" size="sm" variant="outline" onClick={() => void handleDownloadChartPng()}>
              <Download className="h-3.5 w-3.5" />
              Download PNG
            </Button>
          )}

          <Button type="button" size="sm" variant="outline" onClick={() => setShowSql((open) => !open)}>
            {showSql ? "Hide SQL" : "Show SQL"}
          </Button>
        </div>
      </div>

      {showSql && (
        <div className="border-b border-slate-200 bg-[#111827] p-3">
          <pre className="!m-0 !overflow-x-auto rounded-md !bg-transparent p-0 text-xs language-sql">
            <code className="language-sql" dangerouslySetInnerHTML={{ __html: highlightedSql }} />
          </pre>
        </div>
      )}

      <div className="space-y-3 p-3">
        {presentation.mode === "error" && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
            <p className="text-sm font-semibold text-rose-700">Query execution failed</p>
            <p className="mt-1 text-sm text-rose-600">{result.error}</p>
            <Button type="button" size="sm" className="mt-3 bg-rose-600 text-white hover:bg-rose-500" onClick={onRetryWithFix}>
              Retry with fix
            </Button>
          </div>
        )}

        {presentation.mode === "empty" && (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-center">
            <p className="text-sm font-semibold text-slate-800">No records found</p>
            <p className="mt-1 text-sm text-slate-500">{result.noResultsHint ?? "Try broader filters or a wider date range."}</p>
          </div>
        )}

        {presentation.mode === "metric" && (
          <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{resolvedColumns[0]?.label ?? "Result"}</p>
            <p className="mt-2 text-4xl font-bold tracking-tight text-slate-900">{formatCell(metricValue, "number")}</p>
          </div>
        )}

        {presentation.mode === "chart" && (
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant={chartType === "line" ? "default" : "outline"}
                  className={cn(chartType === "line" && "bg-violet-600 hover:bg-violet-500")}
                  onClick={() => setChartType("line")}
                >
                  <LineChartIcon className="h-3.5 w-3.5" />
                  Line
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={chartType === "bar" ? "default" : "outline"}
                  className={cn(chartType === "bar" && "bg-violet-600 hover:bg-violet-500")}
                  onClick={() => setChartType("bar")}
                >
                  <BarChart3 className="h-3.5 w-3.5" />
                  Bar
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={chartType === "pie" ? "default" : "outline"}
                  className={cn(chartType === "pie" && "bg-violet-600 hover:bg-violet-500")}
                  onClick={() => setChartType("pie")}
                >
                  <PieChartIcon className="h-3.5 w-3.5" />
                  Pie
                </Button>
              </div>
            </div>

            <div ref={chartRef} className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                {chartType === "line" ? (
                  <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="x" tick={{ fontSize: 11 }} stroke="#64748b" />
                    <YAxis tick={{ fontSize: 11 }} stroke="#64748b" />
                    <Tooltip />
                    <Line type="monotone" dataKey="y" stroke="#7c3aed" strokeWidth={2.2} dot={{ r: 2.5 }} />
                  </LineChart>
                ) : chartType === "bar" ? (
                  <BarChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="x" tick={{ fontSize: 11 }} stroke="#64748b" />
                    <YAxis tick={{ fontSize: 11 }} stroke="#64748b" />
                    <Tooltip />
                    <Bar dataKey="y" fill="#7c3aed" radius={[6, 6, 0, 0]} />
                  </BarChart>
                ) : (
                  <PieChart>
                    <Tooltip />
                    <Pie
                      data={chartData.slice(0, 12)}
                      dataKey="y"
                      nameKey="x"
                      innerRadius={42}
                      outerRadius={92}
                      paddingAngle={1}
                      label
                    >
                      {chartData.slice(0, 12).map((item, index) => (
                        <Cell key={`${item.x}-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                  </PieChart>
                )}
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {presentation.mode === "table" && (
          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-[680px] text-left text-xs lg:min-w-full">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <tr>
                    {resolvedColumns.map((column) => (
                      <th key={column.key} className="px-3 py-2.5 font-semibold">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-slate-200"
                          onClick={() => toggleSort(column.key)}
                        >
                          {columnIcon(column)}
                          {column.label}
                          {sortKey === column.key ? (
                            sortDirection === "asc" ? (
                              <ArrowUp className="h-3.5 w-3.5" />
                            ) : (
                              <ArrowDown className="h-3.5 w-3.5" />
                            )
                          ) : null}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paginatedRows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-b border-slate-100 align-top last:border-0">
                      {resolvedColumns.map((column) => (
                        <td key={`${rowIndex}-${column.key}`} className="px-3 py-2.5 text-slate-700">
                          {column.pii ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="blur-[4px] select-none">{formatCell(row[column.key] ?? null, column.type)}</span>
                              <Badge className="border-0 bg-slate-200 text-[10px] text-slate-600">Masked</Badge>
                            </span>
                          ) : (
                            formatCell(row[column.key] ?? null, column.type)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 px-3 py-2">
              <p className="text-xs text-slate-500">
                Page {page} of {totalPages}
              </p>
              <div className="flex items-center gap-1">
                <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                  <ChevronLeft className="h-3.5 w-3.5" />
                  Prev
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                >
                  Next
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">What this means</p>
          <p className="mt-1 text-sm text-slate-700">{result.explanation}</p>

          {relatedQuestions.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Related questions</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {relatedQuestions.map((question) => (
                  <button
                    key={question}
                    type="button"
                    onClick={() => onFollowUp(question)}
                    className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 transition-colors hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700"
                  >
                    {question}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type KnowledgeResultCardProps = {
  result: KnowledgeResultPayload;
  tenantId: string | null;
};

function KnowledgeResultCard({ result, tenantId }: KnowledgeResultCardProps) {
  const { toast } = useToast();
  const [openingSourceId, setOpeningSourceId] = useState<string | null>(null);

  const queryTerms = useMemo(
    () =>
      result.query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length > 2)
        .slice(0, 6),
    [result.query],
  );

  const renderExcerpt = (excerpt: string) => {
    const compactExcerpt = excerpt.replace(/\s+/g, " ").trim();
    if (queryTerms.length === 0) return compactExcerpt;

    const pattern = new RegExp(`(${queryTerms.map((term) => escapeRegExp(term)).join("|")})`, "ig");
    const parts = compactExcerpt.split(pattern);

    return parts.map((part, index) => {
      const lower = part.toLowerCase();
      const isMatch = queryTerms.some((term) => lower === term);
      if (!isMatch) return <span key={`${part}-${index}`}>{part}</span>;
      return (
        <mark key={`${part}-${index}`} className="rounded-sm bg-amber-100 px-0.5 text-amber-900">
          {part}
        </mark>
      );
    });
  };

  const openSource = async (source: KnowledgeSource) => {
    try {
      setOpeningSourceId(source.id);
      if (source.externalUrl) {
        window.open(source.externalUrl, "_blank", "noopener,noreferrer");
        return;
      }

      if (!source.storagePath || !tenantId) {
        throw new Error("No preview URL available for this source.");
      }

      const { data, error } = await supabase.storage
        .from("knowledge-documents")
        .createSignedUrl(source.storagePath, 5 * 60);

      if (error) throw error;
      if (!data?.signedUrl) throw new Error("Could not generate a source URL.");
      window.open(data.signedUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast({
        title: "Could not open source",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setOpeningSourceId(null);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">Sources Used</p>
        <Badge className={cn("border-0", confidenceClass(result.confidence))}>{result.confidence}</Badge>
      </div>

      {result.sources.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-slate-300 bg-white p-4 text-center">
          <p className="text-sm font-semibold text-slate-900">No relevant documents found in your knowledge base</p>
          <p className="mt-1 text-sm text-slate-500">
            Try uploading documents or connecting a knowledge source.
          </p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {result.sources.slice(0, 5).map((source, index) => {
            const SourceIcon = sourceIconForType(source.sourceType, source.fileType);
            const score = Math.max(0, Math.min(100, source.relevance));
            return (
              <article
                id={`source-${source.id}`}
                key={source.id}
                className="rounded-lg border border-slate-200 bg-white p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-violet-100 text-violet-700">
                      <SourceIcon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">
                        [{index + 1}] {source.title}
                      </p>
                      <p className="text-xs text-slate-500">
                        {source.sourceType === "google_doc" ? "Google Doc" : source.sourceType === "notion" ? "Notion" : source.fileType.toUpperCase()}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void openSource(source)}
                    className="shrink-0 text-xs font-medium text-violet-700 hover:text-violet-600"
                  >
                    {openingSourceId === source.id ? "Opening..." : "View source"}
                  </button>
                </div>

                <div className="mt-2">
                  <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500">
                    <span>Relevance</span>
                    <span>{score}%</span>
                  </div>
                  <div className="h-1.5 rounded bg-slate-200">
                    <div className="h-1.5 rounded bg-violet-600" style={{ width: `${score}%` }} />
                  </div>
                </div>

                <p className="mt-2 line-clamp-4 text-sm text-slate-700">{renderExcerpt(source.excerpt)}</p>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

type ActionProposalCardProps = {
  result: ActionProposalPayload;
  messageId: string;
  onProposalUpdate: (messageId: string, proposal: ActionProposalPayload) => Promise<void>;
};

function ActionProposalCard({ result, messageId, onProposalUpdate }: ActionProposalCardProps) {
  const { toast } = useToast();
  const [submittingOperation, setSubmittingOperation] = useState<Operation | null>(null);
  const requiredApprovals = Math.max(1, Math.floor(Number(result.approval.requiredApprovals ?? 1)));
  const approvedCount = Math.max(0, Math.floor(Number(result.approval.approvedCount ?? 0)));
  const pendingApprovals = Math.max(
    0,
    Math.floor(
      Number(
        result.approval.pendingApprovals ??
          (result.approval.status === "pending" ? Math.max(requiredApprovals - approvedCount, 0) : 0),
      ),
    ),
  );

  const canUndo =
    result.state.status === "executed" &&
    result.state.undoExpiresAt !== null &&
    new Date(result.state.undoExpiresAt).getTime() > Date.now() &&
    !result.state.revertedAt;

  const executeOperation = async (operation: Operation) => {
    if (!result.runId) {
      toast({
        title: "Action unavailable",
        description: "This proposal is missing a run id.",
        variant: "destructive",
      });
      return;
    }

    setSubmittingOperation(operation);
    try {
      const { data, error } = await invokeEdge("chat-action-update", {
        body: {
          actionRunId: result.runId,
          operation,
        },
      });
      if (error) throw error;

      const payload = (data ?? null) as ChatActionUpdateResponse | null;
      const normalizedProposal = normalizeActionProposalPayload(payload?.actionProposal ?? null);
      if (!normalizedProposal) {
        throw new Error(payload?.error ?? "Action update failed");
      }

      await onProposalUpdate(messageId, normalizedProposal);

      if (operation === "request_approval") {
        const approvalMeta =
          normalizedProposal.approval.status === "pending"
            ? ` ${Math.max(
                0,
                Number(normalizedProposal.approval.pendingApprovals ?? 0),
              )} approval(s) remaining.`
            : "";
        const target = normalizedProposal.approval.approverName
          ? `Approval request sent to ${normalizedProposal.approval.approverName}.${approvalMeta}`
          : `Approval request sent.${approvalMeta}`;
        toast({ title: "Request queued", description: target });
      }
    } catch (error) {
      const parsed = await formatEdgeFunctionError(error, { functionName: "chat-action-update" });
      toast({
        title: "Action failed",
        description: parsed,
        variant: "destructive",
      });
    } finally {
      setSubmittingOperation(null);
    }
  };

  const actionButtons = () => {
    if (result.state.status === "executed") {
      return (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canUndo && (
            <Button type="button" size="sm" variant="outline" onClick={() => void executeOperation("undo")} disabled={Boolean(submittingOperation)}>
              <RotateCcw className="h-3.5 w-3.5" />
              Undo (30s)
            </Button>
          )}
        </div>
      );
    }

    if (result.state.status === "failed") {
      return (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="border-0 bg-gradient-to-r from-violet-600 to-purple-600 text-white hover:from-violet-500 hover:to-purple-500"
            onClick={() => void executeOperation("retry")}
            disabled={Boolean(submittingOperation)}
          >
            Retry
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void executeOperation("cancel")} disabled={Boolean(submittingOperation)}>
            Cancel
          </Button>
        </div>
      );
    }

    if (result.riskLevel === "CRITICAL") {
      return (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="border-0 bg-blue-600 text-white hover:bg-blue-500"
            onClick={() => void executeOperation("request_approval")}
            disabled={Boolean(submittingOperation)}
          >
            Send for Approval
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void executeOperation("cancel")} disabled={Boolean(submittingOperation)}>
            Cancel
          </Button>
        </div>
      );
    }

    if (result.raci.role === "Accountable" && result.approval.status === "pending") {
      const approveLabel = pendingApprovals > 1 ? "Approve (Quorum)" : "Approve & Execute";
      return (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="border-0 bg-emerald-600 text-white hover:bg-emerald-500"
            onClick={() => void executeOperation("approve_execute")}
            disabled={Boolean(submittingOperation)}
          >
            {approveLabel}
          </Button>
          <Button type="button" size="sm" className="border-0 bg-rose-600 text-white hover:bg-rose-500" onClick={() => void executeOperation("reject")} disabled={Boolean(submittingOperation)}>
            Reject
          </Button>
        </div>
      );
    }

    if (result.raci.role === "Responsible" && result.approval.status !== "pending") {
      return (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="border-0 bg-gradient-to-r from-violet-600 to-purple-600 text-white hover:from-violet-500 hover:to-purple-500"
            onClick={() => void executeOperation("run")}
            disabled={Boolean(submittingOperation)}
          >
            Run Action
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void executeOperation("cancel")} disabled={Boolean(submittingOperation)}>
            Cancel
          </Button>
        </div>
      );
    }

    if (result.raci.role === "Consulted" || result.approval.status === "pending") {
      return (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="border-0 bg-blue-600 text-white hover:bg-blue-500"
            onClick={() => void executeOperation("request_approval")}
            disabled={Boolean(submittingOperation) || result.approval.status === "pending"}
          >
            Request Approval
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void executeOperation("cancel")} disabled={Boolean(submittingOperation)}>
            Cancel
          </Button>
        </div>
      );
    }

    if (result.approval.required && result.approval.status !== "pending") {
      return (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="border-0 bg-blue-600 text-white hover:bg-blue-500"
            onClick={() => void executeOperation("request_approval")}
            disabled={Boolean(submittingOperation)}
          >
            Request Approval
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void executeOperation("cancel")} disabled={Boolean(submittingOperation)}>
            Cancel
          </Button>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="relative mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="absolute inset-y-0 left-0 w-1 bg-violet-600" />

      {submittingOperation && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/75">
          <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm">
            <Loader2 className="h-4 w-4 animate-spin text-violet-600" />
            Processing action...
          </div>
        </div>
      )}

      <div className="space-y-3 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-violet-100 text-violet-700">
              <Zap className="h-4 w-4" />
            </span>
            <p className="text-sm font-semibold text-slate-900">Proposed Action</p>
          </div>
          <Badge className={cn("border-0", actionRiskBadgeClass(result.riskLevel))}>{result.riskLevel}</Badge>
        </div>

        <p className="text-sm text-slate-800">{result.summary}</p>

        <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 sm:grid-cols-2">
          <p>
            <span className="font-semibold text-slate-700">Your role:</span> {result.raci.roleStatus}
          </p>
          <p>
            <span className="font-semibold text-slate-700">Approval needed:</span>{" "}
            {result.approval.status === "pending"
              ? `Awaiting approvals (${approvedCount}/${requiredApprovals}).${
                  result.approval.approverName ? ` Next: ${result.approval.approverName}.` : ""
                }`
              : result.approval.required
                ? "Yes"
                : "No"}
          </p>
        </div>

        <SimulationPreview
          action={{
            action: result.summary,
            riskLevel: result.riskLevel,
            simulation: {
              ...result.simulation,
              beforeAfterRows: result.simulation.previewRows,
              recordsAffected: result.simulation.recordCount,
            },
          }}
        />

        {result.state.status === "executed" && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              {result.state.successMessage ?? "Action completed."}
            </div>
          </div>
        )}

        {result.state.status === "failed" && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            <div className="flex items-center gap-2">
              <XCircle className="h-4 w-4" />
              Action failed: {result.state.errorMessage ?? "Unknown error"}
            </div>
          </div>
        )}

        {result.approval.status === "pending" && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
            Approval request sent{result.approval.approverName ? ` to ${result.approval.approverName}` : ""}.
            {" "}
            {approvedCount}/{requiredApprovals} approvals recorded.
            {pendingApprovals > 0 ? ` ${pendingApprovals} remaining.` : ""}
          </div>
        )}

        {actionButtons()}
      </div>
    </div>
  );
}

export default function Chat() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const [tenantId, setTenantId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [composerValue, setComposerValue] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [contextCollapsed, setContextCollapsed] = useState(false);
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const [mobileContextOpen, setMobileContextOpen] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isStoppingVoice, setIsStoppingVoice] = useState(false);
  const [voiceInterimText, setVoiceInterimText] = useState("");
  const [feedbackByMessageId, setFeedbackByMessageId] = useState<Record<string, FeedbackValue>>({});
  const [remoteContextSummary, setRemoteContextSummary] = useState<{
    agents: string[];
    sourceIds: string[];
    sourceNames: string[];
    actionCount: number;
  } | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadingFileName, setUploadingFileName] = useState<string | null>(null);

  const uploadKnowledgeDocument = async (file: File) => {
    if (!tenantId || !user) {
      toast({
        title: "Upload unavailable",
        description: "Sign in and open a workspace before uploading.",
        variant: "destructive",
      });
      return;
    }

    const fileType = normalizeDocumentFileType(file.name, file.type);
    if (!ACCEPTED_DOCUMENT_EXTENSIONS.has(fileType)) {
      toast({
        title: "Unsupported file type",
        description: "Accepted formats: PDF, DOCX, TXT, MD, PNG, JPG, WEBP.",
        variant: "destructive",
      });
      return;
    }

    setUploadingFileName(file.name);
    setUploadProgress(8);

    const progressTimer = window.setInterval(() => {
      setUploadProgress((current) => {
        if (current === null) return null;
        if (current >= 92) return current;
        return current + 7;
      });
    }, 220);

    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storagePath = `${tenantId}/${Date.now()}-${safeName}`;

      const { error: storageError } = await supabase.storage
        .from("knowledge-documents")
        .upload(storagePath, file, {
          upsert: false,
          contentType: file.type || undefined,
        });
      if (storageError) throw storageError;

      const { data: metadataRow, error: metadataError } = await supabase
        .from("knowledge_documents")
        .insert({
          tenant_id: tenantId,
          uploaded_by: user.id,
          title: file.name.replace(/\.[^.]+$/, ""),
          file_name: file.name,
          file_type: fileType,
          source_type: "upload",
          storage_path: storagePath,
          status: "processing",
        })
        .select("id")
        .single();
      if (metadataError) throw metadataError;

      if (metadataRow?.id) {
        void invokeEdge("index-knowledge-document", {
          body: { documentId: metadataRow.id },
        });
      }

      setUploadProgress(100);
      toast({
        title: "Upload complete",
        description: "Document added to knowledge base. It'll be searchable in ~2 minutes.",
      });
    } catch (error) {
      toast({
        title: "Upload failed",
        description: describeUploadError(error),
        variant: "destructive",
      });
    } finally {
      window.clearInterval(progressTimer);
      window.setTimeout(() => {
        setUploadProgress(null);
        setUploadingFileName(null);
      }, 900);
    }
  };

  const mapRowToMessage = (row: ChatMessageRow): ChatMessage => {
    const parsed = extractToolPayloads(typeof row.content === "string" ? row.content : "");
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role === "user" ? "user" : "assistant",
      content: parsed.cleanContent,
      createdAt: row.created_at,
      riskLevel: normalizeRisk(row.risk_level),
      agent: row.role === "assistant" ? row.tool_used ?? "AEAR Core" : null,
      queryResult: parsed.sqlResult,
      knowledgeResult: parsed.knowledgeResult,
      actionProposal: parsed.actionProposal,
    };
  };

  const normalizeSession = (
    session: Partial<ChatSessionListRow> & {
      id: string;
      title?: string | null;
      created_at: string;
      updated_at?: string | null;
      last_message_at?: string | null;
      last_message_preview?: string | null;
      message_count?: number | null;
    },
  ): ChatSession => {
    const activityAt = session.last_message_at ?? session.updated_at ?? session.created_at;
    return {
      id: session.id,
      title: session.title?.trim() || "New chat",
      createdAt: session.created_at,
      updatedAt: session.updated_at ?? activityAt,
      lastMessageAt: activityAt,
      lastMessagePreview: session.last_message_preview ?? "",
      messageCount: Number(session.message_count ?? 0),
    };
  };

  const touchSessionActivity = (sessionId: string, at: string) => {
    setSessions((prev) => {
      const exists = prev.some((session) => session.id === sessionId);
      if (!exists) return prev;
      return sortSessionsByActivity(
        prev.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                updatedAt: at,
                lastMessageAt: at,
              }
            : session,
        ),
      );
    });
  };

  useEffect(() => {
    if (!user) return;
    let active = true;

    const loadChatShell = async () => {
      try {
        setLoadingSessions(true);
        const workspace = await ensureUserWorkspace(user);
        if (!active) return;
        setTenantId(workspace.tenantId);

        const [sessionsRpcResponse, connectionsResponse] = await Promise.all([
          supabase.rpc("get_chat_sessions", { p_limit: 120 }),
          supabase
            .from("api_connections")
            .select("id, name, type, status")
            .eq("tenant_id", workspace.tenantId)
            .order("created_at", { ascending: false })
            .limit(8),
        ]);

        let hydratedSessions: ChatSession[] = [];
        if (sessionsRpcResponse.error) {
          if (!isMissingFunctionError(sessionsRpcResponse.error)) {
            throw sessionsRpcResponse.error;
          }

          const fallbackResponse = await supabase
            .from("chat_sessions")
            .select("id, title, created_at")
            .eq("tenant_id", workspace.tenantId)
            .eq("user_id", user.id)
            .order("created_at", { ascending: false });
          if (fallbackResponse.error) throw fallbackResponse.error;

          hydratedSessions = ((fallbackResponse.data ?? []) as ChatSessionRow[]).map((session) =>
            normalizeSession({
              id: session.id,
              title: session.title,
              created_at: session.created_at,
            }),
          );
        } else {
          hydratedSessions = ((sessionsRpcResponse.data ?? []) as ChatSessionListRow[]).map((session) =>
            normalizeSession(session),
          );
        }

        if (connectionsResponse.error) throw connectionsResponse.error;
        const connectionRows = (connectionsResponse.data ?? []) as ConnectionRow[];

        if (!active) return;

        setConnections(connectionRows);
        setSessions(sortSessionsByActivity(hydratedSessions));
        setActiveSessionId((current) =>
          current && hydratedSessions.some((session) => session.id === current) ? current : hydratedSessions[0]?.id ?? null,
        );
      } catch (error) {
        if (!active) return;
        toast({
          title: "Could not load chat workspace",
          description: error instanceof Error ? error.message : "Please refresh and try again.",
          variant: "destructive",
        });
      } finally {
        if (active) setLoadingSessions(false);
      }
    };

    void loadChatShell();

    return () => {
      active = false;
    };
  }, [toast, user]);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    let active = true;

    const loadSessionMessages = async () => {
      try {
        setLoadingMessages(true);
        const { data, error } = await supabase
          .from("chat_messages")
          .select("id, session_id, role, content, created_at, risk_level, tool_used")
          .eq("session_id", activeSessionId)
          .order("created_at", { ascending: true });

        if (error) throw error;
        if (!active) return;

        const normalized = ((data ?? []) as ChatMessageRow[]).map((message) => mapRowToMessage(message));
        setMessages(normalized);
      } catch (error) {
        if (!active) return;
        toast({
          title: "Could not load messages",
          description: error instanceof Error ? error.message : "Please retry.",
          variant: "destructive",
        });
      } finally {
        if (active) setLoadingMessages(false);
      }
    };

    void loadSessionMessages();

    return () => {
      active = false;
    };
  }, [activeSessionId, toast]);

  useEffect(() => {
    if (!activeSessionId) {
      setFeedbackByMessageId({});
      return;
    }
    let active = true;
    setFeedbackByMessageId({});

    const loadFeedbackMap = async () => {
      const { data, error } = await supabase.rpc("get_chat_feedback_map", {
        p_session_id: activeSessionId,
      });

      if (error) {
        if (isMissingFunctionError(error)) return;
        throw error;
      }
      if (!active) return;

      const next = ((data ?? []) as ChatFeedbackMapRow[]).reduce<Record<string, FeedbackValue>>((acc, row) => {
        if (row.feedback === "up" || row.feedback === "down") {
          acc[row.message_id] = row.feedback;
        }
        return acc;
      }, {});

      setFeedbackByMessageId(next);
    };

    void loadFeedbackMap().catch((error) => {
      if (!active) return;
      toast({
        title: "Could not load feedback",
        description: error instanceof Error ? error.message : "Please retry.",
        variant: "destructive",
      });
    });

    return () => {
      active = false;
    };
  }, [activeSessionId, toast]);

  useEffect(() => {
    const query = searchParams.get("q");
    if (!query) return;
    setComposerValue(query);
    window.setTimeout(() => inputRef.current?.focus(), 30);
  }, [searchParams]);

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const nextHeight = Math.min(textarea.scrollHeight, MAX_INPUT_HEIGHT);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_INPUT_HEIGHT ? "auto" : "hidden";
  }, [composerValue]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, thinking, loadingMessages]);

  useEffect(() => {
    const onFocusChatInput = () => inputRef.current?.focus();
    window.addEventListener("aear:focus-chat-input", onFocusChatInput);
    return () => window.removeEventListener("aear:focus-chat-input", onFocusChatInput);
  }, []);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        // No-op: recognizer may already be stopped/disposed.
      }
    };
  }, []);

  const filteredSessions = useMemo(() => {
    const needle = sessionSearch.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) => {
      const timeLabel = safeFormatDateTime(session.lastMessageAt, "PPp").toLowerCase();
      const preview = session.lastMessagePreview.toLowerCase();
      return session.title.toLowerCase().includes(needle) || preview.includes(needle) || timeLabel.includes(needle);
    });
  }, [sessionSearch, sessions]);

  const groupedSessions = useMemo(() => {
    const grouped: Record<SessionGroup, ChatSession[]> = {
      Today: [],
      Yesterday: [],
      "This Week": [],
      Older: [],
    };

    filteredSessions.forEach((session) => {
      grouped[toSessionGroup(session.lastMessageAt)].push(session);
    });

    return grouped;
  }, [filteredSessions]);

  useEffect(() => {
    setMobileSessionsOpen(false);
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeSessionId) {
      setRemoteContextSummary(null);
      return;
    }
    let active = true;

    const loadRemoteContext = async () => {
      const { data, error } = await supabase.rpc("get_chat_context_summary", {
        p_session_id: activeSessionId,
      });
      if (error) {
        if (isMissingFunctionError(error)) {
          if (active) setRemoteContextSummary(null);
          return;
        }
        throw error;
      }
      if (!active) return;

      const row = ((data ?? [])[0] ?? null) as ChatContextSummaryRow | null;
      if (!row) {
        setRemoteContextSummary({
          agents: [],
          sourceIds: [],
          sourceNames: [],
          actionCount: 0,
        });
        return;
      }

      const normalizeStringList = (value: unknown) =>
        Array.isArray(value)
          ? value
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter((item) => item.length > 0)
          : [];

      setRemoteContextSummary({
        agents: normalizeStringList(row.active_agents),
        sourceIds: normalizeStringList(row.queried_source_ids),
        sourceNames: normalizeStringList(row.queried_source_names),
        actionCount: Math.max(0, Math.floor(Number(row.actions_taken ?? 0))),
      });
    };

    void loadRemoteContext().catch((error) => {
      if (!active) return;
      setRemoteContextSummary(null);
      toast({
        title: "Could not load conversation context",
        description: error instanceof Error ? error.message : "Please retry.",
        variant: "destructive",
      });
    });

    return () => {
      active = false;
    };
  }, [activeSessionId, messages.length, toast]);

  const localContextSummary = useMemo(() => {
    const fullText = messages.map((message) => message.content.toLowerCase()).join(" ");
    const matchedSources = connections.filter((connection) => fullText.includes(connection.name.toLowerCase()));
    const queriedSources = messages.some(
      (message) => message.queryResult !== null || message.knowledgeResult !== null,
    );
    const fallbackSources =
      matchedSources.length > 0 ? matchedSources : queriedSources ? connections.slice(0, 4) : [];
    const activeAgents = Array.from(
      new Set(
        messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.agent ?? "AEAR Core"),
      ),
    );

    return {
      agents: activeAgents.length > 0 ? activeAgents : messages.length > 0 ? ["AEAR Core"] : [],
      sources: fallbackSources,
      actionCount: messages.filter(
        (message) =>
          message.role === "assistant" &&
          (message.riskLevel || message.queryResult || message.knowledgeResult || message.actionProposal),
      ).length,
    };
  }, [connections, messages]);

  const contextSummary = useMemo(() => {
    if (!remoteContextSummary) return localContextSummary;

    const byId = remoteContextSummary.sourceIds
      .map((sourceId) => connections.find((connection) => connection.id === sourceId))
      .filter((connection): connection is ConnectionRow => Boolean(connection));

    const seenIds = new Set(byId.map((source) => source.id));
    const byName = remoteContextSummary.sourceNames
      .map((name) =>
        connections.find(
          (connection) =>
            !seenIds.has(connection.id) && connection.name.toLowerCase() === name.toLowerCase(),
        ),
      )
      .filter((connection): connection is ConnectionRow => Boolean(connection));

    const derivedSources = remoteContextSummary.sourceNames
      .filter(
        (name) =>
          !byId.some((source) => source.name.toLowerCase() === name.toLowerCase()) &&
          !byName.some((source) => source.name.toLowerCase() === name.toLowerCase()),
      )
      .map((name, index) => ({
        id: `derived-${index}-${name}`,
        name,
        type: "connection",
        status: "active",
      }));

    return {
      agents:
        remoteContextSummary.agents.length > 0
          ? remoteContextSummary.agents
          : localContextSummary.agents,
      sources: [...byId, ...byName, ...derivedSources],
      actionCount: remoteContextSummary.actionCount,
    };
  }, [connections, localContextSummary, remoteContextSummary]);

  const searchKnowledgeSources = async (prompt: string): Promise<KnowledgeResultPayload | null> => {
    if (!isKnowledgePrompt(prompt)) return null;

    const { data, error } = await supabase.rpc("search_knowledge_documents", {
      p_query: prompt,
      p_limit: 5,
    });

    if (error) {
      const functionMissing = isMissingFunctionError(error);
      if (!functionMissing) throw error;

      const fallback = await supabase
        .from("knowledge_documents")
        .select("id, title, file_type, source_type, external_url, storage_path, excerpt")
        .eq("tenant_id", tenantId ?? "")
        .eq("status", "indexed")
        .or(`title.ilike.%${prompt}%,excerpt.ilike.%${prompt}%`)
        .order("created_at", { ascending: false })
        .limit(5);

      if (fallback.error) throw fallback.error;

      const fallbackRows: SearchKnowledgeRow[] = (fallback.data ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        file_type: row.file_type,
        source_type: row.source_type,
        external_url: row.external_url,
        storage_path: row.storage_path,
        excerpt: row.excerpt ?? "No indexed snippet available yet.",
        relevance: 55,
      }));
      return buildKnowledgePayloadFromRows(prompt, fallbackRows);
    }

    return buildKnowledgePayloadFromRows(prompt, (data ?? []) as SearchKnowledgeRow[]);
  };

  const handleDocumentUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await uploadKnowledgeDocument(file);
  };

  const handleCaptureScreenshot = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      toast({
        title: "Screenshot capture not supported",
        description: "Use a modern browser that supports screen capture APIs.",
        variant: "destructive",
      });
      return;
    }

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });

      const track = stream.getVideoTracks()[0];
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise((resolve) => window.setTimeout(resolve, 100));

      const width = video.videoWidth || 1280;
      const height = video.videoHeight || 720;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Could not initialize screenshot canvas.");
      }
      context.drawImage(video, 0, 0, width, height);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => {
          if (!result) {
            reject(new Error("Failed to capture screenshot image."));
            return;
          }
          resolve(result);
        }, "image/png");
      });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const screenshotFile = new File([blob], `screenshot-${timestamp}.png`, { type: "image/png" });
      await uploadKnowledgeDocument(screenshotFile);
      track.stop();
    } catch (error) {
      toast({
        title: "Screenshot capture failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  };

  const createSession = async (tenantOverride?: string | null) => {
    if (!user) {
      toast({
        title: "Sign in required",
        description: "Log in to start a chat session.",
        variant: "destructive",
      });
      return null;
    }
    const effectiveTenantId = tenantOverride ?? tenantId;
    if (!effectiveTenantId) {
      toast({
        title: "Workspace not ready",
        description: "Workspace context is still loading. Please try again in a moment.",
        variant: "destructive",
      });
      return null;
    }

    const { data, error } = await supabase
      .from("chat_sessions")
      .insert({
        tenant_id: effectiveTenantId,
        user_id: user.id,
        title: null,
      })
      .select("id, title, created_at")
      .single();

    if (error) {
      toast({
        title: "Could not create session",
        description: error.message,
        variant: "destructive",
      });
      return null;
    }

    const newSession: ChatSession = {
      id: data.id,
      title: "New chat",
      createdAt: data.created_at,
      updatedAt: data.created_at,
      lastMessageAt: data.created_at,
      lastMessagePreview: "",
      messageCount: 0,
    };
    setSessions((prev) => sortSessionsByActivity([newSession, ...prev]));
    setActiveSessionId(newSession.id);
    setMessages([]);
    return newSession.id;
  };

  const upsertSessionTitleFromPrompt = (sessionId: string, prompt: string) => {
    const currentSession = sessions.find((session) => session.id === sessionId);
    if (!currentSession || currentSession.title === "New chat") {
      const nextTitle = buildSessionTitle(prompt);
      setSessions((prev) =>
        prev.map((session) => (session.id === sessionId ? { ...session, title: nextTitle } : session)),
      );
      void supabase.from("chat_sessions").update({ title: nextTitle }).eq("id", sessionId);
    }
  };

  const appendAssistantMessage = async (args: {
    sessionId: string;
    content: string;
    riskLevel: RiskLevel | null;
    agent: string;
    queryResult: SqlResultPayload | null;
    knowledgeResult: KnowledgeResultPayload | null;
    actionProposal: ActionProposalPayload | null;
  }) => {
    const optimisticId = `temp-assistant-${Date.now()}-${Math.round(Math.random() * 999)}`;
    const optimisticMessage: ChatMessage = {
      id: optimisticId,
      sessionId: args.sessionId,
      role: "assistant",
      content: args.content,
      createdAt: new Date().toISOString(),
      riskLevel: args.riskLevel,
      agent: args.agent,
      queryResult: args.queryResult,
      knowledgeResult: args.knowledgeResult,
      actionProposal: args.actionProposal,
    };

    setMessages((prev) => [...prev, optimisticMessage]);
    touchSessionActivity(args.sessionId, optimisticMessage.createdAt);

    const persistedContent = appendToolPayloads(args.content, {
      sqlResult: args.queryResult,
      knowledgeResult: args.knowledgeResult,
      actionProposal: args.actionProposal,
    });
    const { data: insertedAssistant, error: assistantInsertError } = await supabase
      .from("chat_messages")
      .insert({
        session_id: args.sessionId,
        role: "assistant",
        content: persistedContent,
        risk_level: args.riskLevel,
        tool_used: args.agent,
      })
      .select("id, session_id, role, content, created_at, risk_level, tool_used")
      .single();

    if (assistantInsertError) {
      toast({
        title: "Could not save assistant reply",
        description: assistantInsertError.message,
        variant: "destructive",
      });
      return;
    }

    const hydrated = mapRowToMessage(insertedAssistant as ChatMessageRow);
    setMessages((prev) => prev.map((message) => (message.id === optimisticId ? hydrated : message)));
    touchSessionActivity(args.sessionId, hydrated.createdAt);
    setSessions((prev) =>
      prev.map((session) =>
        session.id === args.sessionId
          ? {
              ...session,
              lastMessagePreview: buildSessionTitle(hydrated.content),
              messageCount: session.messageCount + 1,
            }
          : session,
      ),
    );
  };

  const handleNewChat = async () => {
    const newId = await createSession();
    if (!newId) return;
    setComposerValue("");
    window.setTimeout(() => inputRef.current?.focus(), 20);
  };

  const handleCopy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({
        title: "Copied",
        description: "Message copied to clipboard.",
      });
    } catch {
      toast({
        title: "Copy failed",
        description: "Clipboard permission was denied.",
        variant: "destructive",
      });
    }
  };

  const handleFeedback = async (messageId: string, value: FeedbackValue) => {
    const previous = feedbackByMessageId[messageId];
    const nextValue = previous === value ? undefined : value;

    setFeedbackByMessageId((prev) => {
      const copy = { ...prev };
      if (!nextValue) delete copy[messageId];
      else copy[messageId] = nextValue;
      return copy;
    });

    const { error } = await supabase.rpc("set_chat_message_feedback", {
      p_message_id: messageId,
      p_feedback: nextValue ?? null,
    });

    if (!error) return;
    if (isMissingFunctionError(error)) return;

    setFeedbackByMessageId((prev) => {
      const copy = { ...prev };
      if (!previous) delete copy[messageId];
      else copy[messageId] = previous;
      return copy;
    });

    toast({
      title: "Could not save feedback",
      description: error.message,
      variant: "destructive",
    });
  };

  const handleFollowUp = (question: string) => {
    setComposerValue(question);
    inputRef.current?.focus();
  };

  const handleActionProposalUpdate = async (messageId: string, proposal: ActionProposalPayload) => {
    const targetMessage = messages.find((message) => message.id === messageId);
    if (!targetMessage) return;

    const nextRisk = proposal.riskLevel ?? targetMessage.riskLevel;
    const nextContent = appendToolPayloads(targetMessage.content, {
      sqlResult: targetMessage.queryResult,
      knowledgeResult: targetMessage.knowledgeResult,
      actionProposal: proposal,
    });

    setMessages((prev) =>
      prev.map((message) =>
        message.id === messageId
          ? {
              ...message,
              riskLevel: nextRisk,
              actionProposal: proposal,
            }
          : message,
      ),
    );

    const { error } = await supabase
      .from("chat_messages")
      .update({
        content: nextContent,
        risk_level: nextRisk,
      })
      .eq("id", messageId);

    if (!error) return;
    toast({
      title: "Could not persist action update",
      description: error.message,
      variant: "destructive",
    });
  };

  const handleRetryWithFix = async (failedResult: SqlResultPayload) => {
    if (!activeSessionId) return;

    setThinking(true);
    await new Promise((resolve) => window.setTimeout(resolve, 400));

    let agent = "AEAR Core";
    let riskLevel: RiskLevel | null = "LOW";
    let queryResult: SqlResultPayload | null = null;
    let actionProposal: ActionProposalPayload | null = null;
    let content =
      "I couldn't retry this query because live execution was unavailable. Please verify the `chat-execute` function and retry.";

    try {
      const { data, error } = await invokeEdge("chat-execute", {
        body: {
          sessionId: activeSessionId,
          prompt: "Retry the failed SQL query with a safe fix.",
          retryRunId: failedResult.runId ?? null,
          retrySql: failedResult.sql,
          retryError: failedResult.error ?? null,
        },
      });

      if (error) throw error;

      const payload = (data ?? null) as ChatExecuteResponse | null;
      if (payload?.ok) {
        agent = typeof payload.agent === "string" ? payload.agent : agent;
        riskLevel = normalizeRisk(typeof payload.riskLevel === "string" ? payload.riskLevel : null) ?? riskLevel;
        queryResult = normalizeSqlResultPayload(payload.sqlResult ?? null) ?? queryResult;
        actionProposal = normalizeActionProposalPayload(payload.actionProposal ?? null) ?? actionProposal;
        content =
          typeof payload.assistant === "string" && payload.assistant.trim()
            ? payload.assistant
            : buildAssistantReply("Retry failed SQL query", agent, riskLevel, queryResult, null);

        if (payload.approvalRequired) {
          toast({
            title: "Approval required",
            description: payload.approvalRef
              ? `Request queued (${payload.approvalRef}). Open Approvals to continue.`
              : "Request queued. Open Approvals to continue.",
          });
        }
      } else {
        content = "Retry execution did not return a usable response. Please retry after checking backend logs.";
      }
    } catch (error) {
      const parsed = await formatEdgeFunctionError(error, { functionName: "chat-execute" });
      content =
        parsed
          ? `Retry failed before execution: ${parsed}`
          : "Retry failed before execution. Please check backend status and try again.";
    } finally {
      setThinking(false);
    }

    await appendAssistantMessage({
      sessionId: activeSessionId,
      content,
      riskLevel,
      agent,
      queryResult,
      knowledgeResult: null,
      actionProposal,
    });
  };

  const handleVoiceInput = () => {
    if (isListening) {
      try {
        setIsStoppingVoice(true);
        recognitionRef.current?.stop();
      } finally {
        inputRef.current?.focus();
      }
      return;
    }

    const SpeechRecognitionCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      toast({
        title: "Voice input not supported",
        description: "Use Chrome/Edge desktop for microphone input.",
        variant: "destructive",
      });
      return;
    }

    try {
      const recognition = new SpeechRecognitionCtor();
      recognitionRef.current = recognition;
      recognition.lang = "en-US";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onstart = () => {
        setIsListening(true);
        setIsStoppingVoice(false);
      };

      const base = composerValue.trim();
      let finalTranscript = base ? `${base} ` : "";
      setVoiceInterimText("");

      recognition.onresult = (event) => {
        let interimTranscript = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result?.[0]?.transcript ?? "";
          if (result?.isFinal) {
            finalTranscript += `${transcript} `;
          } else {
            interimTranscript += transcript;
          }
        }
        setVoiceInterimText(interimTranscript.trim());
        setComposerValue(`${finalTranscript}${interimTranscript}`.trim());
      };

      recognition.onerror = (event) => {
        setIsListening(false);
        setIsStoppingVoice(false);
        setVoiceInterimText("");
        const reason = event.error ?? "unknown";
        toast({
          title: "Voice input failed",
          description: `Microphone error: ${reason}`,
          variant: "destructive",
        });
      };

      recognition.onend = () => {
        setIsListening(false);
        setIsStoppingVoice(false);
        setVoiceInterimText("");
      };

      setIsStoppingVoice(false);
      recognition.start();
      inputRef.current?.focus();
    } catch (error) {
      setIsListening(false);
      setIsStoppingVoice(false);
      setVoiceInterimText("");
      toast({
        title: "Voice input failed",
        description: error instanceof Error ? error.message : "Could not start microphone input.",
        variant: "destructive",
      });
    }
  };

  const handleSend = async () => {
    const prompt = composerValue.trim();
    if (!prompt || thinking) return;
    if (!user) {
      toast({
        title: "Sign in required",
        description: "Please log in before sending messages.",
        variant: "destructive",
      });
      return;
    }

    let resolvedTenantId = tenantId;
    if (!tenantId) {
      try {
        const workspace = await ensureUserWorkspace(user);
        setTenantId(workspace.tenantId);
        resolvedTenantId = workspace.tenantId;
      } catch (error) {
        toast({
          title: "Workspace unavailable",
          description: error instanceof Error ? error.message : "Could not initialize workspace.",
          variant: "destructive",
        });
        return;
      }
    }

    if (isListening) {
      try {
        setIsStoppingVoice(true);
        recognitionRef.current?.stop();
      } catch {
        // No-op: stop may throw if recognizer is already ending.
      }
    }
    setVoiceInterimText("");

    let sessionId = activeSessionId;
    if (!sessionId) {
      sessionId = await createSession(resolvedTenantId);
      if (!sessionId) return;
    }

    setComposerValue("");

    const optimisticUserId = `temp-user-${Date.now()}`;
    const optimisticUserMessage: ChatMessage = {
      id: optimisticUserId,
      sessionId,
      role: "user",
      content: prompt,
      createdAt: new Date().toISOString(),
      riskLevel: null,
      agent: null,
      queryResult: null,
      knowledgeResult: null,
      actionProposal: null,
    };
    setMessages((prev) => [...prev, optimisticUserMessage]);
    touchSessionActivity(sessionId, optimisticUserMessage.createdAt);

    upsertSessionTitleFromPrompt(sessionId, prompt);

    const { data: insertedUser, error: userInsertError } = await supabase
      .from("chat_messages")
      .insert({
        session_id: sessionId,
        role: "user",
        content: prompt,
      })
      .select("id, session_id, role, content, created_at, risk_level, tool_used")
      .single();

    if (userInsertError) {
      toast({
        title: "Could not save your message",
        description: userInsertError.message,
        variant: "destructive",
      });
    } else if (insertedUser) {
      const hydrated = mapRowToMessage(insertedUser as ChatMessageRow);
      setMessages((prev) => prev.map((message) => (message.id === optimisticUserId ? hydrated : message)));
      touchSessionActivity(sessionId, hydrated.createdAt);
      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId
            ? { ...session, lastMessagePreview: buildSessionTitle(prompt), messageCount: session.messageCount + 1 }
            : session,
        ),
      );
    }

    setThinking(true);
    try {
      let agent = detectAgent(prompt);
      let riskLevel = detectRisk(prompt);
      let queryResult: SqlResultPayload | null = null;
      let knowledgeResult: KnowledgeResultPayload | null = null;
      let actionProposal: ActionProposalPayload | null = null;
      let assistantContent = "I am processing your request against live workspace context.";

      try {
        const { data, error } = await invokeEdge("chat-execute", {
          body: {
            sessionId,
            prompt,
          },
        });

        if (error) throw error;

        const payload = (data ?? null) as ChatExecuteResponse | null;
        if (payload?.ok) {
          agent = typeof payload.agent === "string" ? payload.agent : agent;
          riskLevel = normalizeRisk(typeof payload.riskLevel === "string" ? payload.riskLevel : null) ?? riskLevel;
          queryResult = normalizeSqlResultPayload(payload.sqlResult ?? null) ?? queryResult;
          knowledgeResult = normalizeKnowledgeResultPayload(payload.knowledgeResult ?? null) ?? knowledgeResult;
          actionProposal = normalizeActionProposalPayload(payload.actionProposal ?? null) ?? actionProposal;
          assistantContent =
            typeof payload.assistant === "string" && payload.assistant.trim()
              ? payload.assistant
              : buildAssistantReply(prompt, agent, riskLevel, queryResult, knowledgeResult);

          if (payload.approvalRequired) {
            toast({
              title: "Approval required",
              description: payload.approvalRef
                ? `Request queued (${payload.approvalRef}). Open Approvals to continue.`
                : "Request queued. Open Approvals to continue.",
            });
          }
        }
      } catch (error) {
        // Use transparent fallback when edge execution fails; avoid synthetic SQL answers.
        try {
          knowledgeResult = await searchKnowledgeSources(prompt);
        } catch (error) {
          toast({
            title: "Knowledge search failed",
            description: error instanceof Error ? error.message : "Could not fetch knowledge sources.",
            variant: "destructive",
          });
        }
        const backendReason =
          await formatEdgeFunctionError(error, { functionName: "chat-execute" });
        assistantContent = knowledgeResult
          ? [
              "Live SQL/action execution is currently unavailable, but I searched indexed knowledge sources.",
              "",
              buildKnowledgeAnswer(knowledgeResult),
              "",
              `Backend error: ${backendReason}`,
            ].join("\n")
          : [
              "I couldn't reach the live execution backend for this request.",
              "No synthetic SQL answer was generated.",
              "",
              `Backend error: ${backendReason}`,
              "Please verify `chat-execute` deployment/secrets and retry.",
            ].join("\n");
      }

      await appendAssistantMessage({
        sessionId,
        content: assistantContent,
        riskLevel,
        agent,
        queryResult,
        knowledgeResult,
        actionProposal,
      });
    } finally {
      setThinking(false);
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  };

  const canSend = composerValue.trim().length > 0 && !thinking && Boolean(user);

  return (
    <div
      className={cn(
        "grid h-[calc(100dvh-7rem)] min-h-[560px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:min-h-[620px]",
        contextCollapsed
          ? "grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]"
          : "grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_320px]",
      )}
    >
      <aside className="hidden min-h-0 flex-col border-b border-slate-200 bg-[#1A1A2E] p-4 text-slate-200 lg:flex lg:border-b-0 lg:border-r">
        <Button
          className="h-10 justify-start border-0 bg-gradient-to-r from-violet-600 to-purple-600 text-white hover:from-violet-500 hover:to-purple-500"
          onClick={() => void handleNewChat()}
        >
          <Plus className="h-4 w-4" />
          New Chat
        </Button>

        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={sessionSearch}
            onChange={(event) => setSessionSearch(event.target.value)}
            placeholder="Search sessions"
            className="border-white/10 bg-white/5 pl-9 text-slate-100 placeholder:text-slate-400"
          />
        </div>

        <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {loadingSessions ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full bg-white/10" />
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-slate-300">
              Start a conversation to create your first chat session.
            </div>
          ) : (
            SESSION_GROUP_ORDER.map((group) => {
              const groupSessions = groupedSessions[group];
              if (groupSessions.length === 0) return null;

              return (
                <section key={group}>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">{group}</p>
                  <div className="space-y-1.5">
                    {groupSessions.map((session) => (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => setActiveSessionId(session.id)}
                        className={cn(
                          "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                          activeSessionId === session.id
                            ? "border-violet-400/40 bg-violet-500/20 text-white"
                            : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10",
                        )}
                      >
                        <p className="truncate text-sm font-medium">{session.title}</p>
                        <p className="mt-0.5 text-xs text-slate-400">{safeFormatDateTime(session.lastMessageAt, "p")}</p>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })
          )}
        </div>
      </aside>

      <section className="flex min-h-0 flex-col bg-slate-50">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-3 py-3 sm:px-4">
          <div>
            <h1 className="text-base font-semibold text-slate-900">Internal AI Chat</h1>
            <p className="text-xs text-slate-500">Shift+Enter for new line, Enter to send</p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" className="lg:hidden" onClick={() => setMobileSessionsOpen(true)}>
              Sessions
            </Button>
            <Button type="button" variant="outline" size="sm" className="lg:hidden" onClick={() => setMobileContextOpen(true)}>
              Context
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setContextCollapsed((prev) => !prev)}
              className="hidden xl:inline-flex"
            >
              {contextCollapsed ? <PanelRightOpen className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
              {contextCollapsed ? "Show Context" : "Hide Context"}
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4 sm:py-5 lg:px-6">
          {loadingMessages ? (
            <div className="space-y-4">
              <Skeleton className="h-20 w-3/4 rounded-xl" />
              <Skeleton className="ml-auto h-14 w-2/3 rounded-xl" />
              <Skeleton className="h-24 w-4/5 rounded-xl" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex h-full min-h-[260px] flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white text-center">
              <Sparkles className="h-7 w-7 text-violet-500" />
              <h2 className="mt-3 text-lg font-semibold text-slate-900">Ask AEAR anything</h2>
              <p className="mt-1 max-w-md text-sm text-slate-500">
                Query enterprise data, ask for insights, or request actions with built-in governance checks.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((message) => {
                const feedback = feedbackByMessageId[message.id];
                return (
                  <article key={message.id} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
                    {message.role === "user" ? (
                      <div className="max-w-[90%] rounded-2xl bg-gradient-to-r from-violet-600 to-purple-600 px-4 py-3 text-sm text-white shadow-sm sm:max-w-[78%]">
                        <p className="whitespace-pre-wrap">{message.content}</p>
                        <p className="mt-2 text-[11px] text-violet-100">{safeFormatDateTime(message.createdAt, "p")}</p>
                      </div>
                    ) : (
                      <div className="w-full max-w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm sm:max-w-[92%] xl:max-w-[86%]">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-violet-100 text-violet-700">
                            <Bot className="h-4 w-4" />
                          </span>
                          <AgentBadge agent={message.agent ?? "AEAR Core"} />
                          {message.riskLevel && (
                            <Badge className={cn("border-0", riskBadgeClass(message.riskLevel))}>
                              <RiskIcon risk={message.riskLevel} />
                              <span className="ml-1">{message.riskLevel}</span>
                            </Badge>
                          )}
                        </div>

                        <div className="prose prose-slate prose-sm max-w-none whitespace-pre-wrap text-slate-800">
                          {message.content}
                        </div>

                        {message.queryResult && (
                          <SQLResultCard
                            result={message.queryResult}
                            onFollowUp={handleFollowUp}
                            onRetryWithFix={() => void handleRetryWithFix(message.queryResult as SqlResultPayload)}
                          />
                        )}

                        {message.knowledgeResult && (
                          <KnowledgeResultCard result={message.knowledgeResult} tenantId={tenantId} />
                        )}

                        {message.actionProposal && (
                          <ActionProposalCard
                            result={message.actionProposal}
                            messageId={message.id}
                            onProposalUpdate={handleActionProposalUpdate}
                          />
                        )}

                        <div className="mt-3 flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={cn(feedback === "up" && "text-emerald-600")}
                            onClick={() => void handleFeedback(message.id, "up")}
                            aria-label="Thumbs up"
                          >
                            <ThumbsUp className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={cn(feedback === "down" && "text-rose-600")}
                            onClick={() => void handleFeedback(message.id, "down")}
                            aria-label="Thumbs down"
                          >
                            <ThumbsDown className="h-4 w-4" />
                          </Button>
                          <Button type="button" variant="ghost" size="sm" onClick={() => void handleCopy(message.content)}>
                            <Copy className="h-4 w-4" />
                            Copy
                          </Button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}

              {thinking && (
                <div className="flex justify-start">
                  <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin text-violet-600" />
                      AEAR is thinking
                      <span className="inline-flex items-center gap-1">
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500 [animation-delay:0ms]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500 [animation-delay:180ms]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500 [animation-delay:360ms]" />
                      </span>
                    </div>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <footer className="sticky bottom-0 z-20 border-t border-slate-200 bg-white p-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] sm:p-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(event) => void handleDocumentUpload(event)}
            />
            <textarea
              ref={inputRef}
              value={composerValue}
              onChange={(event) => setComposerValue(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="Ask AEAR to query, analyze, or take governed action..."
              className="w-full resize-none border-0 bg-transparent text-base text-slate-900 outline-none placeholder:text-slate-500 md:text-sm"
              rows={1}
            />
            {uploadProgress !== null && (
              <div className="mt-2 rounded-md border border-slate-200 bg-white p-2">
                <p className="mb-1 text-xs text-slate-600">
                  Uploading {uploadingFileName ?? "document"} ({Math.round(uploadProgress)}%)
                </p>
                <Progress value={uploadProgress} className="h-1.5 bg-slate-200 [&>div]:bg-violet-600" />
              </div>
            )}
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Upload document"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Capture screenshot"
                  onClick={() => void handleCaptureScreenshot()}
                >
                  <Camera className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={isListening ? "Stop voice input" : "Start voice input"}
                  className={cn((isListening || isStoppingVoice) && "text-violet-700")}
                  onClick={handleVoiceInput}
                >
                  <Mic className="h-4 w-4" />
                </Button>
                {isListening || isStoppingVoice ? (
                  <p className="hidden items-center gap-2 text-xs text-violet-700 sm:flex">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-violet-600" />
                    {isStoppingVoice ? "Transcribing voice..." : "Listening... speak now"}
                  </p>
                ) : (
                  <p className="hidden text-xs text-slate-500 sm:block">Shift+Enter for new line, Enter to send</p>
                )}
              </div>
              <Button
                type="button"
                onClick={() => void handleSend()}
                disabled={!canSend}
                className="h-9 border-0 bg-gradient-to-r from-violet-600 to-purple-600 text-white hover:from-violet-500 hover:to-purple-500 disabled:opacity-60"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            </div>
            {(isListening || isStoppingVoice) && (
              <div className="mt-2 rounded-md border border-violet-200 bg-violet-50 px-2 py-1.5">
                <p className="text-xs text-violet-800">
                  {voiceInterimText ? `Transcript: ${voiceInterimText}` : "Capturing voice input..."}
                </p>
              </div>
            )}
          </div>
        </footer>
      </section>

      {!contextCollapsed && (
        <aside className="hidden min-h-0 flex-col border-l border-slate-200 bg-white xl:flex">
          <header className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-900">This conversation</h2>
            <p className="text-xs text-slate-500">Live context and execution metadata</p>
          </header>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Active agents</p>
              {contextSummary.agents.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">No agents active yet.</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {contextSummary.agents.map((agent) => (
                    <AgentBadge key={agent} agent={agent} />
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Data sources queried</p>
              {contextSummary.sources.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">No sources queried yet.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {contextSummary.sources.map((source) => (
                    <li key={source.id} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-2.5 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-800">{source.name}</p>
                        <p className="text-xs text-slate-500">{source.type}</p>
                      </div>
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-slate-600">
                        <Database className="h-4 w-4" />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Actions taken</p>
              <p className="mt-2 text-2xl font-bold text-slate-900">{contextSummary.actionCount}</p>
              <p className="mt-1 text-xs text-slate-500">Assistant replies proposing governed operations.</p>
            </section>
          </div>
        </aside>
      )}

      <Sheet open={mobileSessionsOpen} onOpenChange={setMobileSessionsOpen}>
        <SheetContent side="bottom" className="h-[78vh] rounded-t-2xl border-slate-200 bg-[#1A1A2E] p-4 text-slate-200 lg:hidden">
          <div className="mx-auto mb-2 h-1.5 w-12 rounded-full bg-white/20" />
          <p className="mb-3 text-center text-[11px] uppercase tracking-[0.12em] text-slate-400">Swipe down to close</p>
          <Button
            className="h-10 w-full justify-start border-0 bg-gradient-to-r from-violet-600 to-purple-600 text-white hover:from-violet-500 hover:to-purple-500"
            onClick={() => void handleNewChat()}
          >
            <Plus className="h-4 w-4" />
            New Chat
          </Button>

          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={sessionSearch}
              onChange={(event) => setSessionSearch(event.target.value)}
              placeholder="Search sessions"
              className="border-white/10 bg-white/5 pl-9 text-slate-100 placeholder:text-slate-400"
            />
          </div>

          <div className="mt-4 max-h-[52vh] space-y-4 overflow-y-auto pr-1">
            {loadingSessions ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, index) => (
                  <Skeleton key={`mobile-session-skeleton-${index}`} className="h-12 w-full bg-white/10" />
                ))}
              </div>
            ) : sessions.length === 0 ? (
              <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-slate-300">
                Start a conversation to create your first chat session.
              </div>
            ) : (
              SESSION_GROUP_ORDER.map((group) => {
                const groupSessions = groupedSessions[group];
                if (groupSessions.length === 0) return null;

                return (
                  <section key={`mobile-${group}`}>
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">{group}</p>
                    <div className="space-y-1.5">
                      {groupSessions.map((session) => (
                        <button
                          key={`mobile-session-${session.id}`}
                          type="button"
                          onClick={() => {
                            setActiveSessionId(session.id);
                            setMobileSessionsOpen(false);
                          }}
                          className={cn(
                            "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                            activeSessionId === session.id
                              ? "border-violet-400/40 bg-violet-500/20 text-white"
                              : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10",
                          )}
                        >
                          <p className="truncate text-sm font-medium">{session.title}</p>
                          <p className="mt-0.5 text-xs text-slate-400">{safeFormatDateTime(session.lastMessageAt, "p")}</p>
                        </button>
                      ))}
                    </div>
                  </section>
                );
              })
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={mobileContextOpen} onOpenChange={setMobileContextOpen}>
        <SheetContent side="bottom" className="h-[72vh] rounded-t-2xl border-slate-200 bg-white p-0 lg:hidden">
          <div className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-slate-300" />
          <header className="border-b border-slate-200 px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.12em] text-slate-400">Swipe down to close</p>
            <h2 className="mt-1 text-sm font-semibold text-slate-900">This conversation</h2>
            <p className="text-xs text-slate-500">Live context and execution metadata</p>
          </header>
          <div className="h-[calc(72vh-76px)] space-y-4 overflow-y-auto p-4">
            <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Active agents</p>
              {contextSummary.agents.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">No agents active yet.</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {contextSummary.agents.map((agent) => (
                    <AgentBadge key={`mobile-context-agent-${agent}`} agent={agent} />
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Data sources queried</p>
              {contextSummary.sources.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">No sources queried yet.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {contextSummary.sources.map((source) => (
                    <li
                      key={`mobile-context-source-${source.id}`}
                      className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-2.5 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-800">{source.name}</p>
                        <p className="text-xs text-slate-500">{source.type}</p>
                      </div>
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-slate-600">
                        <Database className="h-4 w-4" />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Actions taken</p>
              <p className="mt-2 text-2xl font-bold text-slate-900">{contextSummary.actionCount}</p>
              <p className="mt-1 text-xs text-slate-500">Assistant replies proposing governed operations.</p>
            </section>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
