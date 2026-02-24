import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

const ALLOWED_AUTH_TYPES = new Set(["none", "api_key", "bearer_token", "basic_auth", "oauth2"]);

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeConnectionType(raw: string) {
  const value = raw.trim().toLowerCase();
  if (value === "rest" || value === "rest_api" || value === "rest_openapi") return "rest_openapi";
  if (value === "custom_rest_api") return "custom_rest";
  if (value === "sheets") return "google_sheets";
  return value;
}

function parseJsonString(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function validateUrl(value: string) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function clampPriority(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(100, Math.round(value)));
}

function isMissingColumnError(error: { code?: string | null; message?: string | null } | null) {
  if (!error) return false;
  const code = String(error.code ?? "");
  const message = String(error.message ?? "").toLowerCase();
  return code === "42703" || code === "PGRST204" || message.includes("column") && message.includes("does not exist");
}

async function resolveTenantIdByUserId(
  supabase: Pick<SupabaseClient, "from">,
  userId: string,
) {
  const { data, error } = await supabase
    .from("profiles")
    .select("tenant_id")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data?.tenant_id) return null;
  return String(data.tenant_id);
}

async function countLiveConnections(
  supabase: Pick<SupabaseClient, "from">,
  tenantId: string,
) {
  const withArchive = await supabase
    .from("api_connections")
    .select("id,name,type,base_url,status,is_archived")
    .eq("tenant_id", tenantId);

  if (!withArchive.error) {
    const rows = (withArchive.data ?? []) as Array<{
      id: string;
      name: string | null;
      type?: string | null;
      base_url?: string | null;
      status?: string | null;
      is_archived?: boolean | null;
    }>;
    const active = rows.filter((row) => row.is_archived !== true);
    return {
      count: active.length,
      names: active.map((row) => String(row.name ?? "Connection")),
      rows: active.map((row) => ({
        id: String(row.id),
        name: String(row.name ?? "Connection"),
        type: String(row.type ?? ""),
        baseUrl: String(row.base_url ?? ""),
        status: String(row.status ?? "pending"),
      })),
    };
  }

  if (!isMissingColumnError(withArchive.error)) {
    return null;
  }

  const legacy = await supabase
    .from("api_connections")
    .select("id,name,type,base_url,status")
    .eq("tenant_id", tenantId);
  if (legacy.error) return null;
  const rows = (legacy.data ?? []) as Array<{
    id: string;
    name: string | null;
    type?: string | null;
    base_url?: string | null;
    status?: string | null;
  }>;
  return {
    count: rows.length,
    names: rows.map((row) => String(row.name ?? "Connection")),
    rows: rows.map((row) => ({
      id: String(row.id),
      name: String(row.name ?? "Connection"),
      type: String(row.type ?? ""),
      baseUrl: String(row.base_url ?? ""),
      status: String(row.status ?? "pending"),
    })),
  };
}

async function markSyncQueueFailure(
  supabase: Pick<SupabaseClient, "from">,
  tenantId: string,
  connectionId: string,
  message: string,
) {
  const finishedAt = new Date().toISOString();
  await supabase
    .from("connection_sync_runs")
    .update({
      status: "error",
      finished_at: finishedAt,
      error_message: message,
      details: {
        stage: "schema_discovery_failed",
        source: "create-data-connection",
        queue_error: message,
      },
    })
    .eq("tenant_id", tenantId)
    .eq("connection_id", connectionId)
    .eq("status", "running");

  await supabase
    .from("api_connections")
    .update({
      status: "error",
      health: "degraded",
      last_error: message,
      analysis_completed_at: finishedAt,
    })
    .eq("id", connectionId)
    .eq("tenant_id", tenantId);
}

function normalizeConfig(
  type: string,
  authType: string,
  baseUrl: string | null,
  rawConfig: Record<string, unknown>,
) {
  const config = { ...rawConfig };

  // Normalize known stringified payloads.
  if (typeof config.service_account_json === "string") {
    config.service_account_json = parseJsonString(config.service_account_json);
  }
  if (typeof config.custom_headers === "string") {
    config.custom_headers = parseJsonString(config.custom_headers);
  }

  if (!ALLOWED_AUTH_TYPES.has(authType)) {
    throw new Error(`Unsupported auth type: ${authType}`);
  }

  if (type === "rest_openapi" || type === "custom_rest") {
    if (!baseUrl || !validateUrl(baseUrl)) {
      throw new Error("REST connections require a valid Base URL");
    }

    const openApiUrl = asString(config.openapi_url ?? config.swagger_url ?? config.swaggerUrl);
    if (openApiUrl && !validateUrl(openApiUrl)) {
      throw new Error("OpenAPI Spec URL must be valid");
    }

    if (authType === "api_key" && !asString(config.api_key ?? config.apiKey)) {
      throw new Error("API Key is required for API Key auth");
    }
    if (authType === "bearer_token" && !asString(config.bearer_token ?? config.bearerToken)) {
      throw new Error("Bearer token is required for Bearer auth");
    }
    if (
      authType === "basic_auth" &&
      (!asString(config.basic_username ?? config.username) || !asString(config.basic_password ?? config.password))
    ) {
      throw new Error("Basic auth username and password are required");
    }
    if (
      authType === "oauth2" &&
      (!asString(config.oauth_client_id ?? config.client_id) || !asString(config.oauth_client_secret ?? config.client_secret))
    ) {
      throw new Error("OAuth2 client credentials are required");
    }
  }

  if (type === "postgresql" || type === "mysql") {
    const host = asString(config.host);
    const port = Number(config.port ?? 0);
    const database = asString(config.database);
    const username = asString(config.username);
    const password = asString(config.password);

    if (!host || !Number.isFinite(port) || port <= 0 || !database || !username || !password) {
      throw new Error(`${type} requires host, port, database, username, and password`);
    }
  }

  if (type === "mongodb") {
    const connectionString = asString(config.connection_string ?? config.connectionString ?? baseUrl);
    if (!connectionString) {
      throw new Error("MongoDB requires a connection string");
    }
    config.connection_string = connectionString;
  }

  if (type === "google_sheets") {
    const sheetUrl = asString(config.sheet_url ?? config.spreadsheet_url ?? baseUrl);
    if (!sheetUrl || !validateUrl(sheetUrl)) {
      throw new Error("Google Sheets requires a valid Spreadsheet URL");
    }
    config.sheet_url = sheetUrl;
  }

  if (type === "notion") {
    const integrationToken = asString(config.integration_token ?? config.integrationToken);
    const databaseId = asString(config.database_id ?? config.databaseId);
    if (!integrationToken || !databaseId) {
      throw new Error("Notion requires integration token and database ID");
    }
  }

  if (type === "firebase") {
    const projectId = asString(config.project_id ?? config.firebase_project_id ?? config.firebaseProjectId);
    if (!projectId) {
      throw new Error("Firebase requires project ID");
    }
  }

  return config;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let name = "";
  let type = "";
  let baseUrl: string | null = null;
  let authType = "none";
  let config: Record<string, unknown> = {};
  let requestedSeedSchema = false;
  let autoSync = true;

  try {
    const body = await req.json();
    name = String(body?.name ?? "").trim();
    type = normalizeConnectionType(String(body?.type ?? ""));
    baseUrl = body?.baseUrl ? String(body.baseUrl).trim() : null;
    authType = String(body?.authType ?? "none").trim().toLowerCase();
    config = body?.config && typeof body.config === "object" ? body.config : {};
    requestedSeedSchema = Boolean(body?.seedSchema);
    autoSync = body?.autoSync === undefined ? true : Boolean(body?.autoSync);
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!name || !type) {
    return errorResponse(400, "name and type are required");
  }
  if (!ALLOWED_AUTH_TYPES.has(authType)) {
    return errorResponse(400, "Unsupported authType");
  }

  try {
    config = normalizeConfig(type, authType, baseUrl, config);
  } catch (error) {
    return errorResponse(400, "Invalid connection configuration", error instanceof Error ? error.message : null);
  }

  const { data: entitlementRows, error: entitlementError } = await auth.supabase.rpc("tenant_entitlements_check", {
    p_capability: "connections",
    p_requested: 1,
  });

  if (entitlementError) {
    return errorResponse(400, "Could not verify plan limits", entitlementError.message);
  }

  const entitlement = entitlementRows?.[0];
  if (!entitlement?.allowed) {
    const hardLimit =
      typeof entitlement?.hard_limit === "number" && Number.isFinite(entitlement.hard_limit)
        ? entitlement.hard_limit
        : -1;
    const currentUsage =
      typeof entitlement?.current_usage === "number" && Number.isFinite(entitlement.current_usage)
        ? entitlement.current_usage
        : null;
    const reason =
      typeof entitlement?.reason === "string" && entitlement.reason.trim().length > 0
        ? entitlement.reason.trim()
        : "Upgrade plan to add more connections.";
    const detail =
      hardLimit >= 0 && currentUsage !== null
        ? `${reason} (${currentUsage}/${hardLimit} used)`
        : reason;

    // Self-heal stale entitlement usage by checking live connection rows.
    const tenantId = await resolveTenantIdByUserId(auth.supabase, auth.user.id);
    if (tenantId && hardLimit >= 0) {
      const liveUsage = await countLiveConnections(auth.supabase, tenantId);
      const normalizedName = name.trim().toLowerCase();
      const normalizedType = type.trim().toLowerCase();
      const normalizedBaseUrl = String(baseUrl ?? "").trim();
      const reusableConnection = liveUsage?.rows?.find((row) => {
        const sameType = String(row.type ?? "").trim().toLowerCase() === normalizedType;
        if (!sameType) return false;
        const rowName = String(row.name ?? "").trim().toLowerCase();
        const rowBaseUrl = String(row.baseUrl ?? "").trim();
        if (normalizedBaseUrl && rowBaseUrl && rowBaseUrl === normalizedBaseUrl) return true;
        return normalizedName.length > 0 && rowName === normalizedName;
      });

      if (reusableConnection) {
        return jsonResponse(200, {
          ok: true,
          connectionId: reusableConnection.id,
          status: reusableConnection.status,
          seeded: false,
          seedSchemaRequested: requestedSeedSchema,
          warning: "Connection already exists in this workspace. Reusing existing connection.",
          syncJobId: null,
          reusedExisting: true,
        });
      }

      if (liveUsage && liveUsage.count + 1 <= hardLimit) {
        // Allow creation when live usage proves entitlement usage is stale.
      } else {
        const namesPreview = liveUsage?.names?.slice(0, 3).join(", ");
        const namesSuffix =
          namesPreview && liveUsage && liveUsage.count > 0
            ? ` Existing: ${namesPreview}${liveUsage.count > 3 ? "..." : ""}.`
            : "";
        const liveDetail =
          liveUsage && Number.isFinite(liveUsage.count)
            ? `${reason} (${liveUsage.count}/${hardLimit} used).${namesSuffix}`
            : detail;
        return errorResponse(403, "Connection limit reached", liveDetail);
      }
    } else {
      return errorResponse(403, "Connection limit reached", detail);
    }
  }

  const { data, error } = await auth.supabase.rpc("create_api_connection", {
    p_name: name,
    p_type: type,
    p_base_url: baseUrl,
    p_auth_type: authType,
    p_connection_config: config,
    p_seed_schema: false,
  });

  if (error) return errorResponse(400, "Could not create connection", error.message);

  const created = data?.[0];
  if (!created?.connection_id) {
    return errorResponse(500, "Connection creation returned no id");
  }

  let syncJobId: string | null = null;
  let syncWarning: string | null = null;
  if (autoSync) {
    const { data: createdConnection, error: createdConnectionError } = await auth.supabase
      .from("api_connections")
      .select("id, tenant_id")
      .eq("id", created.connection_id)
      .maybeSingle();

    if (createdConnectionError || !createdConnection) {
      return errorResponse(
        400,
        "Connection created but could not load tenant scope",
        createdConnectionError?.message ?? "Connection row not found after create",
      );
    }

    const safePriority = clampPriority(72, 72);
    const rpcEnqueue = await auth.supabase.rpc("enqueue_connector_sync", {
      p_connection_id: created.connection_id,
      p_job_type: "schema_discovery",
      p_trigger_reason: "connection_created",
      p_priority: safePriority,
      p_idempotency_key: `${created.connection_id}:connection_created`,
      p_payload: { source: "create-data-connection" },
    });

    if (!rpcEnqueue.error && rpcEnqueue.data?.[0]?.job_id) {
      syncJobId = String(rpcEnqueue.data[0].job_id);
    } else {
      const rpcMessage = rpcEnqueue.error?.message ?? "RPC enqueue returned no job id";
      // Always attempt direct queue fallback when RPC enqueue fails.
      // This keeps connection creation resilient to transient/migration-order RPC issues.

      const queueRow = {
        tenant_id: createdConnection.tenant_id,
        connection_id: createdConnection.id,
        job_type: "schema_discovery",
        queue: "connector-sync",
        status: "queued",
        priority: safePriority,
        idempotency_key: `${created.connection_id}:connection_created`,
        trigger_reason: "connection_created",
        payload: { source: "create-data-connection" },
        triggered_by: auth.user.id,
      };

      let fallbackJobId: string | null = null;
      const fallbackInsert = await auth.supabase
        .from("connector_jobs")
        .insert(queueRow)
        .select("id")
        .single();

      if (!fallbackInsert.error && fallbackInsert.data?.id) {
        fallbackJobId = String(fallbackInsert.data.id);
      } else if (fallbackInsert.error?.code === "23505") {
        const existing = await auth.supabase
          .from("connector_jobs")
          .select("id")
          .eq("tenant_id", createdConnection.tenant_id)
          .eq("idempotency_key", String(queueRow.idempotency_key))
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!existing.error && existing.data?.id) {
          fallbackJobId = String(existing.data.id);
        } else {
          const message = `${rpcMessage}. Fallback queue lookup failed: ${existing.error?.message ?? "existing job not found"}`;
          await markSyncQueueFailure(auth.supabase, createdConnection.tenant_id, createdConnection.id, message);
          return jsonResponse(200, {
            ok: true,
            connectionId: created.connection_id,
            status: "error",
            seeded: false,
            seedSchemaRequested: requestedSeedSchema,
            warning: `Connection created, but schema discovery could not be queued. ${message}`,
            syncJobId: null,
            queueFailed: true,
          });
        }
      } else {
        const message = `${rpcMessage}. Fallback queue insert failed: ${fallbackInsert.error?.message ?? "unknown error"}`;
        await markSyncQueueFailure(auth.supabase, createdConnection.tenant_id, createdConnection.id, message);
        return jsonResponse(200, {
          ok: true,
          connectionId: created.connection_id,
          status: "error",
          seeded: false,
          seedSchemaRequested: requestedSeedSchema,
          warning: `Connection created, but schema discovery could not be queued. ${message}`,
          syncJobId: null,
          queueFailed: true,
        });
      }

      syncJobId = fallbackJobId;
      syncWarning = `enqueue_connector_sync RPC failed (${rpcMessage}). Used direct queue fallback.`;
    }
  }

  return jsonResponse(200, {
    ok: true,
    connectionId: created.connection_id,
    status: created.status,
    seeded: false,
    seedSchemaRequested: requestedSeedSchema,
    warning: requestedSeedSchema
      ? "Seeded schema bootstrap is disabled. Real discovery job was queued instead."
      : syncWarning,
    syncJobId,
  });
});
