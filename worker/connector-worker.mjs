import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";

function loadDotEnvIfPresent() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    if (typeof process.env[key] === "string" && process.env[key].length > 0) continue;

    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnvIfPresent();

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function projectRefFromUrl(url) {
  try {
    const host = new URL(url).hostname;
    const [projectRef] = host.split(".");
    return String(projectRef || "").trim();
  } catch {
    return "";
  }
}

function keyMatchesProject(key, url) {
  if (!key || !url) return false;
  // Supabase publishable/secret keys are opaque and cannot be decoded client-side.
  if (String(key).startsWith("sb_publishable_") || String(key).startsWith("sb_secret_")) {
    return true;
  }
  const payload = decodeJwtPayload(key);
  if (!payload || typeof payload !== "object") return false;

  const expectedRef = projectRefFromUrl(url);
  const keyRef = typeof payload.ref === "string" ? payload.ref.trim() : "";
  if (expectedRef && keyRef) {
    return keyRef === expectedRef;
  }

  const issuer = typeof payload.iss === "string" ? payload.iss : "";
  return Boolean(issuer) && issuer.startsWith(`${url}/auth/v1`);
}

function resolveSupabaseRuntimePair() {
  const urlCandidates = [process.env.SUPABASE_URL, process.env.VITE_SUPABASE_URL]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const keyCandidates = [process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.VITE_SUPABASE_SERVICE_ROLE_KEY]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const url of urlCandidates) {
    const matchingKey = keyCandidates.find((key) => keyMatchesProject(key, url));
    if (matchingKey) {
      return { supabaseUrl: url, serviceRoleKey: matchingKey, matchedByIssuer: true };
    }
  }

  return {
    supabaseUrl: urlCandidates[0] || "",
    serviceRoleKey: keyCandidates[0] || "",
    matchedByIssuer: false,
  };
}

const runtimePair = resolveSupabaseRuntimePair();
const supabaseUrl = runtimePair.supabaseUrl;
const serviceRoleKey = runtimePair.serviceRoleKey;
const workerToken = process.env.CONNECTOR_WORKER_TOKEN || process.env.VITE_CONNECTOR_WORKER_TOKEN;
const openaiApiKey = process.env.OPENAI_API_KEY;
const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const workerId = process.env.CONNECTOR_WORKER_ID || "node-connector-worker";
const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS || 8000);
const staleRecoveryMinutes = Number(process.env.WORKER_STALE_RECOVERY_MINUTES || 20);
const runModel = process.env.OPENAI_MODEL || "gpt-4o-mini";
const webhookSigningSecret = process.env.WEBHOOK_SIGNING_SECRET || "";
const credentialRefreshIntervalMs = Number(process.env.CREDENTIAL_REFRESH_INTERVAL_MS || 10 * 60 * 1000);
const syncDispatchIntervalMs = Number(process.env.CONNECTOR_SYNC_DISPATCH_INTERVAL_MS || 60 * 1000);
const connectorDiscoveryTimeoutMs = Number(process.env.CONNECTOR_DISCOVERY_TIMEOUT_MS || 120_000);
const connectorCallbackTimeoutMs = Number(process.env.CONNECTOR_CALLBACK_TIMEOUT_MS || 15_000);
const connectorCallbackMaxAttempts = Math.max(1, Number(process.env.CONNECTOR_CALLBACK_MAX_ATTEMPTS || 6));
const connectorProgressCallbackMaxAttempts = Math.max(
  1,
  Number(process.env.CONNECTOR_PROGRESS_CALLBACK_MAX_ATTEMPTS || 2),
);
const connectorCallbackBaseDelayMs = Math.max(100, Number(process.env.CONNECTOR_CALLBACK_BASE_DELAY_MS || 500));
const workerHeartbeatIntervalMs = Math.max(10_000, Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS || 60_000));
const workerFailFastOnConnectivity = String(process.env.WORKER_FAIL_FAST_CONNECTIVITY_CHECK || "true")
  .trim()
  .toLowerCase() !== "false";
const workerAllowUnverifiedRuntimePair = String(process.env.WORKER_ALLOW_UNVERIFIED_RUNTIME_PAIR || "false")
  .trim()
  .toLowerCase() === "true";
let lastCredentialRefreshAt = 0;
let lastSyncDispatchAt = 0;
let lastHeartbeatAt = 0;

if (!supabaseUrl || !serviceRoleKey || !workerToken) {
  console.error(
    "Missing required env vars: SUPABASE_URL/VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/VITE_SUPABASE_SERVICE_ROLE_KEY, CONNECTOR_WORKER_TOKEN/VITE_CONNECTOR_WORKER_TOKEN",
  );
  process.exit(1);
}

if (
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  process.env.VITE_SUPABASE_SERVICE_ROLE_KEY &&
  process.env.SUPABASE_SERVICE_ROLE_KEY !== process.env.VITE_SUPABASE_SERVICE_ROLE_KEY
) {
  console.warn(
    "Service role key mismatch detected between SUPABASE_SERVICE_ROLE_KEY and VITE_SUPABASE_SERVICE_ROLE_KEY; using SUPABASE_SERVICE_ROLE_KEY.",
  );
}
if (!runtimePair.matchedByIssuer) {
  const message =
    "Could not confirm Supabase URL/service key pairing from token metadata. Worker will still run connectivity probe before processing jobs.";
  if (!workerAllowUnverifiedRuntimePair) {
    console.warn(`${message}`);
  } else {
    console.warn(`${message} WORKER_ALLOW_UNVERIFIED_RUNTIME_PAIR=true set; continuing at your own risk.`);
  }
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseSupabaseHost(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function nodeMajorVersion() {
  const major = Number(String(process.versions?.node || "").split(".")[0] || 0);
  return Number.isFinite(major) ? major : 0;
}

async function validateWorkerConnectivity() {
  const host = parseSupabaseHost(supabaseUrl);
  if (!host) {
    throw new Error("SUPABASE_URL is invalid; expected an absolute URL.");
  }

  await withTimeout(dns.lookup(host), 7_000, "supabase_dns_lookup");

  const response = await withTimeout(
    fetch(`${supabaseUrl}/rest/v1/`, {
      method: "GET",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    }),
    9_000,
    "supabase_rest_probe",
  );

  if (!response.ok) {
    throw new Error(`Supabase REST probe failed with ${response.status}`);
  }
}

function sanitizeName(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function retryDelaySeconds(attemptCount) {
  const exponential = 30 * Math.pow(2, Math.max(0, attemptCount - 1));
  return Math.min(900, Math.round(exponential));
}

function callbackRetryDelayMs(attemptCount) {
  const exponential = connectorCallbackBaseDelayMs * Math.pow(2, Math.max(0, attemptCount - 1));
  return Math.min(15_000, Math.round(exponential));
}

function isRetryableCallbackStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function isTransientCallbackError(error) {
  if (!error) return false;
  const name = typeof error.name === "string" ? error.name.toLowerCase() : "";
  const message = typeof error.message === "string" ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    name === "aborterror" ||
    message.includes("fetch failed") ||
    message.includes("enotfound") ||
    message.includes("eai_again") ||
    message.includes("connect timeout") ||
    message.includes("und_err_connect_timeout") ||
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("socket hang up")
  );
}

function truncateErrorText(value, max = 500) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function normalizeSensitivity(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "pii" || normalized === "financial") return normalized;
  return "normal";
}

function normalizeRiskLevel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "medium" || normalized === "high" || normalized === "critical") return normalized;
  return "low";
}

function normalizeEntityGroup(value, fallback = "master_data") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "logs" || normalized === "config" || normalized === "transactions") return normalized;
  return fallback;
}

function normalizeSourceKind(value, fallback = "table") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized) return normalized;
  return fallback;
}

function normalizeSchemaPayload(rawSchema, options = {}) {
  const connectionType = String(options.connectionType || "").trim().toLowerCase();
  const fallbackSourceKind =
    connectionType === "mongodb"
      ? "collection"
      : connectionType === "google_sheets"
        ? "sheet"
        : connectionType === "rest_openapi" || connectionType === "custom_rest"
          ? "endpoint"
          : "table";

  const rawEntities = Array.isArray(rawSchema?.entities) ? rawSchema.entities : [];
  const entities = [];
  const seenEntityNames = new Set();

  for (const rawEntity of rawEntities) {
    const originalName = sanitizeName(String(rawEntity?.name || "").trim());
    if (!originalName) continue;

    let entityName = originalName;
    let suffix = 1;
    while (seenEntityNames.has(entityName)) {
      suffix += 1;
      entityName = `${originalName}_${suffix}`;
    }
    seenEntityNames.add(entityName);

    const rawColumns = Array.isArray(rawEntity?.columns) ? rawEntity.columns : [];
    const columns = [];
    const seenColumns = new Set();
    for (const rawColumn of rawColumns) {
      const baseCol = sanitizeName(String(rawColumn?.name || "").trim());
      if (!baseCol) continue;
      let colName = baseCol;
      let colSuffix = 1;
      while (seenColumns.has(colName)) {
        colSuffix += 1;
        colName = `${baseCol}_${colSuffix}`;
      }
      seenColumns.add(colName);
      columns.push({
        name: colName,
        dataType: String(rawColumn?.dataType || "text").trim().toLowerCase() || "text",
        nullable: rawColumn?.nullable !== false,
        sensitivity: normalizeSensitivity(rawColumn?.sensitivity),
        sampleValue: rawColumn?.sampleValue == null ? null : String(rawColumn.sampleValue).slice(0, 1000),
      });
    }

    if (columns.length === 0) {
      columns.push({
        name: "id",
        dataType: "text",
        nullable: false,
        sensitivity: "normal",
        sampleValue: null,
      });
    }

    entities.push({
      name: entityName,
      sourceKind: normalizeSourceKind(rawEntity?.sourceKind, fallbackSourceKind),
      entityGroup: normalizeEntityGroup(rawEntity?.entityGroup, classifyEntityGroup(entityName)),
      rowCount: Math.max(0, Math.round(Number(rawEntity?.rowCount || 0))),
      riskLevel: normalizeRiskLevel(rawEntity?.riskLevel),
      sensitivity: normalizeSensitivity(rawEntity?.sensitivity),
      description: String(rawEntity?.description || `Discovered entity ${entityName}`).slice(0, 1200),
      embeddingCoverage: Math.max(0, Math.min(100, Number(rawEntity?.embeddingCoverage || 0))),
      columns,
    });
  }

  const validEntityNames = new Set(entities.map((entity) => entity.name));
  const rawRelationships = Array.isArray(rawSchema?.relationships) ? rawSchema.relationships : [];
  const relationshipSeen = new Set();
  const relationships = [];
  for (const rel of rawRelationships) {
    const sourceName = sanitizeName(String(rel?.sourceName || "").trim());
    const targetName = sanitizeName(String(rel?.targetName || "").trim());
    if (!sourceName || !targetName) continue;
    if (!validEntityNames.has(sourceName) || !validEntityNames.has(targetName)) continue;
    const relationType = String(rel?.relationType || "related_to").trim().toLowerCase() || "related_to";
    const dedupeKey = `${sourceName}|${targetName}|${relationType}`;
    if (relationshipSeen.has(dedupeKey)) continue;
    relationshipSeen.add(dedupeKey);
    relationships.push({
      sourceName,
      targetName,
      relationType,
      label: String(rel?.label || `${sourceName} -> ${targetName}`).slice(0, 240),
    });
  }

  return {
    entities,
    relationships,
    schemaTablesCount: Math.max(0, Math.round(Number(rawSchema?.schemaTablesCount || entities.length))),
    schemaEntitiesCount: Math.max(0, Math.round(Number(rawSchema?.schemaEntitiesCount || entities.length))),
  };
}

function classifyConnectorFailure(error) {
  const fallback = {
    category: "unknown_error",
    retryable: true,
    remediation: "Inspect connector configuration and retry schema discovery.",
  };
  const message = String(error instanceof Error ? error.message : error || "").trim();
  const lower = message.toLowerCase();
  if (!lower) return { ...fallback, message: "Unknown connector failure" };

  if (lower.includes("enotfound") || lower.includes("eai_again") || lower.includes("dns")) {
    return {
      category: "network_dns",
      retryable: true,
      remediation: "Verify DNS/network egress from worker host to Supabase and source system.",
      message,
    };
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("und_err_connect_timeout")) {
    return {
      category: "network_timeout",
      retryable: true,
      remediation: "Increase connector timeout and validate source API/database responsiveness.",
      message,
    };
  }
  if (lower.includes("401") || lower.includes("403") || lower.includes("forbidden") || lower.includes("unauthorized")) {
    return {
      category: "auth_failure",
      retryable: false,
      remediation: "Rotate credentials or update connector auth settings.",
      message,
    };
  }
  if (lower.includes("no ") && lower.includes("discovered")) {
    return {
      category: "empty_schema",
      retryable: false,
      remediation: "Check source permissions/visibility; no readable entities were discovered.",
      message,
    };
  }
  if (lower.includes("not implemented")) {
    return {
      category: "connector_not_supported",
      retryable: false,
      remediation: "Connector type is not fully supported by discovery worker.",
      message,
    };
  }

  return {
    ...fallback,
    message,
  };
}

function isMissingRpc(error) {
  if (!error || typeof error !== "object") return false;
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  return code === "PGRST202" || message.includes("could not find the function");
}

function isLegacyTenantAmbiguity(error) {
  if (!error || typeof error !== "object") return false;
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  return code === "42702" && message.includes("tenant_id") && message.includes("ambiguous");
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function recoverStaleJobs() {
  const [connectorRecovery, embeddingRecovery] = await Promise.all([
    supabase.rpc("recover_stale_connector_jobs", {
      p_stale_minutes: staleRecoveryMinutes,
      p_batch: 50,
    }),
    supabase.rpc("recover_stale_embedding_jobs", {
      p_stale_minutes: staleRecoveryMinutes,
      p_batch: 100,
    }),
  ]);

  if (connectorRecovery.error && !isMissingRpc(connectorRecovery.error)) {
    throw connectorRecovery.error;
  }
  if (embeddingRecovery.error && !isMissingRpc(embeddingRecovery.error)) {
    throw embeddingRecovery.error;
  }

  const connectorRow = connectorRecovery.data?.[0];
  const embeddingRow = embeddingRecovery.data?.[0];

  const connectorRequeued = Number(connectorRow?.requeued_count || 0);
  const connectorDead = Number(connectorRow?.dead_letter_count || 0);
  const embeddingRequeued = Number(embeddingRow?.requeued_count || 0);
  const embeddingDead = Number(embeddingRow?.dead_letter_count || 0);

  if (connectorRequeued || connectorDead || embeddingRequeued || embeddingDead) {
    console.log(
      "Recovered stale jobs",
      JSON.stringify({
        connector: { requeued: connectorRequeued, dead_letter: connectorDead },
        embedding: { requeued: embeddingRequeued, dead_letter: embeddingDead },
      }),
    );
  }
}

async function callbackConnectorJob(payload, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts ?? connectorCallbackMaxAttempts));
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs ?? connectorCallbackTimeoutMs));
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${supabaseUrl}/functions/v1/connector-sync-worker-callback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-worker-token": workerToken,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.ok) return;

      const text = await response.text();
      const message = `Callback failed (${response.status}): ${truncateErrorText(text, 600)}`;
      lastError = new Error(message);

      if (attempt < maxAttempts && isRetryableCallbackStatus(response.status)) {
        const retryDelay = callbackRetryDelayMs(attempt);
        console.warn("connector callback retry", {
          status: response.status,
          attempt,
          maxAttempts,
          retryDelayMs: retryDelay,
        });
        await sleep(retryDelay);
        continue;
      }

      throw lastError;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && isTransientCallbackError(error)) {
        const retryDelay = callbackRetryDelayMs(attempt);
        console.warn("connector callback retry", {
          attempt,
          maxAttempts,
          retryDelayMs: retryDelay,
          reason: truncateErrorText(error instanceof Error ? error.message : String(error), 240),
        });
        await sleep(retryDelay);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error("Connector callback failed");
}

async function maybeEnqueueDueConnectorSyncs() {
  const now = Date.now();
  if (now - lastSyncDispatchAt < syncDispatchIntervalMs) return;
  lastSyncDispatchAt = now;

  const { data, error } = await supabase.rpc("enqueue_due_connector_sync_jobs", {
    p_limit: 40,
    p_trigger_reason: "worker_scheduler",
  });

  if (error) {
    if (isMissingRpc(error)) return;
    if (error.code === "42702" && String(error.message || "").toLowerCase().includes("tenant_id")) {
      console.error(
        "enqueue_due_connector_sync_jobs failed with legacy ambiguous tenant_id definition. Apply latest migrations (fix_enqueue_due_connector_sync_jobs_ambiguity).",
        error,
      );
      return;
    }
    throw error;
  }

  const rows = Array.isArray(data) ? data : [];
  if (rows.length > 0) {
    console.log(
      "auto-enqueued connector sync jobs",
      JSON.stringify({
        count: rows.length,
        connections: rows.slice(0, 10).map((row) => row.connection_id),
      }),
    );
  }
}

async function callbackWebhookDelivery(payload) {
  const response = await fetch(`${supabaseUrl}/functions/v1/webhook-delivery-worker-callback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-worker-token": workerToken,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Webhook callback failed (${response.status}): ${text}`);
  }
}

function parseCustomHeaders(value) {
  if (!value) return {};
  if (Array.isArray(value)) {
    return value.reduce((acc, row) => {
      if (!row || typeof row !== "object") return acc;
      const key = String(row.key || "").trim();
      const val = String(row.value || "").trim();
      if (key && val) acc[key] = val;
      return acc;
    }, {});
  }
  if (typeof value === "object") {
    return Object.entries(value).reduce((acc, [key, val]) => {
      const headerName = String(key || "").trim();
      const headerValue = typeof val === "string" ? val.trim() : "";
      if (headerName && headerValue) acc[headerName] = headerValue;
      return acc;
    }, {});
  }
  return {};
}

function connectorAuthHeaders(connection) {
  const config = connection.connection_config || {};
  const authType = String(connection.auth_type || config.auth_type || "none").toLowerCase();
  const headers = {
    Accept: "application/json,application/yaml,text/yaml,*/*",
    ...parseCustomHeaders(config.custom_headers || config.customHeaders),
  };

  if (authType === "api_key") {
    const headerName = String(config.api_key_header || config.apiKeyHeader || "x-api-key").trim();
    const keyValue = String(config.api_key || config.apiKey || "").trim();
    if (headerName && keyValue) headers[headerName] = keyValue;
  } else if (authType === "bearer_token") {
    const token = String(config.bearer_token || config.bearerToken || "").trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  } else if (authType === "basic_auth") {
    const username = String(config.basic_username || config.username || "").trim();
    const password = String(config.basic_password || config.password || "").trim();
    if (username || password) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    }
  }

  return headers;
}

function classifyEntityGroup(name) {
  const value = String(name || "").toLowerCase();
  if (/(log|audit|event|trace|history)/.test(value)) return "logs";
  if (/(config|setting|preference|policy|rule)/.test(value)) return "config";
  if (/(order|invoice|payment|transaction|purchase|ledger|shipment|booking)/.test(value)) return "transactions";
  return "master_data";
}

function detectSensitivityByName(name) {
  const value = String(name || "").toLowerCase();
  if (/(email|phone|mobile|ssn|tax|dob|birth|address|name|contact)/.test(value)) return "pii";
  if (/(amount|price|cost|revenue|invoice|payment|balance|ledger|salary)/.test(value)) return "financial";
  return "normal";
}

function riskLevelFromSensitivity(sensitivity) {
  if (sensitivity === "financial") return "high";
  if (sensitivity === "pii") return "medium";
  return "low";
}

function inferDataTypeFromValue(value) {
  if (value === null || value === undefined) return "text";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "numeric";
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Date) return "timestamp";
  if (typeof value === "object") return "jsonb";
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "date";
    if (!Number.isNaN(Number(value)) && value.trim() !== "") return "numeric";
  }
  return "text";
}

function sampleValueForColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value).slice(0, 240);
    } catch {
      return "[object]";
    }
  }
  return String(value).slice(0, 240);
}

function normalizeConnectionType(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "rest" || value === "rest_api" || value === "rest_openapi") return "rest_openapi";
  if (value === "custom_rest_api") return "custom_rest";
  if (value === "sheets" || value === "googlesheets" || value === "google sheets") return "google_sheets";
  if (value === "firebase_realtime") return "firebase";
  return value;
}

function buildEntityFromName(name, sourceKind = "table", columns = []) {
  const normalizedName = sanitizeName(name);
  const sensitivity = detectSensitivityByName(normalizedName);
  const normalizedColumns = Array.isArray(columns) ? columns.filter((column) => column?.name) : [];
  return {
    name: normalizedName,
    sourceKind,
    entityGroup: classifyEntityGroup(normalizedName),
    rowCount: 0,
    riskLevel: riskLevelFromSensitivity(sensitivity),
    sensitivity,
    description: `Discovered entity: ${name}`,
    embeddingCoverage: 0,
    columns: normalizedColumns,
  };
}

function parseConnectionConfig(connection) {
  return connection?.connection_config && typeof connection.connection_config === "object"
    ? connection.connection_config
    : {};
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on", "require", "required"].includes(normalized)) return true;
    if (["false", "0", "no", "off", "disable", "disabled"].includes(normalized)) return false;
  }
  return fallback;
}

function parsePostgresSslConfig(config) {
  const sslMode = String(config.ssl_mode || config.sslMode || "").trim().toLowerCase();
  if (sslMode === "disable") return false;
  if (sslMode === "verify-full") return { rejectUnauthorized: true };
  if (sslMode === "require" || sslMode === "prefer") return { rejectUnauthorized: false };
  return parseBoolean(config.ssl, false) ? { rejectUnauthorized: false } : false;
}

function parseMySqlSslConfig(config) {
  const sslMode = String(config.ssl_mode || config.sslMode || "").trim().toLowerCase();
  if (sslMode === "disable") return undefined;
  if (sslMode === "verify-full") return { rejectUnauthorized: true };
  if (sslMode === "require" || sslMode === "preferred") return { rejectUnauthorized: false };
  return parseBoolean(config.ssl, false) ? { rejectUnauthorized: false } : undefined;
}

function parseJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function columnsFromRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  return Object.entries(record).map(([key, value], index) => {
    const sensitivity = detectSensitivityByName(key);
    return {
      name: sanitizeName(key) || `field_${index + 1}`,
      dataType: inferDataTypeFromValue(value),
      nullable: value === null || value === undefined,
      sensitivity,
      sampleValue: sampleValueForColumn(value),
    };
  });
}

function flattenRecord(value, prefix = "", depth = 0, maxDepth = 2, output = {}) {
  if (value === null || value === undefined) {
    if (prefix) output[prefix] = null;
    return output;
  }

  if (depth >= maxDepth || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) output[prefix] = value;
    return output;
  }

  const entries = Object.entries(value).slice(0, 60);
  for (const [rawKey, rawValue] of entries) {
    const key = sanitizeName(rawKey) || "field";
    const nextPrefix = prefix ? `${prefix}_${key}` : key;
    flattenRecord(rawValue, nextPrefix, depth + 1, maxDepth, output);
  }

  return output;
}

function inferColumnsFromSamples(samples) {
  const byName = new Map();
  const safeSamples = Array.isArray(samples) ? samples.slice(0, 25) : [];

  for (const sample of safeSamples) {
    if (!sample || typeof sample !== "object" || Array.isArray(sample)) continue;
    const flattened = flattenRecord(sample, "", 0, 2, {});
    for (const [columnNameRaw, columnValue] of Object.entries(flattened)) {
      const columnName = sanitizeName(columnNameRaw);
      if (!columnName) continue;
      const existing = byName.get(columnName);
      const inferredType = inferDataTypeFromValue(columnValue);
      const sampleValue = sampleValueForColumn(columnValue);
      const sensitivity = detectSensitivityByName(columnName);
      if (!existing) {
        byName.set(columnName, {
          name: columnName,
          dataType: inferredType,
          nullable: columnValue === null || columnValue === undefined,
          sensitivity,
          sampleValue,
        });
        continue;
      }

      if ((existing.dataType === "text" || existing.dataType === "jsonb") && inferredType !== "text" && inferredType !== "jsonb") {
        existing.dataType = inferredType;
      }
      if (!existing.sampleValue && sampleValue) {
        existing.sampleValue = sampleValue;
      }
      existing.nullable = existing.nullable || columnValue === null || columnValue === undefined;
    }
  }

  return dedupeColumns(Array.from(byName.values())).slice(0, 200);
}

function singularizeToken(token) {
  const value = sanitizeName(token);
  if (!value) return "";
  if (value.endsWith("ies") && value.length > 3) return `${value.slice(0, -3)}y`;
  if (value.endsWith("ses") && value.length > 4) return value.slice(0, -2);
  if (value.endsWith("s") && value.length > 3) return value.slice(0, -1);
  return value;
}

function buildEntityAliasSet(entityName) {
  const clean = sanitizeName(entityName);
  const aliases = new Set();
  if (!clean) return aliases;
  aliases.add(clean);
  aliases.add(singularizeToken(clean));

  const parts = clean.split("_").filter(Boolean);
  if (parts.length > 0) {
    const tail = parts[parts.length - 1];
    aliases.add(tail);
    aliases.add(singularizeToken(tail));
  }

  return aliases;
}

function inferRelationshipsFromEntities(entities, relationType = "inferred_foreign_key") {
  const safeEntities = Array.isArray(entities) ? entities : [];
  if (safeEntities.length <= 1) return [];

  const aliasIndex = new Map();
  for (const entity of safeEntities) {
    const entityName = sanitizeName(entity?.name);
    if (!entityName) continue;
    const aliases = buildEntityAliasSet(entityName);
    for (const alias of aliases) {
      if (!alias) continue;
      const owners = aliasIndex.get(alias) ?? new Set();
      owners.add(entityName);
      aliasIndex.set(alias, owners);
    }
  }

  const relationshipByKey = new Map();
  for (const entity of safeEntities) {
    const sourceName = sanitizeName(entity?.name);
    if (!sourceName || !Array.isArray(entity?.columns)) continue;

    for (const column of entity.columns) {
      const columnName = sanitizeName(column?.name);
      if (!columnName || !columnName.endsWith("_id")) continue;
      const base = singularizeToken(columnName.slice(0, -3));
      if (!base) continue;

      const candidates = new Set([
        base,
        singularizeToken(base),
        `${base}s`,
      ]);

      for (const candidate of candidates) {
        const targets = aliasIndex.get(candidate);
        if (!targets) continue;
        for (const targetName of targets) {
          if (!targetName || targetName === sourceName) continue;
          const key = `${sourceName}->${targetName}:${columnName}`;
          if (relationshipByKey.has(key)) continue;
          relationshipByKey.set(key, {
            sourceName,
            targetName,
            relationType,
            label: `${sourceName}.${columnName} -> ${targetName}.id`,
          });
        }
      }
    }
  }

  return Array.from(relationshipByKey.values());
}

function parseSpreadsheetId(spreadsheetUrl) {
  const pattern = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;
  const match = String(spreadsheetUrl || "").match(pattern);
  return match?.[1] ?? "";
}

function openApiDecodePointerPart(value) {
  return String(value || "").replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveOpenApiRef(doc, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  const pointerParts = ref
    .slice(2)
    .split("/")
    .map(openApiDecodePointerPart)
    .filter((part) => part.length > 0);

  let current = doc;
  for (const part of pointerParts) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(part in current)) return null;
    current = current[part];
  }
  return current && typeof current === "object" ? current : null;
}

function dereferenceOpenApiObject(doc, value, seenRefs = new Set()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.$ref !== "string") return value;
  if (seenRefs.has(value.$ref)) return null;
  seenRefs.add(value.$ref);
  const resolved = resolveOpenApiRef(doc, value.$ref);
  if (!resolved) return null;
  return dereferenceOpenApiObject(doc, resolved, seenRefs) ?? resolved;
}

function mapOpenApiTypeToColumnType(schemaType, format) {
  const normalizedType = String(schemaType || "").toLowerCase();
  const normalizedFormat = String(format || "").toLowerCase();
  if (normalizedFormat === "date" || normalizedFormat === "date-time") return "timestamp";
  if (normalizedFormat === "uuid") return "uuid";
  if (normalizedFormat === "email") return "text";
  if (normalizedType === "integer") return "integer";
  if (normalizedType === "number") return "numeric";
  if (normalizedType === "boolean") return "boolean";
  if (normalizedType === "array" || normalizedType === "object") return "jsonb";
  return "text";
}

function collectColumnsFromOpenApiSchema(args) {
  const { doc, schema, prefix = "", required = false, depth = 0, seenRefs = new Set() } = args;
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 4) return [];

  const resolvedSchema = dereferenceOpenApiObject(doc, schema, seenRefs) ?? schema;
  const schemaType = String(resolvedSchema.type || "").toLowerCase();

  if (schemaType === "object" || (resolvedSchema.properties && typeof resolvedSchema.properties === "object")) {
    const properties = resolvedSchema.properties && typeof resolvedSchema.properties === "object" ? resolvedSchema.properties : {};
    const requiredSet = new Set(Array.isArray(resolvedSchema.required) ? resolvedSchema.required.map((value) => String(value)) : []);
    const columns = [];
    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      const safeName = sanitizeName(propertyName) || "field";
      const nextPrefix = prefix ? `${prefix}_${safeName}` : safeName;
      const nestedColumns = collectColumnsFromOpenApiSchema({
        doc,
        schema: propertySchema,
        prefix: nextPrefix,
        required: requiredSet.has(propertyName),
        depth: depth + 1,
        seenRefs: new Set(seenRefs),
      });
      if (nestedColumns.length > 0) columns.push(...nestedColumns);
    }
    if (columns.length > 0) return columns;
  }

  if (schemaType === "array" || resolvedSchema.items) {
    return collectColumnsFromOpenApiSchema({
      doc,
      schema: resolvedSchema.items,
      prefix: prefix ? `${prefix}_item` : "item",
      required,
      depth: depth + 1,
      seenRefs: new Set(seenRefs),
    });
  }

  const columnName = sanitizeName(prefix || resolvedSchema.title || "value");
  if (!columnName) return [];
  const sensitivity = detectSensitivityByName(columnName);
  return [
    {
      name: columnName,
      dataType: mapOpenApiTypeToColumnType(resolvedSchema.type, resolvedSchema.format),
      nullable: !required,
      sensitivity,
      sampleValue: null,
    },
  ];
}

function dedupeColumns(columns) {
  const byName = new Map();
  for (const column of columns) {
    const name = sanitizeName(column?.name);
    if (!name) continue;
    if (!byName.has(name)) {
      byName.set(name, {
        name,
        dataType: column?.dataType || "text",
        nullable: Boolean(column?.nullable ?? true),
        sensitivity: column?.sensitivity || detectSensitivityByName(name),
        sampleValue: column?.sampleValue ?? null,
      });
    }
  }
  return Array.from(byName.values()).slice(0, 200);
}

function resolveOperationSchema(doc, operation) {
  if (!operation || typeof operation !== "object") return null;
  const responses = operation.responses && typeof operation.responses === "object" ? operation.responses : {};
  const preferredResponseCodes = ["200", "201", "202", "default"];
  const dynamicSuccessCodes = Object.keys(responses).filter((code) => /^2\d\d$/.test(code));
  const orderedCodes = [...preferredResponseCodes, ...dynamicSuccessCodes];

  for (const code of orderedCodes) {
    const response = dereferenceOpenApiObject(doc, responses[code], new Set());
    if (!response || typeof response !== "object") continue;
    const content = response.content && typeof response.content === "object" ? response.content : {};
    const media = content["application/json"] || content["application/*+json"] || Object.values(content)[0];
    if (media && typeof media === "object" && media.schema && typeof media.schema === "object") return media.schema;
  }

  const requestBody = dereferenceOpenApiObject(doc, operation.requestBody, new Set());
  if (requestBody && typeof requestBody === "object") {
    const content = requestBody.content && typeof requestBody.content === "object" ? requestBody.content : {};
    const media = content["application/json"] || content["application/*+json"] || Object.values(content)[0];
    if (media && typeof media === "object" && media.schema && typeof media.schema === "object") return media.schema;
  }

  return null;
}

function extractOperationParameterColumns(doc, pathParameters, operationParameters) {
  const mergedParameters = [
    ...(Array.isArray(pathParameters) ? pathParameters : []),
    ...(Array.isArray(operationParameters) ? operationParameters : []),
  ];

  const columns = [];
  for (const parameter of mergedParameters) {
    const resolved = dereferenceOpenApiObject(doc, parameter, new Set());
    if (!resolved || typeof resolved !== "object") continue;
    const baseName = sanitizeName(resolved.name || "");
    if (!baseName) continue;
    const source = sanitizeName(resolved.in || "param");
    const columnName = source ? `${baseName}_${source}` : baseName;
    const schema = resolved.schema && typeof resolved.schema === "object" ? resolved.schema : {};
    const sensitivity = detectSensitivityByName(columnName);
    columns.push({
      name: columnName,
      dataType: mapOpenApiTypeToColumnType(schema.type, schema.format),
      nullable: !Boolean(resolved.required),
      sensitivity,
      sampleValue: null,
    });
  }
  return columns;
}

async function discoverFromRestSample(connection) {
  const config = parseConnectionConfig(connection);
  const baseUrl = String(connection.base_url || config.base_url || config.baseUrl || "").trim();
  if (!baseUrl) {
    throw new Error("REST discovery requires Base URL or OpenAPI URL");
  }

  const response = await fetch(baseUrl, {
    method: "GET",
    headers: connectorAuthHeaders(connection),
  });
  if (!response.ok) {
    throw new Error(`REST sample fetch failed (${response.status})`);
  }

  const bodyText = await response.text();
  const payload = parseJsonFromText(bodyText);
  if (!payload || typeof payload !== "object") {
    throw new Error("REST sample response is not valid JSON");
  }

  let candidate = payload;
  if (Array.isArray(candidate)) {
    candidate = candidate[0] ?? {};
  } else if (
    candidate &&
    typeof candidate === "object" &&
    Array.isArray(candidate.items) &&
    candidate.items.length > 0 &&
    typeof candidate.items[0] === "object"
  ) {
    candidate = candidate.items[0];
  } else if (
    candidate &&
    typeof candidate === "object" &&
    candidate.data &&
    typeof candidate.data === "object" &&
    !Array.isArray(candidate.data)
  ) {
    candidate = candidate.data;
  }

  const columns = columnsFromRecord(candidate);
  if (columns.length === 0) {
    throw new Error("REST sample did not expose introspectable fields");
  }

  const entity = buildEntityFromName(`${connection.name || "rest"}_resource`, "endpoint", columns);
  return {
    entities: [entity],
    relationships: [],
    schemaTablesCount: 1,
    schemaEntitiesCount: 1,
  };
}

async function discoverFromOpenApi(connection) {
  const config = parseConnectionConfig(connection);
  const openApiUrl = config.openapi_url || config.swagger_url || config.swaggerUrl;
  if (!openApiUrl) return discoverFromRestSample(connection);

  const response = await fetch(openApiUrl, {
    method: "GET",
    headers: connectorAuthHeaders(connection),
  });
  if (!response.ok) throw new Error(`OpenAPI fetch failed (${response.status})`);

  const bodyText = await response.text();
  let doc;
  try {
    doc = JSON.parse(bodyText);
  } catch {
    throw new Error("OpenAPI document must be valid JSON for current worker parser");
  }
  const pathEntries = Object.entries(doc?.paths || {}).slice(0, 120);
  if (pathEntries.length === 0) return discoverFromRestSample(connection);

  const entities = [];
  const relationships = [];
  const methods = ["get", "post", "put", "patch", "delete", "options", "head"];

  for (const [path, pathValue] of pathEntries) {
    if (!pathValue || typeof pathValue !== "object") continue;
    const pathItem = pathValue;
    const pathParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of methods) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== "object") continue;

      const schemaColumns = [];
      schemaColumns.push(...extractOperationParameterColumns(doc, pathParameters, operation.parameters));

      const schema = resolveOperationSchema(doc, operation);
      if (schema) {
        schemaColumns.push(
          ...collectColumnsFromOpenApiSchema({
            doc,
            schema,
            prefix: "",
            required: false,
            depth: 0,
            seenRefs: new Set(),
          }),
        );
      }

      const fallbackPathParameters = Array.from(path.matchAll(/\{([^}]+)\}/g))
        .map((match) => sanitizeName(match[1]))
        .filter((value) => value.length > 0)
        .map((name) => ({
          name: `${name}_path`,
          dataType: "text",
          nullable: false,
          sensitivity: detectSensitivityByName(name),
          sampleValue: null,
        }));

      const columns = dedupeColumns([...schemaColumns, ...fallbackPathParameters]);
      const operationId = sanitizeName(operation.operationId || "");
      const entityName = operationId || sanitizeName(`${method}_${path}`) || `endpoint_${crypto.randomUUID().slice(0, 8)}`;
      const sensitivity = detectSensitivityByName(`${path} ${operation.summary || ""}`);

      entities.push({
        name: entityName,
        sourceKind: "endpoint",
        entityGroup: classifyEntityGroup(path),
        rowCount: 0,
        riskLevel: riskLevelFromSensitivity(sensitivity),
        sensitivity,
        description: operation.summary || operation.description || `${method.toUpperCase()} ${path}`,
        embeddingCoverage: 0,
        columns,
      });
    }
  }

  if (entities.length === 0) return discoverFromRestSample(connection);

  return {
    entities,
    relationships,
    schemaTablesCount: entities.length,
    schemaEntitiesCount: entities.length,
  };
}

function normalizeServiceAccountPayload(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

function toBase64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function signServiceAccountJwt(serviceAccount, scope) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = toBase64Url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(serviceAccount.private_key, "base64url");
  return `${unsigned}.${signature}`;
}

async function fetchGoogleAccessToken(serviceAccount, scope) {
  const assertion = signServiceAccountJwt(serviceAccount, scope);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error(`Google OAuth token exchange failed (${response.status})`);
  const payload = await response.json();
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  if (!accessToken) throw new Error("Google OAuth token response missing access_token");
  return accessToken;
}

async function discoverFromGoogleSheets(connection) {
  const config = parseConnectionConfig(connection);
  const sheetUrl = String(config.sheet_url || config.sheetUrl || config.spreadsheet_url || config.spreadsheetUrl || "").trim();
  const spreadsheetId = String(config.spreadsheet_id || config.spreadsheetId || parseSpreadsheetId(sheetUrl)).trim();
  if (!spreadsheetId) throw new Error("Google Sheets discovery requires spreadsheet URL or spreadsheet id");

  const serviceAccount = normalizeServiceAccountPayload(config.service_account_json || config.serviceAccountJson);
  if (!serviceAccount?.client_email || !serviceAccount?.private_key) {
    throw new Error("Google Sheets discovery requires valid service account JSON");
  }

  const accessToken = await fetchGoogleAccessToken(
    serviceAccount,
    "https://www.googleapis.com/auth/spreadsheets.readonly",
  );
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  const metadataResponse = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))`,
    { headers: authHeaders },
  );
  if (!metadataResponse.ok) throw new Error(`Google Sheets metadata fetch failed (${metadataResponse.status})`);
  const metadata = await metadataResponse.json();
  const sheets = Array.isArray(metadata?.sheets) ? metadata.sheets.slice(0, 60) : [];
  if (sheets.length === 0) throw new Error("No sheets discovered in spreadsheet");

  function inferTypeFromSheetValues(values) {
    const observed = new Map();
    for (const value of values.slice(0, 40)) {
      if (value === null || value === undefined || String(value).trim() === "") continue;
      const type = inferDataTypeFromValue(value);
      observed.set(type, (observed.get(type) || 0) + 1);
    }
    if (observed.size === 0) return "text";
    return Array.from(observed.entries()).sort((a, b) => b[1] - a[1])[0][0];
  }

  const entities = [];
  for (const sheet of sheets) {
    const title = String(sheet?.properties?.title || "").trim();
    if (!title) continue;
    const estimatedRows = Math.max(0, Number(sheet?.properties?.gridProperties?.rowCount ?? 0) - 1);

    const valuesResponse = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(title)}!1:250`,
      { headers: authHeaders },
    );
    if (!valuesResponse.ok) continue;
    const valuesPayload = await valuesResponse.json();
    const rows = Array.isArray(valuesPayload?.values) ? valuesPayload.values : [];
    const headerRow = Array.isArray(rows[0]) ? rows[0] : [];
    const headers = headerRow.map((value, index) => sanitizeName(value) || `column_${index + 1}`);
    const dataRows = rows.slice(1).filter((row) => Array.isArray(row));

    const columns =
      headers.length > 0
        ? dedupeColumns(
            headers.map((header, index) => {
              const columnValues = dataRows.map((row) => row[index]).filter((value) => value !== undefined);
              const sampleValue = columnValues.find(
                (value) => value !== null && String(value).trim() !== "",
              );
              return {
                name: header,
                dataType: inferTypeFromSheetValues(columnValues),
                nullable: columnValues.length === 0 || columnValues.some((value) => value === null || String(value).trim() === ""),
                sensitivity: detectSensitivityByName(header),
                sampleValue: sampleValueForColumn(sampleValue ?? null),
              };
            }),
          )
        : inferColumnsFromSamples(
            dataRows
              .map((row) => (Array.isArray(row) ? row : []))
              .slice(0, 8)
              .map((row) => Object.fromEntries(row.map((value, index) => [`column_${index + 1}`, value]))),
          );

    const entityName = sanitizeName(`${spreadsheetId}_${title}`) || sanitizeName(title);
    if (!entityName) continue;
    const sensitivity = detectSensitivityByName(title);
    entities.push({
      name: entityName,
      sourceKind: "sheet",
      entityGroup: classifyEntityGroup(title),
      rowCount:
        dataRows.length === 0
          ? 0
          : Math.max(dataRows.length, Math.min(estimatedRows, dataRows.length * 10)),
      riskLevel: riskLevelFromSensitivity(sensitivity),
      sensitivity,
      description: `Discovered Google Sheet tab ${title}`,
      embeddingCoverage: 0,
      columns:
        columns.length > 0
          ? columns
          : [{ name: "value", dataType: "text", nullable: true, sensitivity: "normal", sampleValue: null }],
    });
  }

  if (entities.length === 0) throw new Error("No Google Sheet tabs could be read");
  const relationships = inferRelationshipsFromEntities(entities, "inferred_sheet_fk");
  return {
    entities,
    relationships,
    schemaTablesCount: entities.length,
    schemaEntitiesCount: entities.length,
  };
}

function mapNotionPropertyType(value) {
  const type = String(value || "").toLowerCase();
  if (["number"].includes(type)) return "numeric";
  if (["date", "created_time", "last_edited_time"].includes(type)) return "timestamp";
  if (["checkbox"].includes(type)) return "boolean";
  if (["people", "relation", "rich_text", "multi_select", "files", "formula", "rollup"].includes(type)) return "jsonb";
  return "text";
}

function notionPropertySampleValue(propertyValue) {
  if (!propertyValue || typeof propertyValue !== "object") return null;
  const type = String(propertyValue.type || "").toLowerCase();

  if (type === "title" || type === "rich_text") {
    const rows = Array.isArray(propertyValue[type]) ? propertyValue[type] : [];
    const joined = rows.map((row) => String(row?.plain_text || "").trim()).filter(Boolean).join(" ").trim();
    return joined || null;
  }
  if (type === "number") return propertyValue.number ?? null;
  if (type === "checkbox") return propertyValue.checkbox ?? null;
  if (type === "date") return propertyValue.date?.start ?? null;
  if (type === "select") return propertyValue.select?.name ?? null;
  if (type === "status") return propertyValue.status?.name ?? null;
  if (type === "email") return propertyValue.email ?? null;
  if (type === "phone_number") return propertyValue.phone_number ?? null;
  if (type === "url") return propertyValue.url ?? null;
  if (type === "relation") {
    const relations = Array.isArray(propertyValue.relation) ? propertyValue.relation : [];
    return relations[0]?.id ?? null;
  }
  return null;
}

async function discoverFromNotion(connection) {
  const config = parseConnectionConfig(connection);
  const token = String(config.integration_token || config.integrationToken || config.api_key || config.apiKey || "").trim();
  if (!token) throw new Error("Notion discovery requires integration token");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };

  const providedDatabaseId = String(config.database_id || config.databaseId || "").trim();
  let databaseIds = providedDatabaseId ? [providedDatabaseId] : [];
  if (databaseIds.length === 0) {
    const searchResponse = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers,
      body: JSON.stringify({
        page_size: 50,
        filter: { property: "object", value: "database" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
      }),
    });
    if (!searchResponse.ok) throw new Error(`Notion database search failed (${searchResponse.status})`);
    const searchPayload = await searchResponse.json();
    databaseIds = Array.isArray(searchPayload?.results)
      ? searchPayload.results.map((result) => String(result?.id || "").trim()).filter((value) => value.length > 0).slice(0, 20)
      : [];
  }

  if (databaseIds.length === 0) throw new Error("No Notion databases available for discovery");

  const entities = [];
  const databaseIdToEntityName = new Map();
  const relationHints = [];
  for (const databaseId of databaseIds) {
    const databaseResponse = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
      method: "GET",
      headers,
    });
    if (!databaseResponse.ok) continue;
    const database = await databaseResponse.json();
    const titleParts = Array.isArray(database?.title) ? database.title : [];
    const title = titleParts
      .map((item) => String(item?.plain_text || "").trim())
      .filter((value) => value.length > 0)
      .join(" ")
      .trim();
    const name = sanitizeName(title || `notion_${databaseId.slice(0, 8)}`);
    const properties = database?.properties && typeof database.properties === "object" ? database.properties : {};
    const columns = Object.entries(properties).map(([propertyName, propertyValue]) => {
      const propertyType = String(propertyValue?.type || "text");
      const columnName = sanitizeName(propertyName) || sanitizeName(propertyType) || "field";
      if (propertyType === "relation") {
        const targetDb = String(propertyValue?.relation?.database_id || "").trim();
        if (targetDb) {
          relationHints.push({
            sourceEntity: name || sanitizeName(`notion_${databaseId}`),
            targetDatabaseId: targetDb,
            propertyName: columnName,
          });
        }
      }
      return {
        name: columnName,
        dataType: mapNotionPropertyType(propertyType),
        nullable: true,
        sensitivity: detectSensitivityByName(propertyName),
        sampleValue: null,
      };
    });

    let rowCount = 0;
    let cursor = null;
    let hasMore = true;
    let pagesRead = 0;
    const sampleRows = [];
    while (hasMore && pagesRead < 6) {
      const queryBody = { page_size: 100 };
      if (cursor) queryBody.start_cursor = cursor;
      const queryResponse = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify(queryBody),
      });
      if (!queryResponse.ok) break;
      const queryPayload = await queryResponse.json();
      const results = Array.isArray(queryPayload?.results) ? queryPayload.results : [];
      rowCount += results.length;
      if (sampleRows.length < 8) {
        sampleRows.push(...results.slice(0, 8 - sampleRows.length));
      }
      hasMore = Boolean(queryPayload?.has_more);
      cursor = queryPayload?.next_cursor ? String(queryPayload.next_cursor) : null;
      pagesRead += 1;
    }

    for (const column of columns) {
      for (const pageRow of sampleRows) {
        const propBag = pageRow?.properties && typeof pageRow.properties === "object" ? pageRow.properties : null;
        if (!propBag) continue;
        const match = Object.entries(propBag).find(([key]) => sanitizeName(key) === column.name);
        if (!match) continue;
        const sampleValue = notionPropertySampleValue(match[1]);
        if (sampleValue !== null && sampleValue !== undefined && sampleValue !== "") {
          column.sampleValue = sampleValueForColumn(sampleValue);
          break;
        }
      }
    }

    const sensitivity = detectSensitivityByName(title || name);
    const entityName = name || sanitizeName(`notion_${databaseId}`);
    databaseIdToEntityName.set(databaseId, entityName);
    entities.push({
      name: entityName,
      sourceKind: "table",
      entityGroup: classifyEntityGroup(title || name),
      rowCount,
      riskLevel: riskLevelFromSensitivity(sensitivity),
      sensitivity,
      description: `Discovered Notion database ${title || databaseId}${hasMore ? " (partial paged count; more rows may exist)" : ""}`,
      embeddingCoverage: 0,
      columns: dedupeColumns(columns),
    });
  }

  if (entities.length === 0) throw new Error("No readable Notion databases discovered");
  const explicitRelationships = relationHints
    .map((hint) => {
      const targetEntity = databaseIdToEntityName.get(hint.targetDatabaseId);
      if (!hint.sourceEntity || !targetEntity || hint.sourceEntity === targetEntity) return null;
      return {
        sourceName: hint.sourceEntity,
        targetName: targetEntity,
        relationType: "notion_relation",
        label: `${hint.sourceEntity}.${hint.propertyName} -> ${targetEntity}`,
      };
    })
    .filter(Boolean);
  const inferredRelationships = inferRelationshipsFromEntities(entities, "inferred_notion_fk");
  const relationshipKey = new Set();
  const relationships = [...explicitRelationships, ...inferredRelationships].filter((row) => {
    const key = `${row.sourceName}->${row.targetName}:${row.label}`;
    if (relationshipKey.has(key)) return false;
    relationshipKey.add(key);
    return true;
  });

  return {
    entities,
    relationships,
    schemaTablesCount: entities.length,
    schemaEntitiesCount: entities.length,
  };
}

function normalizeFirebaseBaseUrl(config) {
  const explicitUrl = String(config.database_url || config.databaseUrl || config.base_url || config.baseUrl || "").trim();
  if (!explicitUrl) return "";
  if (explicitUrl.endsWith("/")) return explicitUrl.slice(0, -1);
  return explicitUrl;
}

async function discoverFromFirebase(connection) {
  const config = parseConnectionConfig(connection);
  const baseUrl = normalizeFirebaseBaseUrl(config);
  if (!baseUrl) throw new Error("Firebase discovery requires database URL");

  const token = String(config.auth_token || config.authToken || config.api_key || config.apiKey || "").trim();
  const authQuery = token ? `auth=${encodeURIComponent(token)}` : "";
  const shallowUrl = `${baseUrl}/.json${authQuery ? `?${authQuery}&shallow=true` : "?shallow=true"}`;
  const rootResponse = await fetch(shallowUrl, { method: "GET" });
  if (!rootResponse.ok) throw new Error(`Firebase shallow read failed (${rootResponse.status})`);
  const rootPayload = await rootResponse.json();
  if (!rootPayload || typeof rootPayload !== "object" || Array.isArray(rootPayload)) {
    throw new Error("Firebase root payload is not introspectable");
  }

  const topKeys = Object.keys(rootPayload).slice(0, 80);
  if (topKeys.length === 0) throw new Error("Firebase discovery found no top-level collections");
  const entities = [];

  for (const key of topKeys) {
    const shallowChildParams = new URLSearchParams({ shallow: "true" });
    if (token) shallowChildParams.set("auth", token);
    const shallowChildUrl = `${baseUrl}/${encodeURIComponent(key)}.json?${shallowChildParams.toString()}`;
    const shallowChildResponse = await fetch(shallowChildUrl, { method: "GET" });

    let rowCount = 0;
    let sampleRows = [];
    if (shallowChildResponse.ok) {
      const shallowPayload = await shallowChildResponse.json();
      if (Array.isArray(shallowPayload)) {
        rowCount = shallowPayload.length;
      } else if (shallowPayload && typeof shallowPayload === "object") {
        const childKeys = Object.keys(shallowPayload);
        rowCount = childKeys.length;

        for (const childKey of childKeys.slice(0, 5)) {
          const childParams = new URLSearchParams();
          if (token) childParams.set("auth", token);
          const childUrl = `${baseUrl}/${encodeURIComponent(key)}/${encodeURIComponent(childKey)}.json${childParams.toString() ? `?${childParams.toString()}` : ""}`;
          const childResponse = await fetch(childUrl, { method: "GET" });
          if (!childResponse.ok) continue;
          const childPayload = await childResponse.json();
          if (childPayload && typeof childPayload === "object" && !Array.isArray(childPayload)) {
            sampleRows.push(childPayload);
          }
        }
      } else if (typeof shallowPayload === "boolean" && shallowPayload === true) {
        rowCount = 1;
      }
    }

    if (sampleRows.length === 0) {
      const sampleParams = new URLSearchParams({
        orderBy: "\"$key\"",
        limitToFirst: "5",
      });
      if (token) sampleParams.set("auth", token);
      const sampleUrl = `${baseUrl}/${encodeURIComponent(key)}.json?${sampleParams.toString()}`;
      const sampleResponse = await fetch(sampleUrl, { method: "GET" });
      if (sampleResponse.ok) {
        const samplePayload = await sampleResponse.json();
        if (samplePayload && typeof samplePayload === "object") {
          const values = Array.isArray(samplePayload) ? samplePayload : Object.values(samplePayload);
          sampleRows = values.filter((value) => value && typeof value === "object" && !Array.isArray(value)).slice(0, 5);
          if (rowCount === 0) rowCount = values.length;
        }
      }
    }

    const inferredColumns = inferColumnsFromSamples(sampleRows);
    const columns = inferredColumns.length > 0
      ? inferredColumns
      : [{ name: "value", dataType: "jsonb", nullable: true, sensitivity: "normal", sampleValue: null }];
    const entityName = sanitizeName(`firebase_${key}`);
    const sensitivity = detectSensitivityByName(key);
    entities.push({
      name: entityName,
      sourceKind: "collection",
      entityGroup: classifyEntityGroup(key),
      rowCount: Math.max(0, Number(rowCount || 0)),
      riskLevel: riskLevelFromSensitivity(sensitivity),
      sensitivity,
      description: `Discovered Firebase path ${key}`,
      embeddingCoverage: 0,
      columns: dedupeColumns(columns),
    });
  }

  const relationships = inferRelationshipsFromEntities(entities, "inferred_firebase_fk");

  return {
    entities,
    relationships,
    schemaTablesCount: entities.length,
    schemaEntitiesCount: entities.length,
  };
}

async function discoverFromPostgres(connection) {
  const config = parseConnectionConfig(connection);
  const connectionString = String(config.connection_string || config.connectionString || "").trim();
  const { Client } = await import("pg");
  const clientConfig = {
    connectionTimeoutMillis: 8000,
    statement_timeout: 15000,
    ssl: parsePostgresSslConfig(config),
  };

  if (connectionString) {
    clientConfig.connectionString = connectionString;
  } else {
    clientConfig.host = String(config.host || "").trim();
    clientConfig.port = Number(config.port || 5432);
    clientConfig.database = String(config.database || "").trim();
    clientConfig.user = String(config.username || config.user || "").trim();
    clientConfig.password = String(config.password || "").trim();
  }

  if (!clientConfig.connectionString && (!clientConfig.host || !clientConfig.database || !clientConfig.user)) {
    throw new Error("PostgreSQL connector missing host/database/username");
  }

  const client = new Client(clientConfig);
  await client.connect();
  try {
    const tablesQuery = `
      SELECT
        t.table_schema AS schema_name,
        t.table_name AS table_name,
        COALESCE(c.reltuples::bigint, 0) AS row_estimate
      FROM information_schema.tables t
      LEFT JOIN pg_class c
        ON c.relname = t.table_name
      LEFT JOIN pg_namespace n
        ON n.oid = c.relnamespace
       AND n.nspname = t.table_schema
      WHERE t.table_type = 'BASE TABLE'
        AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY t.table_schema, t.table_name
      LIMIT 250
    `;

    const columnsQuery = `
      SELECT
        c.table_schema AS schema_name,
        c.table_name AS table_name,
        c.column_name AS column_name,
        c.data_type AS data_type,
        c.is_nullable AS is_nullable,
        c.ordinal_position AS ordinal_position
      FROM information_schema.columns c
      WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY c.table_schema, c.table_name, c.ordinal_position
      LIMIT 8000
    `;

    const relationsQuery = `
      SELECT
        kcu.table_schema AS source_schema,
        kcu.table_name AS source_table,
        kcu.column_name AS source_column,
        ccu.table_schema AS target_schema,
        ccu.table_name AS target_table,
        ccu.column_name AS target_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
      LIMIT 1500
    `;

    const [tablesResult, columnsResult, relationsResult] = await Promise.all([
      client.query(tablesQuery),
      client.query(columnsQuery),
      client.query(relationsQuery),
    ]);

    const columnsByTable = new Map();
    for (const row of columnsResult.rows || []) {
      const key = `${row.schema_name}.${row.table_name}`;
      if (!columnsByTable.has(key)) columnsByTable.set(key, []);
      const sensitivity = detectSensitivityByName(row.column_name);
      columnsByTable.get(key).push({
        name: sanitizeName(row.column_name) || "column",
        dataType: row.data_type || "text",
        nullable: String(row.is_nullable || "").toUpperCase() === "YES",
        sensitivity,
        sampleValue: null,
      });
    }

    const entityNameByTable = new Map();
    const entities = (tablesResult.rows || []).map((row) => {
      const tableKey = `${row.schema_name}.${row.table_name}`;
      const entityName = sanitizeName(`${row.schema_name}_${row.table_name}`);
      entityNameByTable.set(tableKey, entityName);
      const sensitivity = detectSensitivityByName(row.table_name);
      return {
        name: entityName,
        sourceKind: "table",
        entityGroup: classifyEntityGroup(row.table_name),
        rowCount: Math.max(0, Number(row.row_estimate || 0)),
        riskLevel: riskLevelFromSensitivity(sensitivity),
        sensitivity,
        description: `Discovered PostgreSQL table ${row.schema_name}.${row.table_name}`,
        embeddingCoverage: 0,
        columns: columnsByTable.get(tableKey) || [],
      };
    });

    const relationships = (relationsResult.rows || [])
      .map((row) => {
        const sourceName = entityNameByTable.get(`${row.source_schema}.${row.source_table}`);
        const targetName = entityNameByTable.get(`${row.target_schema}.${row.target_table}`);
        if (!sourceName || !targetName) return null;
        return {
          sourceName,
          targetName,
          relationType: "foreign_key",
          label: `${row.source_table}.${row.source_column} -> ${row.target_table}.${row.target_column}`,
        };
      })
      .filter(Boolean);

    if (entities.length === 0) {
      throw new Error("No PostgreSQL tables discovered (check privileges)");
    }

    return {
      entities,
      relationships,
      schemaTablesCount: entities.length,
      schemaEntitiesCount: entities.length,
    };
  } finally {
    await client.end();
  }
}

async function discoverFromMySql(connection) {
  const config = parseConnectionConfig(connection);
  const connectionString = String(config.connection_string || config.connectionString || "").trim();
  const mysql = await import("mysql2/promise");
  let conn = null;

  try {
    if (connectionString) {
      conn = await mysql.createConnection(connectionString);
    } else {
      conn = await mysql.createConnection({
        host: String(config.host || "").trim(),
        port: Number(config.port || 3306),
        user: String(config.username || config.user || "").trim(),
        password: String(config.password || "").trim(),
        database: String(config.database || "").trim(),
        ssl: parseMySqlSslConfig(config),
        connectTimeout: 8000,
      });
    }

    const [dbRow] = await conn.query("SELECT DATABASE() AS db_name");
    const databaseName = String(dbRow?.[0]?.db_name || config.database || "").trim();
    if (!databaseName) throw new Error("MySQL database name is required");

    const [tablesRows] = await conn.query(
      `
      SELECT
        table_name,
        table_rows
      FROM information_schema.tables
      WHERE table_schema = ?
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
      LIMIT 250
      `,
      [databaseName],
    );

    const [columnsRows] = await conn.query(
      `
      SELECT
        table_name,
        column_name,
        data_type,
        is_nullable,
        ordinal_position
      FROM information_schema.columns
      WHERE table_schema = ?
      ORDER BY table_name, ordinal_position
      LIMIT 8000
      `,
      [databaseName],
    );

    const [relationRows] = await conn.query(
      `
      SELECT
        table_name AS source_table,
        column_name AS source_column,
        referenced_table_name AS target_table,
        referenced_column_name AS target_column
      FROM information_schema.key_column_usage
      WHERE table_schema = ?
        AND referenced_table_name IS NOT NULL
      LIMIT 1500
      `,
      [databaseName],
    );

    const columnsByTable = new Map();
    for (const row of columnsRows || []) {
      const key = String(row.table_name || "");
      if (!columnsByTable.has(key)) columnsByTable.set(key, []);
      const sensitivity = detectSensitivityByName(row.column_name);
      columnsByTable.get(key).push({
        name: sanitizeName(row.column_name) || "column",
        dataType: row.data_type || "text",
        nullable: String(row.is_nullable || "").toUpperCase() === "YES",
        sensitivity,
        sampleValue: null,
      });
    }

    const entityNameByTable = new Map();
    const entities = (tablesRows || []).map((row) => {
      const tableName = String(row.table_name || "");
      const entityName = sanitizeName(`${databaseName}_${tableName}`);
      entityNameByTable.set(tableName, entityName);
      const sensitivity = detectSensitivityByName(tableName);
      return {
        name: entityName,
        sourceKind: "table",
        entityGroup: classifyEntityGroup(tableName),
        rowCount: Math.max(0, Number(row.table_rows || 0)),
        riskLevel: riskLevelFromSensitivity(sensitivity),
        sensitivity,
        description: `Discovered MySQL table ${databaseName}.${tableName}`,
        embeddingCoverage: 0,
        columns: columnsByTable.get(tableName) || [],
      };
    });

    const relationships = (relationRows || [])
      .map((row) => {
        const sourceName = entityNameByTable.get(String(row.source_table || ""));
        const targetName = entityNameByTable.get(String(row.target_table || ""));
        if (!sourceName || !targetName) return null;
        return {
          sourceName,
          targetName,
          relationType: "foreign_key",
          label: `${row.source_table}.${row.source_column} -> ${row.target_table}.${row.target_column}`,
        };
      })
      .filter(Boolean);

    if (entities.length === 0) {
      throw new Error("No MySQL tables discovered (check privileges)");
    }

    return {
      entities,
      relationships,
      schemaTablesCount: entities.length,
      schemaEntitiesCount: entities.length,
    };
  } finally {
    if (conn) await conn.end();
  }
}

function parseMongoDatabaseFromConnectionString(connectionString) {
  try {
    const parsed = new URL(connectionString);
    return parsed.pathname.replace(/^\/+/, "").split("?")[0] || "";
  } catch {
    return "";
  }
}

async function discoverFromMongoDb(connection) {
  const config = parseConnectionConfig(connection);
  const connectionString = String(
    config.connection_string || config.connectionString || connection.base_url || "",
  ).trim();
  if (!connectionString) throw new Error("MongoDB connection string is required");

  const { MongoClient } = await import("mongodb");
  const databaseName =
    String(config.database || "").trim() || parseMongoDatabaseFromConnectionString(connectionString);

  const client = new MongoClient(connectionString, {
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 4,
  });

  await client.connect();
  try {
    const db = databaseName ? client.db(databaseName) : client.db();
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    const limitedCollections = collections.slice(0, 120);

    const entities = [];
    for (const collection of limitedCollections) {
      const collectionName = String(collection.name || "").trim();
      if (!collectionName) continue;
      const handle = db.collection(collectionName);
      const [sample, rowCount] = await Promise.all([
        handle.findOne({}),
        handle.estimatedDocumentCount({ maxTimeMS: 5000 }).catch(() => 0),
      ]);
      const sampleColumns = columnsFromRecord(sample || { _id: null });
      const sensitivity = detectSensitivityByName(collectionName);
      entities.push({
        name: sanitizeName(`${db.databaseName}_${collectionName}`),
        sourceKind: "collection",
        entityGroup: classifyEntityGroup(collectionName),
        rowCount: Math.max(0, Number(rowCount || 0)),
        riskLevel: riskLevelFromSensitivity(sensitivity),
        sensitivity,
        description: `Discovered MongoDB collection ${db.databaseName}.${collectionName}`,
        embeddingCoverage: 0,
        columns: sampleColumns.length > 0 ? sampleColumns : [{ name: "_id", dataType: "objectid", nullable: false, sensitivity: "normal", sampleValue: null }],
      });
    }

    if (entities.length === 0) {
      throw new Error("No MongoDB collections discovered");
    }

    return {
      entities,
      relationships: [],
      schemaTablesCount: entities.length,
      schemaEntitiesCount: entities.length,
    };
  } finally {
    await client.close();
  }
}

async function discoverFromConnection(connection) {
  const type = normalizeConnectionType(connection.type);

  if (type === "rest_openapi" || type === "custom_rest") {
    return discoverFromOpenApi(connection);
  }

  if (type === "postgresql") return discoverFromPostgres(connection);
  if (type === "mysql") return discoverFromMySql(connection);
  if (type === "mongodb") return discoverFromMongoDb(connection);
  if (type === "google_sheets") return discoverFromGoogleSheets(connection);
  if (type === "notion") return discoverFromNotion(connection);
  if (type === "firebase") return discoverFromFirebase(connection);

  throw new Error(`Schema discovery is not implemented for connector type: ${type}`);
}

async function claimConnectorJobs(limit = 3) {
  const { data, error } = await supabase.rpc("claim_connector_jobs", {
    p_worker_id: workerId,
    p_limit: limit,
    p_queues: null,
  });

  if (!error) {
    const claimed = (data || []).map((row) => ({
      id: row.job_id,
      tenant_id: row.tenant_id,
      connection_id: row.connection_id,
      payload: row.payload || {},
      attempt_count: row.attempt_count || 0,
      max_attempts: row.max_attempts || 5,
      status: "running",
      started_at: row.started_at || null,
      job_type: row.job_type || "schema_discovery",
      queue: row.queue || "connector-sync",
    }));
    if (claimed.length > 0) {
      console.log(
        "claimed connector jobs",
        JSON.stringify({
          count: claimed.length,
          jobs: claimed.map((job) => ({ id: job.id, type: job.job_type, connection: job.connection_id })),
        }),
      );
    }
    return claimed;
  }

  if (!isMissingRpc(error) && !isLegacyTenantAmbiguity(error)) throw error;

  const fallback = await supabase
    .from("connector_jobs")
    .select("id, tenant_id, connection_id, payload, attempt_count, max_attempts, status, started_at, job_type, queue")
    .eq("status", "queued")
    .lte("scheduled_at", new Date().toISOString())
    .order("priority", { ascending: false })
    .order("scheduled_at", { ascending: true })
    .limit(limit);

  if (fallback.error) throw fallback.error;
  const rows = fallback.data || [];

  for (const row of rows) {
    await supabase
      .from("connector_jobs")
      .update({
        status: "running",
        worker_id: workerId,
        started_at: row.started_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "queued");
  }

  return rows;
}

async function emitWorkerHeartbeat() {
  const now = Date.now();
  if (now - lastHeartbeatAt < workerHeartbeatIntervalMs) return;
  lastHeartbeatAt = now;

  const nowIso = new Date().toISOString();
  const queueWindowIso = new Date(now - 30 * 60 * 1000).toISOString();

  const [queuedConnector, runningConnector, staleConnector, queuedEmbedding, runningEmbedding] = await Promise.all([
    supabase
      .from("connector_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued")
      .lte("scheduled_at", nowIso),
    supabase
      .from("connector_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "running"),
    supabase
      .from("connector_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued")
      .lte("scheduled_at", queueWindowIso),
    supabase
      .from("embedding_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued")
      .lte("scheduled_at", nowIso),
    supabase
      .from("embedding_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "running"),
  ]);

  if (queuedConnector.error) throw queuedConnector.error;
  if (runningConnector.error) throw runningConnector.error;
  if (staleConnector.error) throw staleConnector.error;
  if (queuedEmbedding.error) throw queuedEmbedding.error;
  if (runningEmbedding.error) throw runningEmbedding.error;

  console.log(
    "worker heartbeat",
    JSON.stringify({
      workerId,
      ts: nowIso,
      queue: {
        connector: {
          queued_ready: Number(queuedConnector.count || 0),
          queued_older_than_30m: Number(staleConnector.count || 0),
          running: Number(runningConnector.count || 0),
        },
        embedding: {
          queued_ready: Number(queuedEmbedding.count || 0),
          running: Number(runningEmbedding.count || 0),
        },
      },
    }),
  );
}

async function runConnectorJobs() {
  const jobs = await claimConnectorJobs(3);
  if (!jobs || jobs.length === 0) return;

  for (const job of jobs) {
    const startedAtMs = Date.now();
    const finalizeCallbackFailure = async (reason, failedPayload = null) => {
      const now = new Date().toISOString();
      const message = String(reason || "Worker callback failed");
      const nextAttempt = Number(job.attempt_count || 0) + 1;
      const maxAttempts = Number(job.max_attempts || 5);
      const shouldRetry = nextAttempt < maxAttempts;
      const retryAt = shouldRetry ? new Date(Date.now() + retryDelaySeconds(nextAttempt) * 1000).toISOString() : null;
      const callbackReplayPayload =
        failedPayload && typeof failedPayload === "object" && !Array.isArray(failedPayload) ? failedPayload : null;
      let callbackReplaySize = 0;
      if (callbackReplayPayload) {
        try {
          callbackReplaySize = JSON.stringify(callbackReplayPayload).length;
        } catch {
          callbackReplaySize = 0;
        }
      }
      const shouldQueueCallbackReplay =
        shouldRetry &&
        callbackReplayPayload &&
        callbackReplaySize > 0 &&
        callbackReplaySize <= 1_500_000 &&
        ["success", "error", "cancelled", "dead_letter"].includes(String(callbackReplayPayload.status || ""));

      await supabase
        .from("connector_jobs")
        .update({
          status: shouldRetry ? "queued" : "dead_letter",
          progress: shouldRetry ? 0 : 100,
          attempt_count: nextAttempt,
          last_error: message,
          scheduled_at: retryAt,
          started_at: shouldRetry ? null : job.started_at ?? now,
          worker_id: shouldRetry ? null : workerId,
          finished_at: shouldRetry ? null : now,
          updated_at: now,
          payload: shouldQueueCallbackReplay
            ? {
                ...(job.payload || {}),
                callback_only: true,
                callback_payload: callbackReplayPayload,
                callback_retry_reason: message,
                callback_retry_at: retryAt,
              }
            : (job.payload || {}),
          result: {
            stage: shouldQueueCallbackReplay ? "callback_retry_queued" : "schema_discovery_failed",
            durationMs: Math.max(1, Date.now() - startedAtMs),
            callback_failed: true,
            callback_retry_scheduled_at: retryAt,
          },
        })
        .eq("id", job.id);

      await supabase
        .from("connection_sync_runs")
        .update({
          status: "error",
          finished_at: now,
          error_message: message,
          details: {
            stage: "schema_discovery_failed",
            callback_failed: true,
            callback_retry_scheduled_at: retryAt,
          },
        })
        .eq("tenant_id", job.tenant_id)
        .eq("connection_id", job.connection_id)
        .eq("status", "running");

      await supabase
        .from("api_connections")
        .update({
          status: shouldRetry ? "pending" : "error",
          health: "degraded",
          last_error: message,
          next_sync_at: retryAt ?? undefined,
        })
        .eq("id", job.connection_id)
        .eq("tenant_id", job.tenant_id);
    };

    const safeCallback = async (payload, options = {}) => {
      const status = String(payload?.status || "").toLowerCase();
      const terminalStatus = ["success", "error", "cancelled", "dead_letter"].includes(status);
      const critical = options.critical ?? terminalStatus;
      const maxAttempts = Number(
        options.maxAttempts ?? (terminalStatus ? connectorCallbackMaxAttempts : connectorProgressCallbackMaxAttempts),
      );

      try {
        await callbackConnectorJob(payload, { maxAttempts });
        return true;
      } catch (callbackError) {
        const callbackMessage =
          callbackError instanceof Error
            ? callbackError.message
            : `Callback failed for job ${job.id}`;
        console.error("connector callback failure", {
          jobId: job.id,
          status,
          critical,
          callbackMessage,
        });
        if (critical) {
          await finalizeCallbackFailure(callbackMessage, payload);
          return false;
        }
        return true;
      }
    };

    try {
      const callbackOnly = Boolean(job.payload?.callback_only);
      const callbackPayload =
        callbackOnly && job.payload && typeof job.payload === "object" ? job.payload.callback_payload : null;
      if (callbackOnly && callbackPayload && typeof callbackPayload === "object") {
        const replayPayload = {
          ...callbackPayload,
          jobId: job.id,
          workerId,
        };
        if (!(await safeCallback(replayPayload, { critical: true, maxAttempts: connectorCallbackMaxAttempts }))) {
          continue;
        }
        continue;
      }

      if (
        !(await safeCallback({
          jobId: job.id,
          workerId,
          status: "running",
          progress: 10,
          result: {
            stage: "connection_verified",
            attempt: Number(job.attempt_count || 0) + 1,
          },
        }))
      ) {
        continue;
      }

      const { data: connection, error: connectionError } = await supabase
        .from("api_connections")
        .select("id, name, type, auth_type, connection_config")
        .eq("id", job.connection_id)
        .maybeSingle();

      if (connectionError) throw connectionError;
      if (!connection) throw new Error("Connection not found");

      if (
        !(await safeCallback({
          jobId: job.id,
          workerId,
          status: "running",
          progress: 28,
          result: {
            stage: "reading_schema_structure",
          },
        }))
      ) {
        continue;
      }

      const discoveredSchema = await withTimeout(
        discoverFromConnection(connection),
        connectorDiscoveryTimeoutMs,
        `Schema discovery for ${connection.type}`,
      );
      const schema = normalizeSchemaPayload(discoveredSchema, { connectionType: connection.type });
      if (!Array.isArray(schema.entities) || schema.entities.length === 0) {
        throw new Error(`No readable entities discovered for ${String(connection.type || "connection")}`);
      }

      if (
        !(await safeCallback({
          jobId: job.id,
          workerId,
          status: "running",
          progress: 52,
          result: {
            stage: "classifying_entities",
            discoveredEntities: schema.entities.length,
          },
        }))
      ) {
        continue;
      }

      if (
        !(await safeCallback({
          jobId: job.id,
          workerId,
          status: "running",
          progress: 72,
          result: {
            stage: "building_knowledge_graph",
          },
        }))
      ) {
        continue;
      }

      if (
        !(await safeCallback({
          jobId: job.id,
          workerId,
          status: "running",
          progress: 88,
          result: {
            stage: "generating_embeddings",
          },
        }))
      ) {
        continue;
      }

      if (
        !(await safeCallback({
          jobId: job.id,
          workerId,
          status: "running",
          progress: 95,
          result: {
            stage: "creating_ai_agents",
          },
        }))
      ) {
        continue;
      }

      if (
        !(await safeCallback(
          {
            jobId: job.id,
            workerId,
            status: "success",
            progress: 100,
            schema: {
              entities: schema.entities,
              relationships: schema.relationships,
            },
            result: {
              schemaTablesCount: schema.schemaTablesCount,
              schemaEntitiesCount: schema.schemaEntitiesCount,
              stage: "schema_bootstrapped",
              durationMs: Date.now() - startedAtMs,
              discoveredEntities: schema.entities.length,
              discoveredRelationships: schema.relationships.length,
            },
          },
          { critical: true, maxAttempts: connectorCallbackMaxAttempts },
        ))
      ) {
        continue;
      }
    } catch (errorCaught) {
      const classifiedError = classifyConnectorFailure(errorCaught);
      const failurePayload = {
        jobId: job.id,
        workerId,
        status: "error",
        progress: 100,
        error: classifiedError.message,
        result: {
          stage: "schema_discovery_failed",
          durationMs: Date.now() - startedAtMs,
          error_category: classifiedError.category,
          retryable: classifiedError.retryable,
          remediation: classifiedError.remediation,
        },
      };
      if (!(await safeCallback(failurePayload, { critical: true, maxAttempts: connectorCallbackMaxAttempts }))) {
        // Already finalized locally by safeCallback fallback.
        continue;
      }
    }
  }
}

async function createEmbedding(input) {
  if (!openaiApiKey) throw new Error("OPENAI_API_KEY is not configured for embedding worker");

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: embeddingModel,
      input,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI embeddings failed (${response.status}): ${text}`);
  }

  const payload = await response.json();
  const vector = payload?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error("OpenAI embeddings response missing vector");
  return vector;
}

function isNonRetryableEmbeddingError(error) {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  if (!message) return false;
  return (
    message.includes("openai_api_key is not configured") ||
    message.includes("knowledge chunk not found") ||
    message.includes("knowledge chunk content is empty") ||
    message.includes("invalid_api_key") ||
    message.includes("incorrect api key") ||
    message.includes("authentication") ||
    message.includes("(401)") ||
    message.includes("(403)")
  );
}

function vectorToPg(vector) {
  return `[${vector.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

async function claimEmbeddingJobs(limit = 5) {
  const { data, error } = await supabase.rpc("claim_embedding_jobs", {
    p_worker_id: workerId,
    p_limit: limit,
  });

  if (!error) {
    return (data || []).map((row) => ({
      id: row.job_id,
      tenant_id: row.tenant_id,
      source_type: row.source_type,
      source_id: row.source_id,
      embedding_model: row.embedding_model,
      payload: row.payload || {},
      attempt_count: row.attempt_count || 0,
      max_attempts: row.max_attempts || 5,
      started_at: row.started_at || null,
      status: "running",
    }));
  }

  if (!isMissingRpc(error) && !isLegacyTenantAmbiguity(error)) throw error;

  const fallback = await supabase
    .from("embedding_jobs")
    .select("id, tenant_id, source_type, source_id, embedding_model, payload, attempt_count, max_attempts, started_at, status")
    .eq("status", "queued")
    .lte("scheduled_at", new Date().toISOString())
    .order("priority", { ascending: false })
    .order("scheduled_at", { ascending: true })
    .limit(limit);

  if (fallback.error) throw fallback.error;
  const rows = fallback.data || [];

  for (const row of rows) {
    await supabase
      .from("embedding_jobs")
      .update({
        status: "running",
        worker_id: workerId,
        started_at: row.started_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "queued");
  }

  return rows;
}

async function runEmbeddingJobs() {
  const jobs = await claimEmbeddingJobs(5);
  if (!jobs || jobs.length === 0) return;

  for (const job of jobs) {
    const startedAt = job.started_at || new Date().toISOString();
    const startedAtMs = new Date(startedAt).getTime();
    try {
      let content = "";
      if (job.source_type === "knowledge_chunk") {
        const { data: chunk, error: chunkError } = await supabase
          .from("knowledge_document_chunks")
          .select("id, document_id, content")
          .eq("id", job.source_id)
          .maybeSingle();
        if (chunkError) throw chunkError;
        if (!chunk) throw new Error("Knowledge chunk not found");

        content = String(chunk.content || "").trim();
        if (!content) throw new Error("Knowledge chunk content is empty");

        const vector = await createEmbedding(content);
        await supabase
          .from("knowledge_document_chunks")
          .update({
            embedding: vectorToPg(vector),
            embedding_model: job.embedding_model || embeddingModel,
            embedded_at: new Date().toISOString(),
            embedding_state: "embedded",
          })
          .eq("id", chunk.id);

        const { data: chunkDoc } = await supabase
          .from("knowledge_documents")
          .select("tenant_id, source_type, storage_path")
          .eq("id", chunk.document_id)
          .maybeSingle();

        if (chunkDoc?.source_type === "connection_schema") {
          const storagePath = String(chunkDoc.storage_path || "");
          const pathMatch = storagePath.match(/^connector-schema\/([0-9a-f-]{36})\//i);
          const connectionId = pathMatch?.[1] ?? null;

          if (connectionId) {
            const { data: schemaDocs } = await supabase
              .from("knowledge_documents")
              .select("id")
              .eq("tenant_id", chunkDoc.tenant_id)
              .eq("source_type", "connection_schema")
              .like("storage_path", `connector-schema/${connectionId}/%`);

            const schemaDocIds = (schemaDocs ?? []).map((doc) => doc.id);
            if (schemaDocIds.length > 0) {
              const { count: embeddedCount } = await supabase
                .from("knowledge_document_chunks")
                .select("id", { count: "exact", head: true })
                .eq("tenant_id", chunkDoc.tenant_id)
                .eq("embedding_state", "embedded")
                .in("document_id", schemaDocIds);

              const embedded = embeddedCount ?? 0;
              const docCount = schemaDocIds.length;
              const coveragePct = docCount > 0 ? Math.min(100, Math.round((embedded / docCount) * 100)) : 0;

              await supabase
                .from("api_connections")
                .update({
                  embeddings_indexed: embedded,
                  updated_at: new Date().toISOString(),
                })
                .eq("tenant_id", chunkDoc.tenant_id)
                .eq("id", connectionId);

              await supabase
                .from("connection_entities")
                .update({
                  embedding_coverage: coveragePct,
                  updated_at: new Date().toISOString(),
                })
                .eq("tenant_id", chunkDoc.tenant_id)
                .eq("connection_id", connectionId);
            }
          }
        }
      } else if (job.source_type === "document") {
        const { data: doc } = await supabase
          .from("knowledge_documents")
          .select("tenant_id")
          .eq("id", job.source_id)
          .maybeSingle();

        if (!doc) throw new Error("Document not found for embedding reindex");

        const { data: scheduleData, error: scheduleError } = await supabase.rpc("schedule_knowledge_embedding_reindex", {
          p_document_id: job.source_id,
          p_tenant_id: doc.tenant_id,
          p_force: true,
          p_limit: 4000,
        });

        if (scheduleError && !isMissingRpc(scheduleError)) {
          throw scheduleError;
        }

        const scheduled = scheduleData?.[0]?.queued_count || 0;
        content = `document:${job.source_id}:queued_chunks=${scheduled}`;
      } else if (job.source_type === "connection_entity") {
        content = `connection_entity:${job.source_id}:skipped`;
      } else {
        content = `${job.source_type}:${job.source_id}`;
      }

      await supabase
        .from("embedding_jobs")
        .update({
          status: "success",
          finished_at: new Date().toISOString(),
          token_estimate: Math.round(content.length / 4),
          result: { embedded: true, sourceType: job.source_type },
          worker_id: workerId,
          last_error: null,
        })
        .eq("id", job.id);
    } catch (errorCaught) {
      const nextAttempt = Number(job.attempt_count || 0) + 1;
      const maxAttempts = Number(job.max_attempts || 5);
      const nonRetryable = isNonRetryableEmbeddingError(errorCaught);
      const shouldRetry = !nonRetryable && nextAttempt < maxAttempts;
      const retryAt = shouldRetry
        ? new Date(Date.now() + retryDelaySeconds(nextAttempt) * 1000).toISOString()
        : null;

      await supabase
        .from("embedding_jobs")
        .update({
          status: shouldRetry ? "queued" : "dead_letter",
          finished_at: shouldRetry ? null : new Date().toISOString(),
          started_at: shouldRetry ? null : startedAt,
          scheduled_at: retryAt,
          attempt_count: nextAttempt,
          result: {
            failed: true,
            retriable: shouldRetry,
            durationMs: Math.max(1, Date.now() - startedAtMs),
            non_retryable: nonRetryable,
          },
          worker_id: workerId,
          last_error: errorCaught instanceof Error ? errorCaught.message : "Embedding job failed",
        })
        .eq("id", job.id);

      if (job.source_type === "knowledge_chunk") {
        await supabase
          .from("knowledge_document_chunks")
          .update({
            embedding_state: shouldRetry ? "pending" : "error",
          })
          .eq("id", job.source_id);
      }
    }
  }
}

async function claimAgentRunJobs(limit = 3) {
  const { data, error } = await supabase.rpc("claim_agent_run_jobs", {
    p_worker_id: workerId,
    p_limit: limit,
    p_queues: null,
  });

  if (!error) {
    return (data || []).map((row) => ({
      id: row.job_id,
      tenant_id: row.tenant_id,
      run_id: row.run_id,
      agent_id: row.agent_id,
      queue: row.queue || "agent-runtime",
      payload: row.payload || {},
      attempt_count: row.attempt_count || 0,
      max_attempts: row.max_attempts || 5,
      started_at: row.started_at || null,
    }));
  }

  if (!isMissingRpc(error) && !isLegacyTenantAmbiguity(error)) throw error;

  const fallback = await supabase
    .from("agent_run_jobs")
    .select("id, tenant_id, run_id, agent_id, queue, payload, attempt_count, max_attempts, started_at")
    .eq("status", "queued")
    .lte("scheduled_at", new Date().toISOString())
    .order("priority", { ascending: false })
    .order("scheduled_at", { ascending: true })
    .limit(limit);

  if (fallback.error) throw fallback.error;
  const rows = fallback.data || [];

  for (const row of rows) {
    await supabase
      .from("agent_run_jobs")
      .update({
        status: "running",
        worker_id: workerId,
        started_at: row.started_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "queued");
  }

  return rows;
}

function countTokens(text) {
  return Math.max(1, Math.round(String(text || "").length / 4));
}

async function createCompletion(prompt, context) {
  if (!openaiApiKey) {
    return `Processed request: ${prompt}\n\nContext sources: ${context.length}.`;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: runModel,
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: "You are an enterprise AI agent runtime. Reply with concise, actionable output grounded in provided context.",
        },
        {
          role: "user",
          content: [
            `Prompt: ${prompt}`,
            context.length > 0 ? `Context:\n${context.join("\n\n")}` : "Context: none",
          ].join("\n\n"),
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI completion failed (${response.status}): ${text}`);
  }

  const payload = await response.json();
  return String(payload?.choices?.[0]?.message?.content ?? "").trim() || "Completed with no textual output.";
}

async function runAgentRuntimeJobs() {
  const jobs = await claimAgentRunJobs(3);
  if (!jobs || jobs.length === 0) return;

  for (const job of jobs) {
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();

    try {
      const [{ data: run, error: runError }, { data: agent, error: agentError }] = await Promise.all([
        supabase
          .from("agent_runs")
          .select("id, tenant_id, reservation_id, input, status")
          .eq("id", job.run_id)
          .maybeSingle(),
        supabase
          .from("ai_agents")
          .select("id, tenant_id, name, config, source_connection_id")
          .eq("id", job.agent_id)
          .maybeSingle(),
      ]);

      if (runError) throw runError;
      if (agentError) throw agentError;
      if (!run) throw new Error("Agent run not found");
      if (!agent) throw new Error("Agent not found");

      await supabase
        .from("agent_runs")
        .update({
          status: "running",
          started_at: startedAt,
          error: null,
        })
        .eq("id", run.id);

      await supabase.rpc("complete_agent_run_step", {
        p_run_id: run.id,
        p_step_type: "planner",
        p_status: "running",
        p_data: {
          stage: "planning",
        },
      });

      const input = run.input || {};
      const prompt = String(input.prompt || input.message || input.query || "Run agent task").trim();
      const ragEnabled = Boolean(agent.config?.rag_enabled ?? true);
      const connectionId = String(input.connectionId || agent.source_connection_id || "").trim();
      const contextChunks = [];
      let sqlRows = [];

      if (ragEnabled && prompt) {
        const { data: docs, error: docsError } = await supabase.rpc("search_knowledge_documents_hybrid", {
          p_query: prompt,
          p_limit: 5,
        });
        if (!docsError) {
          contextChunks.push(
            ...(docs || []).map((row) => String(row?.excerpt || row?.title || "").trim()).filter(Boolean),
          );
        }

        await supabase.rpc("complete_agent_run_step", {
          p_run_id: run.id,
          p_step_type: "memory_retrieval",
          p_status: "success",
          p_data: {
            source_count: contextChunks.length,
          },
          p_cost_credits: 1,
        });
      }

      if (String(input.sql || "").trim() && connectionId) {
        const sql = String(input.sql).trim();
        const { data: sqlResult, error: sqlError } = await supabase.rpc("execute_tenant_sql_governed", {
          p_connection_id: connectionId,
          p_sql: sql,
          p_limit: 200,
          p_resource: "agent_runtime",
          p_action: "database_query",
        });
        if (sqlError) throw sqlError;
        sqlRows = sqlResult || [];

        await supabase.rpc("record_tool_execution", {
          p_run_id: run.id,
          p_tool_name: "database_query",
          p_status: "success",
          p_tool_input: { sql, connectionId },
          p_tool_output: { result: sqlRows },
          p_latency_ms: 0,
          p_error: null,
          p_risk_level: "medium",
          p_agent_id: agent.id,
          p_session_id: null,
          p_cost_credits: 1,
        });
      }

      const completion = await createCompletion(prompt, contextChunks);
      const inputTokens = countTokens(prompt);
      const outputTokens = countTokens(completion);
      const actualCredits = Math.max(1, Math.round((inputTokens + outputTokens) / 40) + (sqlRows.length > 0 ? 2 : 0));

      await supabase.rpc("complete_agent_run_step", {
        p_run_id: run.id,
        p_step_type: "llm_call",
        p_status: "success",
        p_data: {
          model: runModel,
          completion_preview: completion.slice(0, 280),
        },
        p_cost_credits: actualCredits,
      });

      await supabase
        .from("agent_runs")
        .update({
          status: "success",
          output: {
            message: completion,
            contextSources: contextChunks.length,
            sqlRows: sqlRows.length,
          },
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_cost_credits: actualCredits,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", run.id);

      await supabase
        .from("agent_run_jobs")
        .update({
          status: "success",
          result: {
            durationMs: Math.max(1, Date.now() - startedAtMs),
            model: runModel,
            actualCredits,
          },
          finished_at: new Date().toISOString(),
          worker_id: workerId,
          updated_at: new Date().toISOString(),
          last_error: null,
        })
        .eq("id", job.id);

      await supabase.from("usage_meter_events").insert([
        {
          tenant_id: run.tenant_id,
          run_id: run.id,
          event_type: "llm_input",
          quantity: inputTokens,
          unit: "tokens",
          cost_credits: Math.max(1, Math.round(inputTokens / 80)),
          details: { model: runModel },
        },
        {
          tenant_id: run.tenant_id,
          run_id: run.id,
          event_type: "llm_output",
          quantity: outputTokens,
          unit: "tokens",
          cost_credits: Math.max(1, Math.round(outputTokens / 60)),
          details: { model: runModel },
        },
      ]);

      if (run.reservation_id) {
        await supabase.rpc("finalize_credits", {
          p_reservation_id: run.reservation_id,
          p_actual_credits: actualCredits,
          p_status: "success",
          p_run_id: run.id,
        });
      }
    } catch (errorCaught) {
      const nextAttempt = Number(job.attempt_count || 0) + 1;
      const maxAttempts = Number(job.max_attempts || 5);
      const shouldRetry = nextAttempt < maxAttempts;
      const retryAt = shouldRetry
        ? new Date(Date.now() + retryDelaySeconds(nextAttempt) * 1000).toISOString()
        : null;
      const errorMessage = errorCaught instanceof Error ? errorCaught.message : "Agent runtime failed";

      await supabase
        .from("agent_run_jobs")
        .update({
          status: shouldRetry ? "queued" : "dead_letter",
          attempt_count: nextAttempt,
          scheduled_at: retryAt,
          started_at: shouldRetry ? null : startedAt,
          finished_at: shouldRetry ? null : new Date().toISOString(),
          worker_id: workerId,
          last_error: errorMessage,
          result: {
            failed: true,
            retriable: shouldRetry,
            durationMs: Math.max(1, Date.now() - startedAtMs),
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      const [{ data: run }] = await Promise.all([
        supabase
          .from("agent_runs")
          .select("id, tenant_id, reservation_id")
          .eq("id", job.run_id)
          .maybeSingle(),
      ]);

      if (run) {
        await supabase.rpc("complete_agent_run_step", {
          p_run_id: run.id,
          p_step_type: "error",
          p_status: "error",
          p_data: {
            error: errorMessage,
            retriable: shouldRetry,
          },
        });

        await supabase
          .from("agent_runs")
          .update({
            status: shouldRetry ? "queued" : "dead_letter",
            error: errorMessage,
            completed_at: shouldRetry ? null : new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", run.id);

        if (!shouldRetry && run.reservation_id) {
          await supabase.rpc("finalize_credits", {
            p_reservation_id: run.reservation_id,
            p_actual_credits: 0,
            p_status: "failed",
            p_run_id: run.id,
          });
        }
      }
    }
  }
}

async function runWebhookDeliveries() {
  const { data: deliveries, error } = await supabase
    .from("webhook_deliveries")
    .select("id, target_url, payload, headers, attempt_count, max_attempts")
    .eq("status", "queued")
    .lte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(3);

  if (error) throw error;
  if (!deliveries || deliveries.length === 0) return;

  for (const delivery of deliveries) {
    await supabase
      .from("webhook_deliveries")
      .update({
        status: "running",
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", delivery.id)
      .eq("status", "queued");

    try {
      const payloadText = JSON.stringify(delivery.payload || {});
      const signature = webhookSigningSecret
        ? crypto.createHmac("sha256", webhookSigningSecret).update(payloadText).digest("hex")
        : null;

      const response = await fetch(delivery.target_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(delivery.headers || {}),
          ...(signature ? { "x-opsai-signature": signature } : {}),
        },
        body: payloadText,
      });

      const bodyText = await response.text();
      await callbackWebhookDelivery({
        deliveryId: delivery.id,
        workerId,
        status: response.ok ? "success" : "error",
        responseStatus: response.status,
        responseBody: bodyText.slice(0, 4000),
        error: response.ok ? null : `Webhook response not ok (${response.status})`,
      });
    } catch (errorCaught) {
      await callbackWebhookDelivery({
        deliveryId: delivery.id,
        workerId,
        status: "error",
        error: errorCaught instanceof Error ? errorCaught.message : "Webhook delivery failed",
      });
    }
  }
}

async function maybeRefreshCredentials() {
  const now = Date.now();
  if (now - lastCredentialRefreshAt < credentialRefreshIntervalMs) return;
  lastCredentialRefreshAt = now;

  const response = await fetch(`${supabaseUrl}/functions/v1/credential-refresh-dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-worker-token": workerToken,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      limit: 40,
      thresholdMinutes: 20,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("credential-refresh-dispatch failed", response.status, text);
    return;
  }

  const payload = await response.json().catch(() => null);
  if (payload?.ok) {
    console.log("credential refresh", payload);
  }
}

async function runWorkerStep(stepName, fn) {
  try {
    await fn();
  } catch (error) {
    console.error(`Worker step error (${stepName})`, error);
  }
}

async function mainLoop() {
  const nodeMajor = nodeMajorVersion();
  if (nodeMajor > 0 && nodeMajor < 20) {
    console.warn(
      `Worker runtime warning: Node.js ${nodeMajor} detected. Upgrade to Node.js 20+ to avoid SDK/runtime instability.`,
    );
  }

  if (workerFailFastOnConnectivity) {
    try {
      await validateWorkerConnectivity();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        "Worker startup connectivity check failed. Verify SUPABASE_URL DNS/network, then restart worker.",
        { reason, supabaseUrl },
      );
      process.exit(1);
    }
  }

  console.log(
    `OpsAI worker started (id=${workerId}, poll=${pollIntervalMs}ms, staleRecovery=${staleRecoveryMinutes}m, syncDispatch=${syncDispatchIntervalMs}ms, callbackTimeout=${connectorCallbackTimeoutMs}ms, callbackAttempts=${connectorProgressCallbackMaxAttempts}/${connectorCallbackMaxAttempts})`,
  );
  while (true) {
    await runWorkerStep("recover_stale_jobs", recoverStaleJobs);
    await runWorkerStep("enqueue_due_connector_sync_jobs", maybeEnqueueDueConnectorSyncs);
    await runWorkerStep("credential_refresh", maybeRefreshCredentials);
    await runWorkerStep("connector_jobs", runConnectorJobs);
    await runWorkerStep("embedding_jobs", runEmbeddingJobs);
    await runWorkerStep("agent_runtime_jobs", runAgentRuntimeJobs);
    await runWorkerStep("webhook_deliveries", runWebhookDeliveries);
    await runWorkerStep("heartbeat", emitWorkerHeartbeat);
    await sleep(pollIntervalMs);
  }
}

void mainLoop();
