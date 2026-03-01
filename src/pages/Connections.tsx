import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  Bot,
  Braces,
  CheckCircle2,
  Database,
  Flame,
  Loader2,
  NotebookPen,
  Plug,
  Plus,
  Search,
  Settings,
  Sheet,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import {
  formatEdgeFunctionError,
  isSessionExpiredMessage,
  sanitizeConnectionErrorMessage,
} from "@/lib/edge-function-error";
import { invokeEdge } from "@/lib/edge-invoke";
import { ensureActiveUserSession } from "@/lib/session";
import { supabase } from "@/integrations/supabase/client";
import type { Database as SupabaseDatabase } from "@/integrations/supabase/types";
import { cn } from "@/lib/utils";

type ApiConnectionRow = SupabaseDatabase["public"]["Tables"]["api_connections"]["Row"];

type TypeFilterValue =
  | "all"
  | "rest_api"
  | "postgresql"
  | "mysql"
  | "mongodb"
  | "google_sheets"
  | "notion"
  | "firebase"
  | "custom_rest";
type StatusFilterValue = "all" | "active" | "error" | "pending";

type ConnectionType =
  | "rest_openapi"
  | "postgresql"
  | "mysql"
  | "mongodb"
  | "google_sheets"
  | "notion"
  | "firebase"
  | "custom_rest";

type AuthType = "none" | "api_key" | "bearer_token" | "basic_auth" | "oauth2";

type HeaderRow = {
  id: string;
  key: string;
  value: string;
};

type ConnectionDraft = {
  name: string;
  baseUrl: string;
  authType: AuthType;
  apiKey: string;
  bearerToken: string;
  basicUsername: string;
  basicPassword: string;
  oauthClientId: string;
  oauthClientSecret: string;
  openApiUrl: string;
  customHeaders: HeaderRow[];
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  sslMode: "disable" | "require" | "verify-full";
  sshTunnel: boolean;
  spreadsheetUrl: string;
  serviceAccountJson: string;
  serviceAccountFileName: string;
  mongodbConnectionString: string;
  notionToken: string;
  notionDatabaseId: string;
  firebaseProjectId: string;
};

type TestState = {
  status: "idle" | "testing" | "success" | "error";
  message: string;
  latencyMs: number | null;
};

type ConnectionPipelineFacts = {
  entityCount: number;
  latestSyncStatus: string | null;
  latestSyncError: string | null;
  latestJobStatus: string | null;
  latestJobError: string | null;
  queuedJobs: number;
  runningJobs: number;
};

type PipelineIssue = {
  severity: "critical" | "high" | "medium" | "low";
  code: string;
  message: string;
  remediation: string;
};

type PipelineConnectionHealth = {
  connection: {
    id: string;
    name: string;
    type: string;
    status: string;
    health: string;
  };
  healthState: "healthy" | "degraded" | "failing";
  issues: PipelineIssue[];
};

type PipelineDiagnosticsPayload = {
  summary: {
    totalConnections: number;
    failingConnections: number;
    healthyConnections: number;
    openIssues: number;
  };
  connections: PipelineConnectionHealth[];
};

type PipelineDiagnosticsResponse = {
  ok?: boolean;
  payload?: PipelineDiagnosticsPayload;
};
const CONNECTION_QUERY_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: number | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.max(1, Math.floor(timeoutMs / 1000))}s.`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  });
}

const TYPE_OPTIONS: Array<{
  value: ConnectionType;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  accent: string;
}> = [
  { value: "rest_openapi", label: "REST API", description: "OpenAPI/Swagger aware", icon: Zap, accent: "bg-orange-100 text-orange-700" },
  { value: "postgresql", label: "PostgreSQL", description: "Relational database", icon: Database, accent: "bg-blue-100 text-blue-700" },
  { value: "mysql", label: "MySQL", description: "Operational SQL database", icon: Database, accent: "bg-cyan-100 text-cyan-700" },
  { value: "mongodb", label: "MongoDB", description: "Document database", icon: Database, accent: "bg-emerald-100 text-emerald-700" },
  { value: "google_sheets", label: "Google Sheets", description: "Spreadsheet sync", icon: Sheet, accent: "bg-green-100 text-green-700" },
  { value: "notion", label: "Notion", description: "Workspace knowledge", icon: NotebookPen, accent: "bg-slate-200 text-slate-700" },
  { value: "firebase", label: "Firebase", description: "Realtime app data", icon: Flame, accent: "bg-amber-100 text-amber-700" },
  { value: "custom_rest", label: "Custom REST", description: "No API spec", icon: Braces, accent: "bg-violet-100 text-violet-700" },
];

function createInitialDraft(): ConnectionDraft {
  return {
    name: "",
    baseUrl: "",
    authType: "none",
    apiKey: "",
    bearerToken: "",
    basicUsername: "",
    basicPassword: "",
    oauthClientId: "",
    oauthClientSecret: "",
    openApiUrl: "",
    customHeaders: [{ id: crypto.randomUUID(), key: "", value: "" }],
    host: "",
    port: "5432",
    database: "",
    username: "",
    password: "",
    sslMode: "require",
    sshTunnel: false,
    spreadsheetUrl: "",
    serviceAccountJson: "",
    serviceAccountFileName: "",
    mongodbConnectionString: "",
    notionToken: "",
    notionDatabaseId: "",
    firebaseProjectId: "",
  };
}

function connectionTypeLabel(type: string) {
  switch (type) {
    case "rest_openapi":
      return "REST API";
    case "custom_rest":
      return "Custom REST API";
    case "postgresql":
      return "PostgreSQL";
    case "mysql":
      return "MySQL";
    case "mongodb":
      return "MongoDB";
    case "google_sheets":
      return "Google Sheets";
    case "notion":
      return "Notion";
    case "firebase":
      return "Firebase";
    default:
      return type.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
}

function getTypeVisual(type: string) {
  const lower = type.toLowerCase();

  if (lower === "postgresql") return { icon: Database, bgClass: "bg-blue-100 text-blue-700", accent: "PG" };
  if (lower === "mysql") return { icon: Database, bgClass: "bg-cyan-100 text-cyan-700", accent: "MY" };
  if (lower === "mongodb") return { icon: Database, bgClass: "bg-emerald-100 text-emerald-700", accent: "MG" };
  if (lower === "google_sheets") return { icon: Sheet, bgClass: "bg-green-100 text-green-700", accent: "GS" };
  if (lower === "notion") return { icon: NotebookPen, bgClass: "bg-slate-200 text-slate-700", accent: "NO" };
  if (lower === "firebase") return { icon: Flame, bgClass: "bg-amber-100 text-amber-700", accent: "FB" };
  if (lower.includes("rest")) return { icon: Zap, bgClass: "bg-orange-100 text-orange-700", accent: "API" };
  return { icon: Braces, bgClass: "bg-violet-100 text-violet-700", accent: "DS" };
}

function statusView(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "active") return { label: "Active", className: "bg-emerald-100 text-emerald-700", spinning: false };
  if (normalized === "syncing") return { label: "Syncing", className: "bg-blue-100 text-blue-700", spinning: true };
  if (normalized === "error") return { label: "Error", className: "bg-rose-100 text-rose-700", spinning: false };
  if (normalized === "pending") return { label: "Pending", className: "bg-slate-200 text-slate-700", spinning: false };
  return {
    label: normalized.charAt(0).toUpperCase() + normalized.slice(1),
    className: "bg-slate-200 text-slate-700",
    spinning: false,
  };
}

function formatRelativeTime(value: string | null) {
  if (!value) return "Never synced";
  const now = Date.now();
  const then = new Date(value).getTime();
  const diffMs = now - then;
  if (diffMs < 60_000) return "Just now";
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)} min ago`;
  if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)} hr ago`;
  const days = Math.round(diffMs / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function matchesTypeFilter(type: string, filter: TypeFilterValue) {
  if (filter === "all") return true;
  if (filter === "rest_api") return type.includes("rest");
  return type === filter;
}

function matchesStatusFilter(status: string, filter: StatusFilterValue) {
  if (filter === "all") return true;
  const normalized = status.toLowerCase();
  if (filter === "pending") return normalized === "pending" || normalized === "syncing";
  return normalized === filter;
}

function schemaSummary(entityCount: number, effectiveStatus: string) {
  if (entityCount > 0) {
    return `${entityCount} table${entityCount === 1 ? "" : "s"}, ${entityCount} entit${entityCount === 1 ? "y" : "ies"} classified`;
  }
  const normalizedStatus = effectiveStatus.toLowerCase();
  if (normalizedStatus === "syncing" || normalizedStatus === "pending") {
    return "Analysis in progress...";
  }
  return "Schema not detected yet";
}

function deriveEffectiveConnectionStatus(connection: ApiConnectionRow, facts: ConnectionPipelineFacts | null) {
  const connectionStatus = connection.status.toLowerCase();
  if (!facts) return connectionStatus;

  const latestSync = (facts.latestSyncStatus ?? "").toLowerCase();
  const latestJob = (facts.latestJobStatus ?? "").toLowerCase();

  if (facts.runningJobs > 0 || latestSync === "running" || latestJob === "running") {
    return "syncing";
  }

  if (latestSync === "queued" || latestJob === "queued" || facts.queuedJobs > 0) {
    return "pending";
  }

  if (latestSync === "success" && facts.entityCount > 0) {
    return "active";
  }

  if (["error", "dead_letter", "cancelled"].includes(latestSync) || ["error", "dead_letter"].includes(latestJob)) {
    return "error";
  }

  if (facts.entityCount > 0 && connectionStatus !== "error") {
    return "active";
  }

  if (connectionStatus === "active" && facts.entityCount === 0) {
    return "pending";
  }

  return connectionStatus;
}

function pipelineSeverityBadgeClass(severity: PipelineIssue["severity"]) {
  if (severity === "critical" || severity === "high") return "bg-rose-100 text-rose-700";
  if (severity === "medium") return "bg-amber-100 text-amber-700";
  return "bg-slate-100 text-slate-700";
}

function pipelineHealthBadgeClass(healthState: PipelineConnectionHealth["healthState"]) {
  if (healthState === "failing") return "bg-rose-100 text-rose-700";
  if (healthState === "degraded") return "bg-amber-100 text-amber-700";
  return "bg-emerald-100 text-emerald-700";
}

function formatSyncLag(syncLagSeconds: number, lastSyncedAt: string | null) {
  if (Number.isFinite(syncLagSeconds) && syncLagSeconds > 0) {
    if (syncLagSeconds < 60) return `${syncLagSeconds}s`;
    if (syncLagSeconds < 3600) return `${Math.round(syncLagSeconds / 60)}m`;
    return `${Math.round(syncLagSeconds / 3600)}h`;
  }
  return formatRelativeTime(lastSyncedAt);
}

function isValidUrl(value: string) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isMissingColumnError(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  const code = String(error.code ?? "").trim();
  const message = String(error.message ?? "").toLowerCase();
  return (
    code === "42703" ||
    code === "PGRST204" ||
    (message.includes("column") && message.includes("does not exist")) ||
    (message.includes("column") && message.includes("schema cache")) ||
    (message.includes("could not find") && message.includes("column"))
  );
}

function validateConfig(type: ConnectionType | null, draft: ConnectionDraft) {
  if (!type) return "Select a connection type.";
  if (!draft.name.trim()) return "Connection name is required.";

  if (type === "rest_openapi" || type === "custom_rest") {
    if (!draft.baseUrl.trim()) return "Base URL is required.";
    if (!isValidUrl(draft.baseUrl.trim())) return "Base URL must be a valid URL.";
    if (draft.openApiUrl.trim() && !isValidUrl(draft.openApiUrl.trim())) return "OpenAPI Spec URL must be valid.";

    if (draft.authType === "api_key" && !draft.apiKey.trim()) return "API key is required.";
    if (draft.authType === "bearer_token" && !draft.bearerToken.trim()) return "Bearer token is required.";
    if (draft.authType === "basic_auth" && (!draft.basicUsername.trim() || !draft.basicPassword.trim())) {
      return "Basic auth username and password are required.";
    }
    if (draft.authType === "oauth2" && (!draft.oauthClientId.trim() || !draft.oauthClientSecret.trim())) {
      return "OAuth2 client ID and secret are required.";
    }
  }

  if (type === "postgresql" || type === "mysql") {
    if (!draft.host.trim()) return "Host is required.";
    if (!draft.port.trim() || Number.isNaN(Number(draft.port))) return "Port must be a valid number.";
    if (!draft.database.trim()) return "Database is required.";
    if (!draft.username.trim()) return "Username is required.";
    if (!draft.password.trim()) return "Password is required.";
  }

  if (type === "mongodb") {
    if (!draft.mongodbConnectionString.trim()) return "MongoDB connection string is required.";
  }

  if (type === "google_sheets") {
    if (!draft.spreadsheetUrl.trim() || !isValidUrl(draft.spreadsheetUrl.trim())) {
      return "Spreadsheet URL must be a valid URL.";
    }
    if (!draft.serviceAccountJson.trim()) return "Service Account JSON is required.";
    try {
      JSON.parse(draft.serviceAccountJson);
    } catch {
      return "Service Account JSON is not valid JSON.";
    }
  }

  if (type === "notion") {
    if (!draft.notionToken.trim()) return "Notion integration token is required.";
    if (!draft.notionDatabaseId.trim()) return "Notion database ID is required.";
  }

  if (type === "firebase") {
    if (!draft.firebaseProjectId.trim()) return "Firebase project ID is required.";
    if (!draft.serviceAccountJson.trim()) return "Firebase service account JSON is required.";
    try {
      JSON.parse(draft.serviceAccountJson);
    } catch {
      return "Firebase service account JSON is not valid JSON.";
    }
  }

  return null;
}

function detailsToMessageSuffix(details: unknown) {
  if (!details || typeof details !== "object") return "";
  const safeDetails = details as Record<string, unknown>;
  const extras: string[] = [];
  if (typeof safeDetails.tcpMessage === "string" && safeDetails.tcpMessage.trim()) {
    extras.push(`Network: ${safeDetails.tcpMessage.trim()}`);
  }
  if (typeof safeDetails.host === "string" && safeDetails.host.trim()) {
    extras.push(`Host: ${safeDetails.host.trim()}`);
  }
  if (typeof safeDetails.port === "number" && Number.isFinite(safeDetails.port)) {
    extras.push(`Port: ${safeDetails.port}`);
  }
  if (typeof safeDetails.statusCode === "number" && Number.isFinite(safeDetails.statusCode)) {
    extras.push(`Status code: ${safeDetails.statusCode}`);
  }
  return extras.length > 0 ? ` ${extras.join(" · ")}` : "";
}

function buildInsertPayload(type: ConnectionType, draft: ConnectionDraft, tenantId: string) {
  let baseUrl: string | null = null;
  if (type === "rest_openapi" || type === "custom_rest") baseUrl = draft.baseUrl.trim();
  if (type === "postgresql" || type === "mysql") baseUrl = `${draft.host.trim()}:${draft.port.trim()}/${draft.database.trim()}`;
  if (type === "google_sheets") baseUrl = draft.spreadsheetUrl.trim();
  if (type === "mongodb") baseUrl = draft.mongodbConnectionString.trim();
  if (type === "notion") baseUrl = `notion://${draft.notionDatabaseId.trim()}`;
  if (type === "firebase") baseUrl = `firebase://${draft.firebaseProjectId.trim()}`;

  return {
    tenant_id: tenantId,
    name: draft.name.trim(),
    type,
    base_url: baseUrl,
    status: "pending",
    schema_detected: false,
    last_synced_at: null,
  };
}

function buildConnectionConfig(type: ConnectionType, draft: ConnectionDraft) {
  if (type === "rest_openapi" || type === "custom_rest") {
    return {
      auth_type: draft.authType,
      base_url: draft.baseUrl.trim() || null,
      openapi_url: draft.openApiUrl.trim() || null,
      custom_headers: draft.customHeaders
        .map((item) => ({ key: item.key.trim(), value: item.value.trim() }))
        .filter((item) => item.key || item.value),
      api_key: draft.apiKey.trim() || null,
      bearer_token: draft.bearerToken.trim() || null,
      basic_username: draft.basicUsername.trim() || null,
      basic_password: draft.basicPassword.trim() || null,
      oauth_client_id: draft.oauthClientId.trim() || null,
      oauth_client_secret: draft.oauthClientSecret.trim() || null,
      sync_frequency: "hourly",
    };
  }

  if (type === "postgresql" || type === "mysql") {
    return {
      host: draft.host.trim(),
      port: Number(draft.port || (type === "mysql" ? 3306 : 5432)),
      database: draft.database.trim(),
      username: draft.username.trim(),
      password: draft.password,
      ssl_mode: draft.sslMode,
      ssh_tunnel: draft.sshTunnel,
      sync_frequency: "hourly",
    };
  }

  if (type === "mongodb") {
    return {
      connection_string: draft.mongodbConnectionString.trim(),
      sync_frequency: "hourly",
    };
  }

  if (type === "google_sheets") {
    let parsedServiceAccount: unknown = draft.serviceAccountJson.trim() || null;
    if (typeof parsedServiceAccount === "string" && parsedServiceAccount) {
      try {
        parsedServiceAccount = JSON.parse(parsedServiceAccount);
      } catch {
        parsedServiceAccount = draft.serviceAccountJson.trim();
      }
    }

    return {
      sheet_url: draft.spreadsheetUrl.trim(),
      service_account_json: parsedServiceAccount,
      sync_frequency: "hourly",
    };
  }

  if (type === "notion") {
    return {
      integration_token: draft.notionToken.trim(),
      database_id: draft.notionDatabaseId.trim(),
      sync_frequency: "hourly",
    };
  }

  if (type === "firebase") {
    let parsedServiceAccount: unknown = draft.serviceAccountJson.trim() || null;
    if (typeof parsedServiceAccount === "string" && parsedServiceAccount) {
      try {
        parsedServiceAccount = JSON.parse(parsedServiceAccount);
      } catch {
        parsedServiceAccount = draft.serviceAccountJson.trim();
      }
    }

    return {
      project_id: draft.firebaseProjectId.trim(),
      service_account_json: parsedServiceAccount,
      sync_frequency: "hourly",
    };
  }

  return {
    sync_frequency: "hourly",
  };
}

export default function Connections() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [connections, setConnections] = useState<ApiConnectionRow[]>([]);
  const [connectionFacts, setConnectionFacts] = useState<Map<string, ConnectionPipelineFacts>>(new Map());
  const [pipelineDiagnostics, setPipelineDiagnostics] = useState<PipelineDiagnosticsPayload | null>(null);
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [pipelineLastUpdatedAt, setPipelineLastUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const diagnosticsLastFetchRef = useRef(0);
  const diagnosticsRequestRef = useRef<Promise<void> | null>(null);

  const [searchValue, setSearchValue] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilterValue>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("all");
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedType, setSelectedType] = useState<ConnectionType | null>(null);
  const [draft, setDraft] = useState<ConnectionDraft>(createInitialDraft);
  const [configError, setConfigError] = useState<string | null>(null);
  const [testState, setTestState] = useState<TestState>({
    status: "idle",
    message: "",
    latencyMs: null,
  });
  const [savingConnection, setSavingConnection] = useState(false);

  const resetModal = useCallback(() => {
    setStep(1);
    setSelectedType(null);
    setDraft(createInitialDraft());
    setConfigError(null);
    setTestState({ status: "idle", message: "", latencyMs: null });
    setSavingConnection(false);
  }, []);

  const ensureActiveSession = useCallback(async () => {
    return ensureActiveUserSession();
  }, []);

  const loadPipelineDiagnostics = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && now - diagnosticsLastFetchRef.current < 5000) return;
    if (diagnosticsRequestRef.current) return diagnosticsRequestRef.current;

    const request = (async () => {
      setPipelineLoading(true);
      try {
        const response = await invokeEdge<PipelineDiagnosticsResponse>("connection-pipeline-diagnostics", {
          body: {
            operation: "get_payload",
            includeHealthy: false,
          },
        });

        if (response.error) {
          const parsed = sanitizeConnectionErrorMessage(
            await formatEdgeFunctionError(response.error, {
              functionName: "connection-pipeline-diagnostics",
            }),
          );
          throw new Error(parsed);
        }

        const payload = response.data?.payload;
        if (payload && Array.isArray(payload.connections) && payload.summary) {
          setPipelineDiagnostics(payload);
        } else {
          setPipelineDiagnostics({
            summary: {
              totalConnections: 0,
              failingConnections: 0,
              healthyConnections: 0,
              openIssues: 0,
            },
            connections: [],
          });
        }
        setPipelineError(null);
        diagnosticsLastFetchRef.current = Date.now();
        setPipelineLastUpdatedAt(new Date().toISOString());
      } catch (error) {
        setPipelineError(error instanceof Error ? error.message : "Could not load pipeline diagnostics.");
      } finally {
        setPipelineLoading(false);
      }
    })();

    diagnosticsRequestRef.current = request;
    try {
      await request;
    } finally {
      diagnosticsRequestRef.current = null;
    }
  }, []);

  const loadConnections = useCallback(async (workspaceTenantId: string, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const baseSelect =
        "id, tenant_id, name, type, base_url, status, schema_detected, last_synced_at, created_at, schema_tables_count, schema_entities_count, queries_today, embeddings_indexed, sync_lag_seconds, last_error, is_archived";
      const { data, error } = await withTimeout(
        supabase
          .from("api_connections")
          .select(baseSelect)
          .eq("tenant_id", workspaceTenantId)
          .order("created_at", { ascending: false }),
        CONNECTION_QUERY_TIMEOUT_MS,
        "Connections query",
      );

      let rows: ApiConnectionRow[];
      if (!error) {
        rows = ((data ?? []) as ApiConnectionRow[]).filter((row) => row.is_archived !== true);
      } else if (isMissingColumnError(error)) {
        const legacy = await withTimeout(
          supabase
            .from("api_connections")
            .select("id, tenant_id, name, type, base_url, status, schema_detected, last_synced_at, created_at, last_error")
            .eq("tenant_id", workspaceTenantId)
            .order("created_at", { ascending: false }),
          CONNECTION_QUERY_TIMEOUT_MS,
          "Connections legacy query",
        );
        if (legacy.error) throw legacy.error;
        rows = ((legacy.data ?? []) as ApiConnectionRow[]).map((row) => ({
          ...row,
          schema_tables_count: row.schema_tables_count ?? 0,
          schema_entities_count: row.schema_entities_count ?? 0,
          queries_today: row.queries_today ?? 0,
          embeddings_indexed: row.embeddings_indexed ?? 0,
          sync_lag_seconds: row.sync_lag_seconds ?? 0,
          is_archived: false,
        }));
      } else {
        throw error;
      }

      const ids = rows.map((row) => row.id);
      const nextFacts = new Map<string, ConnectionPipelineFacts>();

      if (ids.length > 0) {
        const [entityResponse, jobResponse, syncResponse] = await withTimeout(
          Promise.all([
            supabase
              .from("connection_entities")
              .select("id, connection_id")
              .eq("tenant_id", workspaceTenantId)
              .in("connection_id", ids),
            supabase
              .from("connector_jobs")
              .select("connection_id, status, last_error, updated_at")
              .eq("tenant_id", workspaceTenantId)
              .in("connection_id", ids)
              .order("updated_at", { ascending: false })
              .limit(500),
            supabase
              .from("connection_sync_runs")
              .select("connection_id, status, error_message, updated_at")
              .eq("tenant_id", workspaceTenantId)
              .in("connection_id", ids)
              .order("updated_at", { ascending: false })
              .limit(500),
          ]),
          CONNECTION_QUERY_TIMEOUT_MS,
          "Connection facts query",
        );

      if (entityResponse.error) throw entityResponse.error;

      let jobRows: Array<{
        connection_id: string;
        status: string | null;
        last_error: string | null;
        updated_at?: string | null;
        created_at?: string | null;
      }> = [];

      if (!jobResponse.error) {
        jobRows = (jobResponse.data ?? []) as typeof jobRows;
      } else if (isMissingColumnError(jobResponse.error)) {
        const legacyJobs = await supabase
          .from("connector_jobs")
          .select("connection_id, status, last_error, created_at")
          .eq("tenant_id", workspaceTenantId)
          .in("connection_id", ids)
          .order("created_at", { ascending: false })
          .limit(500);

        if (legacyJobs.error) throw legacyJobs.error;
        jobRows = ((legacyJobs.data ?? []) as typeof jobRows).map((row) => ({
          ...row,
          updated_at: row.created_at ?? null,
        }));
      } else {
        throw jobResponse.error;
      }

      let syncRows: Array<{
        connection_id: string;
        status: string | null;
        error_message: string | null;
        updated_at?: string | null;
        started_at?: string | null;
        finished_at?: string | null;
      }> = [];

      if (!syncResponse.error) {
        syncRows = (syncResponse.data ?? []) as typeof syncRows;
      } else if (isMissingColumnError(syncResponse.error)) {
        const legacySyncRuns = await supabase
          .from("connection_sync_runs")
          .select("connection_id, status, error_message, started_at, finished_at")
          .eq("tenant_id", workspaceTenantId)
          .in("connection_id", ids)
          .order("started_at", { ascending: false })
          .limit(500);

        if (legacySyncRuns.error) throw legacySyncRuns.error;
        syncRows = ((legacySyncRuns.data ?? []) as typeof syncRows).map((row) => ({
          ...row,
          updated_at: row.finished_at ?? row.started_at ?? null,
        }));
      } else {
        throw syncResponse.error;
      }

      const entityCountByConnection = new Map<string, number>();
      for (const row of entityResponse.data ?? []) {
        const connectionId = String(row.connection_id);
        entityCountByConnection.set(connectionId, (entityCountByConnection.get(connectionId) ?? 0) + 1);
      }

      const latestJobByConnection = new Map<string, { status: string | null; error: string | null }>();
      const queuedCountByConnection = new Map<string, number>();
      const runningCountByConnection = new Map<string, number>();
      for (const row of jobRows) {
        const connectionId = String(row.connection_id);
        const status = String(row.status ?? "").toLowerCase();
        if (status === "queued") queuedCountByConnection.set(connectionId, (queuedCountByConnection.get(connectionId) ?? 0) + 1);
        if (status === "running") runningCountByConnection.set(connectionId, (runningCountByConnection.get(connectionId) ?? 0) + 1);
        if (!latestJobByConnection.has(connectionId)) {
          latestJobByConnection.set(connectionId, {
            status: row.status ?? null,
            error: row.last_error ?? null,
          });
        }
      }

      const latestSyncByConnection = new Map<string, { status: string | null; error: string | null }>();
      for (const row of syncRows) {
        const connectionId = String(row.connection_id);
        if (!latestSyncByConnection.has(connectionId)) {
          latestSyncByConnection.set(connectionId, {
            status: row.status ?? null,
            error: row.error_message ?? null,
          });
        }
      }

      for (const connection of rows) {
        const connectionId = connection.id;
        nextFacts.set(connectionId, {
          entityCount: entityCountByConnection.get(connectionId) ?? 0,
          latestSyncStatus: latestSyncByConnection.get(connectionId)?.status ?? null,
          latestSyncError: latestSyncByConnection.get(connectionId)?.error ?? null,
          latestJobStatus: latestJobByConnection.get(connectionId)?.status ?? null,
          latestJobError: latestJobByConnection.get(connectionId)?.error ?? null,
          queuedJobs: queuedCountByConnection.get(connectionId) ?? 0,
          runningJobs: runningCountByConnection.get(connectionId) ?? 0,
        });
      }
    }

      setConnectionFacts(nextFacts);
      setConnections(rows);
      void loadPipelineDiagnostics();
    } finally {
      if (!silent) setLoading(false);
    }
  }, [loadPipelineDiagnostics]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    let channel: RealtimeChannel | null = null;

    const bootstrap = async () => {
      try {
        const workspace = await ensureUserWorkspace(user);
        if (!active) return;
        setTenantId(workspace.tenantId);

        await loadConnections(workspace.tenantId);
        if (!active) return;

        channel = supabase
          .channel(`connections-realtime-${workspace.tenantId}`)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "api_connections",
              filter: `tenant_id=eq.${workspace.tenantId}`,
            },
            () => {
              void loadConnections(workspace.tenantId, true);
            },
          )
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "connection_sync_runs",
              filter: `tenant_id=eq.${workspace.tenantId}`,
            },
            () => {
              void loadConnections(workspace.tenantId, true);
            },
          )
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "connector_jobs",
              filter: `tenant_id=eq.${workspace.tenantId}`,
            },
            () => {
              void loadConnections(workspace.tenantId, true);
            },
          )
          .subscribe((status) => {
            setRealtimeConnected(status === "SUBSCRIBED");
          });
      } catch (error) {
        if (!active) return;
        setLoading(false);
        toast({
          title: "Could not load connections",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        });
      }
    };

    void bootstrap();

    return () => {
      active = false;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [loadConnections, toast, user]);

  useEffect(() => {
    if (!tenantId) return;

    void loadPipelineDiagnostics(true);
    const interval = window.setInterval(() => {
      void loadPipelineDiagnostics();
    }, 15000);

    return () => window.clearInterval(interval);
  }, [loadPipelineDiagnostics, tenantId]);

  const openModal = () => {
    resetModal();
    setIsModalOpen(true);
  };

  const handleModalOpenChange = (open: boolean) => {
    setIsModalOpen(open);
    if (!open) resetModal();
  };

  const handleTypeSelect = (type: ConnectionType) => {
    setSelectedType(type);
    setConfigError(null);
    setTestState({ status: "idle", message: "", latencyMs: null });
    setDraft((prev) => ({
      ...prev,
      port: type === "mysql" ? "3306" : type === "postgresql" ? "5432" : prev.port,
    }));
  };

  const startConnectionSync = async (connectionId: string, triggerReason: string) => {
    const dispatchResponse = await invokeEdge("connector-sync-dispatch", {
      body: {
        connectionId,
        jobType: "schema_discovery",
        triggerReason,
        priority: 70,
        idempotencyKey: `${connectionId}:${triggerReason}:${Date.now()}`,
      },
    });

    if (!dispatchResponse.error && dispatchResponse.data?.jobId) {
      return {
        mode: "queued" as const,
        jobId: String(dispatchResponse.data.jobId),
        warning:
          typeof dispatchResponse.data.warning === "string"
            ? dispatchResponse.data.warning
            : null,
      };
    }

    const dispatchErrorMessage = dispatchResponse.error
      ? sanitizeConnectionErrorMessage(
          await formatEdgeFunctionError(dispatchResponse.error, {
            functionName: "connector-sync-dispatch",
          }),
        )
      : null;

    const fallbackResponse = await invokeEdge("run-schema-discovery", {
      body: { connectionId },
    });
    if (fallbackResponse.error) {
      const fallbackMessage = sanitizeConnectionErrorMessage(
        await formatEdgeFunctionError(fallbackResponse.error, {
          functionName: "run-schema-discovery",
        }),
      );
      throw new Error(dispatchErrorMessage ? `${dispatchErrorMessage} ${fallbackMessage}` : fallbackMessage);
    }
    if (fallbackResponse.data?.jobId) {
      return {
        mode: "queued" as const,
        jobId: String(fallbackResponse.data.jobId),
        warning:
          typeof fallbackResponse.data.warning === "string"
            ? fallbackResponse.data.warning
            : null,
      };
    }

    if (dispatchErrorMessage) throw new Error(dispatchErrorMessage);
    throw new Error("Sync request did not return a job id.");
  };

  const handleSyncNow = async (connectionId: string) => {
    if (!tenantId) return;
    setSyncingId(connectionId);

    try {
      const syncResult = await startConnectionSync(connectionId, "manual_sync");

      toast({
        title: syncResult.mode === "queued" ? "Sync queued" : "Sync completed",
        description:
          syncResult.mode === "queued"
            ? syncResult.warning
              ? `${syncResult.warning} Job: ${syncResult.jobId}.`
              : `Background job started (${syncResult.jobId}). Status will update in realtime.`
            : "Connection status refreshed.",
      });
      await loadConnections(tenantId, true);
      void loadPipelineDiagnostics(true);
    } catch (error) {
      toast({
        title: "Could not start sync",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSyncingId(null);
    }
  };

  const handleDelete = async (connectionId: string, connectionName: string) => {
    if (!tenantId) return;
    if (!window.confirm(`Delete ${connectionName}? This will also delete all knowledge documents, embeddings, and context events associated with this connection. This action cannot be undone.`)) return;

    setDeletingId(connectionId);
    try {
      const { error } = await supabase
        .from("api_connections")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("id", connectionId);

      if (error) throw error;
      toast({
        title: "Connection deleted",
        description: `${connectionName} was removed.`,
      });
      await loadConnections(tenantId, true);
      void loadPipelineDiagnostics(true);
    } catch (error) {
      toast({
        title: "Delete failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setDeletingId(null);
    }
  };

  const handleAddHeader = () => {
    setDraft((prev) => ({
      ...prev,
      customHeaders: [...prev.customHeaders, { id: crypto.randomUUID(), key: "", value: "" }],
    }));
  };

  const handleUpdateHeader = (id: string, field: "key" | "value", value: string) => {
    setDraft((prev) => ({
      ...prev,
      customHeaders: prev.customHeaders.map((header) =>
        header.id === id ? { ...header, [field]: value } : header,
      ),
    }));
  };

  const handleRemoveHeader = (id: string) => {
    setDraft((prev) => ({
      ...prev,
      customHeaders: prev.customHeaders.length === 1 ? prev.customHeaders : prev.customHeaders.filter((header) => header.id !== id),
    }));
  };

  const handleServiceAccountFile = async (file: File | null) => {
    if (!file) return;
    const text = await file.text();
    setDraft((prev) => ({
      ...prev,
      serviceAccountJson: text,
      serviceAccountFileName: file.name,
    }));
  };

  const goToConfigure = () => {
    if (!selectedType) {
      setConfigError("Select a connection type to continue.");
      return;
    }
    setConfigError(null);
    setStep(2);
  };

  const goToTest = () => {
    const error = validateConfig(selectedType, draft);
    setConfigError(error);
    if (error) return;
    setStep(3);
  };

  const runConnectionTest = async () => {
    setConfigError(null);
    const activeSession = await ensureActiveSession();
    if (!activeSession || !user) {
      toast({
        title: "Session expired",
        description: "Please sign in again to test connections.",
        variant: "destructive",
      });
      navigate("/auth/login", { replace: true });
      return;
    }

    const error = validateConfig(selectedType, draft);
    if (error) {
      setTestState({ status: "error", message: error, latencyMs: null });
      return;
    }

    setTestState({ status: "testing", message: "Testing connection...", latencyMs: null });
    try {
      const invokeBody = {
        connectionType: selectedType,
        payload: {
          base_url: draft.baseUrl.trim() || null,
          baseUrl: draft.baseUrl.trim() || null,
          host: draft.host.trim() || null,
          port: draft.port.trim() || null,
          database: draft.database.trim() || null,
          username: draft.username.trim() || null,
          password: draft.password.trim() || null,
          connection_string: draft.mongodbConnectionString.trim() || null,
          connectionString: draft.mongodbConnectionString.trim() || null,
          spreadsheet_url: draft.spreadsheetUrl.trim() || null,
          sheet_url: draft.spreadsheetUrl.trim() || null,
          integration_token: draft.notionToken.trim() || null,
          integrationToken: draft.notionToken.trim() || null,
          database_id: draft.notionDatabaseId.trim() || null,
          openapi_url: draft.openApiUrl.trim() || null,
          swagger_url: draft.openApiUrl.trim() || null,
          url:
            draft.baseUrl.trim() ||
            draft.spreadsheetUrl.trim() ||
            draft.mongodbConnectionString.trim() ||
            null,
        },
      };

      const { data, error: invokeError } = await invokeEdge("test-data-connection", {
        body: invokeBody,
      });

      if (invokeError) {
        const parsedMessage = await formatEdgeFunctionError(invokeError, { functionName: "test-data-connection" });
        throw new Error(sanitizeConnectionErrorMessage(parsedMessage));
      }

      if (!data?.success) {
        const base = typeof data?.message === "string" ? data.message : "Connection failed. Please verify credentials and endpoint.";
        const message = sanitizeConnectionErrorMessage(`${base}${detailsToMessageSuffix(data?.details)}`.trim());
        setTestState({
          status: "error",
          message,
          latencyMs: Number.isFinite(data?.latencyMs) ? Number(data.latencyMs) : null,
        });
        return;
      }

      setTestState({
        status: "success",
        message: typeof data?.message === "string" ? data.message : "Connection successful",
        latencyMs: Number.isFinite(data?.latencyMs) ? Number(data.latencyMs) : null,
      });
    } catch (err) {
      let baseMessage = err instanceof Error ? err.message : "Connection test failed.";
      if (baseMessage.toLowerCase().includes("non-2xx")) {
        baseMessage = await formatEdgeFunctionError(err, { functionName: "test-data-connection" });
      }
      const safeMessage = sanitizeConnectionErrorMessage(baseMessage);
      setTestState({
        status: "error",
        message: safeMessage,
        latencyMs: null,
      });
      if (isSessionExpiredMessage(safeMessage)) {
        const latestSession = await ensureActiveSession();
        if (!latestSession) {
          toast({
            title: "Session expired",
            description: "Please sign in again to test and save connections.",
            variant: "destructive",
          });
          navigate("/auth/login", { replace: true });
        }
      }
    }
  };

  const saveConnection = async () => {
    if (!tenantId || !selectedType) return;
    if (testState.status !== "success") return;
    const activeSession = await ensureActiveSession();
    if (!activeSession || !user) {
      toast({
        title: "Session expired",
        description: "Please sign in again to save connections.",
        variant: "destructive",
      });
      navigate("/auth/login", { replace: true });
      return;
    }

    setSavingConnection(true);

    try {
      const payload = buildInsertPayload(selectedType, draft, tenantId);
      const { data: created, error: createError } = await invokeEdge("create-data-connection", {
        body: {
          name: payload.name,
          type: payload.type,
          baseUrl: payload.base_url,
          authType: draft.authType,
          config: buildConnectionConfig(selectedType, draft),
          seedSchema: false,
          autoSync: true,
        },
      });
      if (createError) {
        const parsedCreateError = await formatEdgeFunctionError(createError, {
          functionName: "create-data-connection",
        });
        throw new Error(sanitizeConnectionErrorMessage(parsedCreateError));
      }
      if (!created?.connectionId) throw new Error("Connection created without id.");
      if (created?.queueFailed) {
        throw new Error(
          typeof created.warning === "string" && created.warning.trim().length > 0
            ? created.warning
            : "Connection was created, but schema discovery queueing failed.",
        );
      }

      toast({
        title: "Connection saved",
        description:
          typeof created.warning === "string" && created.warning.trim().length > 0
            ? created.warning
            : created.syncJobId
              ? `Schema discovery queued (${created.syncJobId}).`
              : "Schema discovery has been initialized.",
      });

      setIsModalOpen(false);
      resetModal();
      void loadConnections(tenantId, true);
      void loadPipelineDiagnostics(true);
    } catch (error) {
      toast({
        title: "Could not save connection",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSavingConnection(false);
    }
  };

  const filteredConnections = useMemo(() => {
    const query = searchValue.trim().toLowerCase();
    return connections.filter((connection) => {
      const type = connection.type.toLowerCase();
      const status = deriveEffectiveConnectionStatus(connection, connectionFacts.get(connection.id) ?? null);
      const name = connection.name.toLowerCase();
      const base = (connection.base_url ?? "").toLowerCase();
      const matchesQuery = !query || name.includes(query) || base.includes(query) || type.includes(query);
      return matchesQuery && matchesTypeFilter(type, typeFilter) && matchesStatusFilter(status, statusFilter);
    });
  }, [connectionFacts, connections, searchValue, statusFilter, typeFilter]);

  const stats = useMemo(() => {
    const total = connections.length;
    const active = connections.filter(
      (connection) => deriveEffectiveConnectionStatus(connection, connectionFacts.get(connection.id) ?? null) === "active",
    ).length;
    const syncing = connections.filter(
      (connection) => deriveEffectiveConnectionStatus(connection, connectionFacts.get(connection.id) ?? null) === "syncing",
    ).length;
    const errors = connections.filter(
      (connection) => deriveEffectiveConnectionStatus(connection, connectionFacts.get(connection.id) ?? null) === "error",
    ).length;
    return { total, active, syncing, errors };
  }, [connectionFacts, connections]);

  const pipelineIssueConnections = useMemo(() => {
    const rows = pipelineDiagnostics?.connections ?? [];
    return [...rows].sort((a, b) => {
      const rank = (value: PipelineConnectionHealth["healthState"]) =>
        value === "failing" ? 0 : value === "degraded" ? 1 : 2;
      return rank(a.healthState) - rank(b.healthState);
    });
  }, [pipelineDiagnostics]);

  const metricsByConnection = useMemo(() => {
    const map = new Map<
      string,
      {
        queriesToday: number;
        embeddingsIndexed: number;
        syncLag: string;
      }
    >();

    for (const connection of connections) {
      map.set(connection.id, {
        queriesToday: connection.queries_today ?? 0,
        embeddingsIndexed: connection.embeddings_indexed ?? 0,
        syncLag: formatSyncLag(connection.sync_lag_seconds ?? 0, connection.last_synced_at),
      });
    }

    return map;
  }, [connections]);

  const selectedTypeMeta = useMemo(
    () => TYPE_OPTIONS.find((option) => option.value === selectedType) ?? null,
    [selectedType],
  );

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Data Connections</h1>
            <p className="mt-1 text-sm text-slate-500">Connect APIs and databases powering your AI workspace.</p>
          </div>
          <Button onClick={openModal} className="gap-2 bg-violet-600 text-white hover:bg-violet-700">
            <Plus className="h-4 w-4" />
            Add Connection
          </Button>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Total Connected</p>
          {loading ? <Skeleton className="mt-3 h-8 w-16" /> : <p className="mt-2 text-3xl font-semibold text-slate-900">{stats.total}</p>}
        </article>
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Active</p>
          {loading ? <Skeleton className="mt-3 h-8 w-16" /> : <p className="mt-2 text-3xl font-semibold text-emerald-600">{stats.active}</p>}
        </article>
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Syncing</p>
          {loading ? <Skeleton className="mt-3 h-8 w-16" /> : <p className="mt-2 text-3xl font-semibold text-blue-600">{stats.syncing}</p>}
        </article>
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Errors</p>
          {loading ? <Skeleton className="mt-3 h-8 w-16" /> : <p className="mt-2 text-3xl font-semibold text-rose-600">{stats.errors}</p>}
        </article>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-[1fr_220px_220px]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={searchValue}
              onChange={(event) => setSearchValue(event.target.value)}
              placeholder="Search by connection name or URL"
              className="pl-9"
            />
          </div>

          <Select value={typeFilter} onValueChange={(value) => setTypeFilter(value as TypeFilterValue)}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="rest_api">REST API</SelectItem>
              <SelectItem value="postgresql">PostgreSQL</SelectItem>
              <SelectItem value="mysql">MySQL</SelectItem>
              <SelectItem value="mongodb">MongoDB</SelectItem>
              <SelectItem value="google_sheets">Sheets</SelectItem>
              <SelectItem value="notion">Notion</SelectItem>
              <SelectItem value="firebase">Firebase</SelectItem>
              <SelectItem value="custom_rest">Custom REST</SelectItem>
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilterValue)}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="error">Error</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className={cn("inline-flex h-2.5 w-2.5 rounded-full", realtimeConnected ? "bg-emerald-500" : "bg-slate-300")} />
        {realtimeConnected ? "Realtime updates connected" : "Realtime updates reconnecting..."}
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Pipeline Health</p>
            <p className="text-xs text-slate-500">
              Root-cause diagnostics from connector jobs, sync runs, schema, embeddings, and agent readiness.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void loadPipelineDiagnostics(true)}
              disabled={pipelineLoading}
            >
              {pipelineLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Refresh
            </Button>
            <span className="text-[11px] text-slate-500">
              Updated {pipelineLastUpdatedAt ? formatRelativeTime(pipelineLastUpdatedAt) : "never"}
            </span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Total</p>
            <p className="text-sm font-semibold text-slate-900">{pipelineDiagnostics?.summary.totalConnections ?? 0}</p>
          </div>
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-rose-600">Failing</p>
            <p className="text-sm font-semibold text-rose-700">{pipelineDiagnostics?.summary.failingConnections ?? 0}</p>
          </div>
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-amber-700">Open Issues</p>
            <p className="text-sm font-semibold text-amber-800">{pipelineDiagnostics?.summary.openIssues ?? 0}</p>
          </div>
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-emerald-600">Healthy</p>
            <p className="text-sm font-semibold text-emerald-700">{pipelineDiagnostics?.summary.healthyConnections ?? 0}</p>
          </div>
        </div>

        {pipelineLoading && !pipelineDiagnostics ? (
          <div className="mt-3 space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : pipelineError ? (
          <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {pipelineError}
          </div>
        ) : pipelineIssueConnections.length === 0 ? (
          <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            No active pipeline issues detected.
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            {pipelineIssueConnections.slice(0, 6).map((item) => {
              const primaryIssue = item.issues[0];
              if (!primaryIssue) return null;
              return (
                <article key={item.connection.id} className="rounded-lg border border-slate-200 px-3 py-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link to={`/dashboard/connections/${item.connection.id}`} className="text-sm font-semibold text-slate-900 hover:underline">
                        {item.connection.name}
                      </Link>
                      <p className="text-xs text-slate-500">
                        {connectionTypeLabel(item.connection.type)} · {item.connection.status}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge className={cn("border-0", pipelineHealthBadgeClass(item.healthState))}>{item.healthState}</Badge>
                      <Badge className={cn("border-0", pipelineSeverityBadgeClass(primaryIssue.severity))}>{primaryIssue.severity}</Badge>
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-slate-800">{primaryIssue.message}</p>
                  <p className="mt-1 text-xs text-slate-600">Action: {primaryIssue.remediation}</p>
                  {item.issues.length > 1 ? (
                    <p className="mt-1 text-[11px] text-slate-500">+{item.issues.length - 1} additional issue(s)</p>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {loading ? (
        <section className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <article key={index} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="mt-3 h-4 w-1/3" />
              <Skeleton className="mt-5 h-16 w-full" />
              <div className="mt-4 grid grid-cols-3 gap-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            </article>
          ))}
        </section>
      ) : filteredConnections.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 shadow-sm">
          <div className="mx-auto flex max-w-md flex-col items-center text-center">
            <span className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-violet-100 text-violet-700">
              <Bot className="h-7 w-7" />
            </span>
            <h2 className="mt-4 text-xl font-semibold text-slate-900">No connections yet</h2>
            <p className="mt-2 text-sm text-slate-500">
              Add your first data source to start schema discovery, entity classification, and governed AI actions.
            </p>
            <Button onClick={openModal} className="mt-6 bg-violet-600 text-white hover:bg-violet-700">
              Add your first data source
            </Button>
          </div>
        </section>
      ) : (
        <section className="grid gap-4 md:grid-cols-2">
          {filteredConnections.map((connection) => {
            const typeVisual = getTypeVisual(connection.type);
            const facts = connectionFacts.get(connection.id) ?? null;
            const effectiveStatus = deriveEffectiveConnectionStatus(connection, facts);
            const status = statusView(effectiveStatus);
            const entityCount = facts?.entityCount ?? Math.max(0, connection.schema_entities_count ?? 0);
            const metrics = metricsByConnection.get(connection.id) ?? {
              queriesToday: 0,
              embeddingsIndexed: 0,
              syncLag: "N/A",
            };

            return (
              <article key={connection.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className={cn("inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl", typeVisual.bgClass)}>
                      <typeVisual.icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="truncate text-base font-semibold text-slate-900">{connection.name}</h3>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {connectionTypeLabel(connection.type)}
                        <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
                          {typeVisual.accent}
                        </span>
                      </p>
                    </div>
                  </div>
                  <Badge className={cn("border-0", status.className)}>
                    {status.spinning && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                    {status.label}
                  </Badge>
                </div>

                <div className="mt-4 rounded-lg bg-slate-50 p-3">
                  <p className="text-sm font-medium text-slate-800">{schemaSummary(entityCount, effectiveStatus)}</p>
                  <p className="mt-1 text-xs text-slate-500">Last synced: {formatRelativeTime(connection.last_synced_at)}</p>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2">
                  <div className="rounded-lg border border-slate-200 p-2">
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">Queries today</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{metrics.queriesToday}</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-2">
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">Embeddings</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{metrics.embeddingsIndexed}</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-2">
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">Sync lag</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{metrics.syncLag}</p>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/dashboard/connections/${connection.id}`}>View Schema</Link>
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void handleSyncNow(connection.id)} disabled={syncingId === connection.id}>
                    {syncingId === connection.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Sync Now
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link to="/dashboard/settings">
                      <Settings className="h-3.5 w-3.5" />
                      Settings
                    </Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => void handleDelete(connection.id, connection.name)}
                    disabled={deletingId === connection.id}
                  >
                    {deletingId === connection.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    Delete
                  </Button>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {!loading && filteredConnections.length > 0 && stats.errors > 0 && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <div className="inline-flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            Some connections are in error state. Review settings or run manual sync.
          </div>
        </div>
      )}

      <Dialog open={isModalOpen} onOpenChange={handleModalOpenChange}>
        <DialogContent className="w-[min(640px,calc(100vw-1.5rem))] max-w-[640px] border-slate-200 p-0 sm:rounded-xl">
          <DialogHeader className="border-b border-slate-200 px-6 py-5">
            <DialogTitle className="text-left text-xl text-slate-900">Add New Connection</DialogTitle>
            <DialogDescription className="text-left text-sm text-slate-500">
              Configure and verify a secure data source for your workspace.
            </DialogDescription>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {[
                { id: 1, label: "Choose Type" },
                { id: 2, label: "Configure" },
                { id: 3, label: "Test & Save" },
              ].map((item) => (
                <div key={item.id} className="flex items-center gap-2">
                  <span
                    className={cn(
                      "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold",
                      step >= item.id ? "bg-violet-600 text-white" : "bg-slate-200 text-slate-500",
                    )}
                  >
                    {item.id}
                  </span>
                  <span className={cn("text-xs", step >= item.id ? "text-slate-700" : "text-slate-500")}>{item.label}</span>
                </div>
              ))}
            </div>
          </DialogHeader>

          <div className="max-h-[70vh] overflow-y-auto px-6 py-5">
            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={{ opacity: 0, x: 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -24 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                className="space-y-4"
              >
                {step === 1 && (
                  <div className="space-y-4">
                    <p className="text-sm font-medium text-slate-700">Choose connection type</p>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                      {TYPE_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => handleTypeSelect(option.value)}
                          className={cn(
                            "rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
                            selectedType === option.value
                              ? "border-violet-500 bg-violet-50"
                              : "border-slate-200 hover:bg-slate-50",
                          )}
                        >
                          <span className={cn("inline-flex h-9 w-9 items-center justify-center rounded-lg", option.accent)}>
                            <option.icon className="h-5 w-5" />
                          </span>
                          <p className="mt-2 text-sm font-semibold text-slate-900">{option.label}</p>
                          <p className="mt-1 text-xs text-slate-500">{option.description}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {step === 2 && selectedType && (
                  <div className="space-y-4">
                    <div>
                      <p className="text-sm font-medium text-slate-700">Configure {selectedTypeMeta?.label}</p>
                      <p className="text-xs text-slate-500">Fields update based on your selected connection type.</p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="connection-name">Connection Name</Label>
                      <Input
                        id="connection-name"
                        value={draft.name}
                        onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                        placeholder="Finance Production DB"
                      />
                    </div>

                    {(selectedType === "rest_openapi" || selectedType === "custom_rest") && (
                      <>
                        <div className="space-y-2">
                          <Label htmlFor="base-url">Base URL</Label>
                          <Input
                            id="base-url"
                            value={draft.baseUrl}
                            onChange={(event) => setDraft((prev) => ({ ...prev, baseUrl: event.target.value }))}
                            placeholder="https://api.company.com"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label>Authentication Type</Label>
                          <Select value={draft.authType} onValueChange={(value) => setDraft((prev) => ({ ...prev, authType: value as AuthType }))}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">None</SelectItem>
                              <SelectItem value="api_key">API Key</SelectItem>
                              <SelectItem value="bearer_token">Bearer Token</SelectItem>
                              <SelectItem value="basic_auth">Basic Auth</SelectItem>
                              <SelectItem value="oauth2">OAuth2</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        {draft.authType === "api_key" && (
                          <div className="space-y-2">
                            <Label>API Key</Label>
                            <Input
                              type="password"
                              value={draft.apiKey}
                              onChange={(event) => setDraft((prev) => ({ ...prev, apiKey: event.target.value }))}
                              placeholder="sk_live_xxx"
                            />
                          </div>
                        )}

                        {draft.authType === "bearer_token" && (
                          <div className="space-y-2">
                            <Label>Bearer Token</Label>
                            <Input
                              type="password"
                              value={draft.bearerToken}
                              onChange={(event) => setDraft((prev) => ({ ...prev, bearerToken: event.target.value }))}
                              placeholder="Bearer ..."
                            />
                          </div>
                        )}

                        {draft.authType === "basic_auth" && (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                              <Label>Username</Label>
                              <Input
                                value={draft.basicUsername}
                                onChange={(event) => setDraft((prev) => ({ ...prev, basicUsername: event.target.value }))}
                                placeholder="api-user"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>Password</Label>
                              <Input
                                type="password"
                                value={draft.basicPassword}
                                onChange={(event) => setDraft((prev) => ({ ...prev, basicPassword: event.target.value }))}
                                placeholder="••••••••"
                              />
                            </div>
                          </div>
                        )}

                        {draft.authType === "oauth2" && (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                              <Label>Client ID</Label>
                              <Input
                                value={draft.oauthClientId}
                                onChange={(event) => setDraft((prev) => ({ ...prev, oauthClientId: event.target.value }))}
                                placeholder="oauth-client-id"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>Client Secret</Label>
                              <Input
                                type="password"
                                value={draft.oauthClientSecret}
                                onChange={(event) => setDraft((prev) => ({ ...prev, oauthClientSecret: event.target.value }))}
                                placeholder="oauth-client-secret"
                              />
                            </div>
                          </div>
                        )}

                        <div className="space-y-2">
                          <Label>OpenAPI Spec URL (optional)</Label>
                          <Input
                            value={draft.openApiUrl}
                            onChange={(event) => setDraft((prev) => ({ ...prev, openApiUrl: event.target.value }))}
                            placeholder="https://api.company.com/openapi.json"
                          />
                          <p className="text-xs text-slate-500">We'll auto-parse your endpoints.</p>
                        </div>

                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <Label>Custom Headers</Label>
                            <Button type="button" size="sm" variant="outline" onClick={handleAddHeader}>
                              <Plus className="h-3.5 w-3.5" />
                              Add Header
                            </Button>
                          </div>
                          {draft.customHeaders.map((header) => (
                            <div key={header.id} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                              <Input
                                value={header.key}
                                onChange={(event) => handleUpdateHeader(header.id, "key", event.target.value)}
                                placeholder="Header"
                              />
                              <Input
                                value={header.value}
                                onChange={(event) => handleUpdateHeader(header.id, "value", event.target.value)}
                                placeholder="Value"
                              />
                              <Button type="button" variant="outline" size="icon" onClick={() => handleRemoveHeader(header.id)}>
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    {(selectedType === "postgresql" || selectedType === "mysql") && (
                      <>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-2">
                            <Label>Host</Label>
                            <Input
                              value={draft.host}
                              onChange={(event) => setDraft((prev) => ({ ...prev, host: event.target.value }))}
                              placeholder="db.company.internal"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Port</Label>
                            <Input
                              value={draft.port}
                              onChange={(event) => setDraft((prev) => ({ ...prev, port: event.target.value }))}
                              placeholder={selectedType === "mysql" ? "3306" : "5432"}
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label>Database</Label>
                          <Input
                            value={draft.database}
                            onChange={(event) => setDraft((prev) => ({ ...prev, database: event.target.value }))}
                            placeholder="finance_prod"
                          />
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-2">
                            <Label>Username</Label>
                            <Input
                              value={draft.username}
                              onChange={(event) => setDraft((prev) => ({ ...prev, username: event.target.value }))}
                              placeholder="readonly_user"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Password</Label>
                            <Input
                              type="password"
                              value={draft.password}
                              onChange={(event) => setDraft((prev) => ({ ...prev, password: event.target.value }))}
                              placeholder="••••••••"
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label>SSL Mode</Label>
                          <Select
                            value={draft.sslMode}
                            onValueChange={(value) =>
                              setDraft((prev) => ({ ...prev, sslMode: value as ConnectionDraft["sslMode"] }))
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="disable">Disable</SelectItem>
                              <SelectItem value="require">Require</SelectItem>
                              <SelectItem value="verify-full">Verify Full</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                          <div>
                            <p className="text-sm font-medium text-slate-800">SSH Tunnel</p>
                            <p className="text-xs text-slate-500">Advanced secure tunnel via bastion host.</p>
                          </div>
                          <Switch checked={draft.sshTunnel} onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, sshTunnel: checked }))} />
                        </div>
                      </>
                    )}

                    {selectedType === "google_sheets" && (
                      <>
                        <div className="space-y-2">
                          <Label>Spreadsheet URL</Label>
                          <Input
                            value={draft.spreadsheetUrl}
                            onChange={(event) => setDraft((prev) => ({ ...prev, spreadsheetUrl: event.target.value }))}
                            placeholder="https://docs.google.com/spreadsheets/d/..."
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Service Account JSON</Label>
                          <Input type="file" accept=".json,application/json" onChange={(event) => void handleServiceAccountFile(event.target.files?.[0] ?? null)} />
                          {draft.serviceAccountFileName && <p className="text-xs text-slate-500">Loaded file: {draft.serviceAccountFileName}</p>}
                          <Textarea
                            value={draft.serviceAccountJson}
                            onChange={(event) => setDraft((prev) => ({ ...prev, serviceAccountJson: event.target.value }))}
                            placeholder='Paste JSON here, e.g. {"type":"service_account", ...}'
                            className="min-h-[120px]"
                          />
                        </div>
                      </>
                    )}

                    {selectedType === "mongodb" && (
                      <div className="space-y-2">
                        <Label>Connection String</Label>
                        <Input
                          value={draft.mongodbConnectionString}
                          onChange={(event) => setDraft((prev) => ({ ...prev, mongodbConnectionString: event.target.value }))}
                          placeholder="mongodb+srv://user:pass@cluster.mongodb.net/db"
                        />
                      </div>
                    )}

                    {selectedType === "notion" && (
                      <>
                        <div className="space-y-2">
                          <Label>Integration Token</Label>
                          <Input
                            type="password"
                            value={draft.notionToken}
                            onChange={(event) => setDraft((prev) => ({ ...prev, notionToken: event.target.value }))}
                            placeholder="secret_..."
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Database ID</Label>
                          <Input
                            value={draft.notionDatabaseId}
                            onChange={(event) => setDraft((prev) => ({ ...prev, notionDatabaseId: event.target.value }))}
                            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                          />
                        </div>
                      </>
                    )}

                    {selectedType === "firebase" && (
                      <>
                        <div className="space-y-2">
                          <Label>Project ID</Label>
                          <Input
                            value={draft.firebaseProjectId}
                            onChange={(event) => setDraft((prev) => ({ ...prev, firebaseProjectId: event.target.value }))}
                            placeholder="my-firebase-project"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Service Account JSON</Label>
                          <Input type="file" accept=".json,application/json" onChange={(event) => void handleServiceAccountFile(event.target.files?.[0] ?? null)} />
                          <Textarea
                            value={draft.serviceAccountJson}
                            onChange={(event) => setDraft((prev) => ({ ...prev, serviceAccountJson: event.target.value }))}
                            placeholder='Paste JSON here, e.g. {"project_id":"..."}'
                            className="min-h-[120px]"
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}

                {step === 3 && (
                  <div className="space-y-4">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm font-medium text-slate-800">{draft.name || "Unnamed connection"}</p>
                      <p className="mt-1 text-xs text-slate-500">{selectedTypeMeta?.label ?? "Connection"}</p>
                      <p className="mt-2 text-xs text-slate-500">
                        {selectedType === "postgresql" || selectedType === "mysql"
                          ? `${draft.host}:${draft.port}/${draft.database}`
                          : draft.baseUrl || draft.spreadsheetUrl || draft.mongodbConnectionString || draft.notionDatabaseId || draft.firebaseProjectId || "Configured source"}
                      </p>
                    </div>

                    <div className="rounded-lg border border-slate-200 p-4">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-slate-800">Connection Test</p>
                        {testState.status === "success" && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
                        {testState.status === "error" && <AlertCircle className="h-4 w-4 text-rose-600" />}
                      </div>
                      <p
                        className={cn(
                          "mt-2 text-sm",
                          testState.status === "success" && "text-emerald-700",
                          testState.status === "error" && "text-rose-700",
                          (testState.status === "idle" || testState.status === "testing") && "text-slate-600",
                        )}
                      >
                        {testState.status === "idle" && "Run a connection test before saving."}
                        {testState.status === "testing" && "Testing connection..."}
                        {testState.status === "success" && `${testState.message}${testState.latencyMs ? ` (${testState.latencyMs}ms)` : ""}`}
                        {testState.status === "error" && testState.message}
                      </p>
                    </div>

                    {savingConnection && (
                      <div className="rounded-lg border border-violet-200 bg-violet-50 p-4">
                        <div className="inline-flex items-center gap-2 text-sm font-medium text-violet-800">
                          <Sparkles className="h-4 w-4" />
                          Queueing background schema discovery
                        </div>
                        <p className="mt-2 text-sm text-violet-700">
                          Your connector metadata will be discovered by the worker queue. You can track real stage updates from
                          the connection detail page.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="flex items-start justify-between gap-3 border-t border-slate-200 px-6 py-4">
            <div className="min-w-0 flex-1 pr-1">
              {(configError || (step !== 3 && testState.status === "error")) && (
                <p className="break-words text-xs text-rose-600">{configError ?? testState.message}</p>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              {step > 1 && (
                <Button variant="outline" onClick={() => setStep((prev) => (prev === 3 ? 2 : 1))} disabled={savingConnection}>
                  Back
                </Button>
              )}
              {step === 1 && (
                <Button onClick={goToConfigure} disabled={!selectedType} className="bg-violet-600 text-white hover:bg-violet-700">
                  Continue
                </Button>
              )}
              {step === 2 && (
                <Button onClick={goToTest} className="bg-violet-600 text-white hover:bg-violet-700">
                  Continue to Test
                </Button>
              )}
              {step === 3 && (
                <>
                  <Button variant="outline" onClick={() => void runConnectionTest()} disabled={testState.status === "testing" || savingConnection}>
                    {testState.status === "testing" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Test Connection
                  </Button>
                  <Button onClick={() => void saveConnection()} disabled={testState.status !== "success" || savingConnection} className="bg-violet-600 text-white hover:bg-violet-700">
                    {savingConnection ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Save Connection
                  </Button>
                </>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
