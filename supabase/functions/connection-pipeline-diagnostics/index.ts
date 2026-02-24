import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";

type Operation = "get_payload";

type RequestBody = {
  operation?: Operation;
  connectionId?: string;
  includeHealthy?: boolean;
};

type AuthedClient = Awaited<ReturnType<typeof getAuthedClient>> & { ok: true };

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function minutesSince(iso: string | null | undefined) {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 60_000));
}

function inferProblemCategory(text: string | null | undefined) {
  const value = clean(text).toLowerCase();
  if (!value) return null;
  if (value.includes("enotfound") || value.includes("eai_again") || value.includes("dns")) return "network_dns";
  if (value.includes("timeout") || value.includes("timed out") || value.includes("connect timeout")) return "network_timeout";
  if (value.includes("401") || value.includes("403") || value.includes("forbidden") || value.includes("unauthorized")) {
    return "auth_failure";
  }
  if (
    value.includes("zero entities") ||
    value.includes("no readable entities") ||
    (value.includes("no ") && value.includes(" discovered"))
  ) {
    return "empty_schema";
  }
  return "unknown";
}

function remediationFor(category: string) {
  switch (category) {
    case "network_dns":
      return "Verify worker host DNS resolution and outbound network access to Supabase + connector source.";
    case "network_timeout":
      return "Increase timeout and validate connector/source latency, firewall, and TLS negotiation.";
    case "auth_failure":
      return "Rotate credentials, verify token scopes, and re-test the connection payload.";
    case "empty_schema":
      return "Verify source permissions and visibility for tables/entities/collections.";
    default:
      return "Inspect latest connector job + sync run details and retry schema discovery.";
  }
}

function isMissingColumnError(error: { code?: string | null; message?: string | null } | null) {
  if (!error) return false;
  const code = String(error.code ?? "");
  const message = String(error.message ?? "").toLowerCase();
  return code === "42703" || code === "PGRST204" || (message.includes("column") && message.includes("does not exist"));
}

async function loadConnectionsWithFallback(auth: AuthedClient, tenantId: string, connectionId: string) {
  let query = auth.supabase
    .from("api_connections")
    .select(
      "id,name,type,status,health,schema_detected,schema_entities_count,embeddings_indexed,last_error,last_synced_at,next_sync_at,analysis_started_at,analysis_completed_at,sync_frequency,updated_at,is_archived",
    )
    .eq("tenant_id", tenantId)
    .eq("is_archived", false)
    .order("updated_at", { ascending: false })
    .limit(150);

  if (connectionId) query = query.eq("id", connectionId);
  const primary = await query;
  if (!primary.error) return primary.data ?? [];
  if (!isMissingColumnError(primary.error)) throw primary.error;

  let fallbackQuery = auth.supabase
    .from("api_connections")
    .select("id,name,type,status,last_synced_at,updated_at")
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false })
    .limit(150);
  if (connectionId) fallbackQuery = fallbackQuery.eq("id", connectionId);
  const fallback = await fallbackQuery;
  if (fallback.error) throw fallback.error;

  return (fallback.data ?? []).map((row) => ({
    ...row,
    health: "healthy",
    schema_detected: false,
    schema_entities_count: 0,
    embeddings_indexed: 0,
    last_error: null,
    next_sync_at: null,
    analysis_started_at: null,
    analysis_completed_at: null,
    sync_frequency: "hourly",
    is_archived: false,
  }));
}

async function loadConnectorJobsWithFallback(auth: AuthedClient, tenantId: string, connectionIds: string[]) {
  const primary = await auth.supabase
    .from("connector_jobs")
    .select("id,connection_id,status,attempt_count,max_attempts,last_error,scheduled_at,updated_at,result")
    .eq("tenant_id", tenantId)
    .in("connection_id", connectionIds)
    .order("updated_at", { ascending: false })
    .limit(800);
  if (!primary.error) return (primary.data ?? []) as Array<Record<string, unknown>>;
  if (!isMissingColumnError(primary.error)) throw primary.error;

  const fallback = await auth.supabase
    .from("connector_jobs")
    .select("id,connection_id,status,attempt_count,max_attempts,last_error,scheduled_at,created_at,result")
    .eq("tenant_id", tenantId)
    .in("connection_id", connectionIds)
    .order("created_at", { ascending: false })
    .limit(800);
  if (fallback.error) throw fallback.error;
  return (fallback.data ?? []).map((row) => ({
    ...row,
    updated_at: row.created_at ?? null,
  })) as Array<Record<string, unknown>>;
}

async function loadSyncRunsWithFallback(auth: AuthedClient, tenantId: string, connectionIds: string[]) {
  const primary = await auth.supabase
    .from("connection_sync_runs")
    .select("id,connection_id,status,error_message,started_at,finished_at,updated_at,details")
    .eq("tenant_id", tenantId)
    .in("connection_id", connectionIds)
    .order("updated_at", { ascending: false })
    .limit(400);
  if (!primary.error) return (primary.data ?? []) as Array<Record<string, unknown>>;
  if (!isMissingColumnError(primary.error)) throw primary.error;

  const fallback = await auth.supabase
    .from("connection_sync_runs")
    .select("id,connection_id,status,error_message,started_at,finished_at,details")
    .eq("tenant_id", tenantId)
    .in("connection_id", connectionIds)
    .order("started_at", { ascending: false })
    .limit(400);
  if (fallback.error) throw fallback.error;
  return (fallback.data ?? []).map((row) => ({
    ...row,
    updated_at: row.finished_at ?? row.started_at ?? null,
  })) as Array<Record<string, unknown>>;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const operation = clean(body.operation || "get_payload").toLowerCase() as Operation;
  if (operation !== "get_payload") return errorResponse(400, "Unsupported operation");

  const connectionId = clean(body.connectionId);
  if (connectionId && !isUuid(connectionId)) return errorResponse(400, "connectionId must be a valid UUID");
  const includeHealthy = Boolean(body.includeHealthy);

  const { data: tenantId, error: tenantError } = await auth.supabase.rpc("get_user_tenant_id");
  if (tenantError || !tenantId) {
    return errorResponse(400, "Could not resolve tenant context", tenantError?.message ?? null);
  }

  let connections: Array<Record<string, unknown>> = [];
  try {
    connections = await loadConnectionsWithFallback(auth, String(tenantId), connectionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load connections";
    return errorResponse(400, "Could not load connections", message);
  }

  const connectionIds = (connections ?? []).map((row) => String(row.id));
  if (connectionIds.length === 0) {
    return jsonResponse(200, {
      ok: true,
      operation,
      payload: {
        summary: {
          totalConnections: 0,
          failingConnections: 0,
          healthyConnections: 0,
          openIssues: 0,
        },
        connections: [],
        global: {
          readyAgents: 0,
          totalAgents: 0,
          embeddingHealth: null,
        },
      },
    });
  }

  let jobsData: Array<Record<string, unknown>> = [];
  let syncData: Array<Record<string, unknown>> = [];
  let agentsResult: any = null;
  let embeddingResult: any = null;

  try {
    const [loadedJobs, loadedSync, loadedAgents, loadedEmbedding] = await Promise.all([
      loadConnectorJobsWithFallback(auth, String(tenantId), connectionIds),
      loadSyncRunsWithFallback(auth, String(tenantId), connectionIds),
      auth.supabase
        .from("ai_agents")
        .select("id,status,lifecycle_reason,last_regenerated_at")
        .eq("tenant_id", tenantId),
      auth.supabase.rpc("get_knowledge_embedding_health", { p_tenant_id: tenantId }),
    ]);
    jobsData = loadedJobs;
    syncData = loadedSync;
    agentsResult = loadedAgents;
    embeddingResult = loadedEmbedding;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load diagnostics payload";
    return errorResponse(400, "Could not load diagnostics payload", message);
  }

  if (!agentsResult) return errorResponse(400, "Could not load agents", "Missing agents query result");
  if (agentsResult.error) return errorResponse(400, "Could not load agents", agentsResult.error.message);

  const latestJobByConnection = new Map<string, Record<string, unknown>>();
  for (const row of jobsData ?? []) {
    const key = String(row.connection_id);
    if (!latestJobByConnection.has(key)) latestJobByConnection.set(key, row);
  }

  const latestSyncByConnection = new Map<string, Record<string, unknown>>();
  for (const row of syncData ?? []) {
    const key = String(row.connection_id);
    if (!latestSyncByConnection.has(key)) latestSyncByConnection.set(key, row);
  }

  const readyAgents = (agentsResult.data ?? []).filter((row) => String(row.status || "").toLowerCase() === "ready").length;
  const totalAgents = (agentsResult.data ?? []).length;

  const evaluated = (connections ?? []).map((connection) => {
    const id = String(connection.id);
    const latestJob = latestJobByConnection.get(id) ?? null;
    const latestSync = latestSyncByConnection.get(id) ?? null;
    const issues: Array<{
      severity: "critical" | "high" | "medium" | "low";
      code: string;
      message: string;
      remediation: string;
    }> = [];

    const connStatus = clean(connection.status).toLowerCase();
    const connHealth = clean(connection.health).toLowerCase();
    const connError = clean(connection.last_error);
    const schemaDetected = Boolean(connection.schema_detected);
    const schemaEntitiesCount = Number(connection.schema_entities_count ?? 0);
    const embeddingsIndexed = Number(connection.embeddings_indexed ?? 0);

    if (connStatus === "error" || connHealth === "degraded") {
      const category = inferProblemCategory(connError || clean(latestSync?.error_message) || clean(latestJob?.last_error)) ?? "unknown";
      issues.push({
        severity: "high",
        code: category,
        message: connError || "Connection is degraded/error",
        remediation: remediationFor(category),
      });
    }

    if (!schemaDetected && clean(connection.analysis_completed_at)) {
      issues.push({
        severity: "high",
        code: "schema_not_detected",
        message: "Schema discovery completed but schema is not detected.",
        remediation: "Run schema discovery, then validate source permissions and entity visibility.",
      });
    }

    if (schemaDetected && schemaEntitiesCount > 0 && embeddingsIndexed === 0) {
      issues.push({
        severity: "medium",
        code: "embedding_backlog",
        message: "Schema detected but no embeddings indexed yet.",
        remediation: "Check embedding worker health and OPENAI_API_KEY; then run embedding reindex.",
      });
    }

    if (latestJob) {
      const jobStatus = clean(latestJob.status).toLowerCase();
      const updatedMins = minutesSince(String(latestJob.updated_at || ""));
      if (jobStatus === "running" && updatedMins !== null && updatedMins > 20) {
        issues.push({
          severity: "high",
          code: "stale_running_job",
          message: `Latest connector job has been running for ${updatedMins} minutes.`,
          remediation: "Verify worker process is alive; recover stale jobs if needed.",
        });
      } else if (jobStatus === "queued" && updatedMins !== null && updatedMins > 30) {
        issues.push({
          severity: "medium",
          code: "stuck_queue",
          message: `Latest connector job has been queued for ${updatedMins} minutes.`,
          remediation: "Check worker scheduler and queue claim health.",
        });
      }
    }

    if (latestSync) {
      const syncStatus = clean(latestSync.status).toLowerCase();
      const syncError = clean(latestSync.error_message);
      if (syncStatus === "error") {
        const category = inferProblemCategory(syncError) ?? "sync_error";
        issues.push({
          severity: "high",
          code: category,
          message: syncError || "Latest sync run ended in error.",
          remediation: remediationFor(category),
        });
      }
    }

    if (schemaDetected && readyAgents === 0) {
      issues.push({
        severity: "medium",
        code: "agents_not_ready",
        message: "Schema is detected but no agents are in ready state.",
        remediation: "Check regenerate_agents_for_tenant and agent lifecycle reasons.",
      });
    }

    const healthState = issues.some((issue) => issue.severity === "critical" || issue.severity === "high")
      ? "failing"
      : issues.length > 0
        ? "degraded"
        : "healthy";

    return {
      connection: {
        id,
        name: String(connection.name ?? "Connection"),
        type: String(connection.type ?? "unknown"),
        status: connStatus || "unknown",
        health: connHealth || "unknown",
        schemaDetected,
        schemaEntitiesCount,
        embeddingsIndexed,
        syncFrequency: String(connection.sync_frequency ?? "hourly"),
        lastError: connError || null,
        updatedAt: connection.updated_at ?? null,
      },
      latestJob,
      latestSync,
      healthState,
      issues,
    };
  });

  const filtered = includeHealthy ? evaluated : evaluated.filter((item) => item.issues.length > 0);
  const failingConnections = evaluated.filter((item) => item.healthState === "failing").length;
  const healthyConnections = evaluated.filter((item) => item.healthState === "healthy").length;
  const openIssues = evaluated.reduce((acc, item) => acc + item.issues.length, 0);

  return jsonResponse(200, {
    ok: true,
    operation,
    payload: {
      summary: {
        totalConnections: evaluated.length,
        failingConnections,
        healthyConnections,
        openIssues,
      },
      global: {
        readyAgents,
        totalAgents,
        embeddingHealth: embeddingResult?.error ? null : (embeddingResult?.data?.[0] ?? null),
      },
      connections: filtered,
    },
  });
});
