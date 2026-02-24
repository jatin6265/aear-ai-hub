import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function pickFirstString(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = asString(payload[key]);
    if (value) return value;
  }
  return "";
}

function parseJsonString(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseCustomHeaders(payload: Record<string, unknown>) {
  const raw = parseJsonString(payload.custom_headers ?? payload.customHeaders);
  if (!raw) return {} as Record<string, string>;

  if (Array.isArray(raw)) {
    return raw.reduce<Record<string, string>>((acc, row) => {
      if (!row || typeof row !== "object") return acc;
      const key = asString((row as Record<string, unknown>).key);
      const value = asString((row as Record<string, unknown>).value);
      if (key && value) acc[key] = value;
      return acc;
    }, {});
  }

  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, value]) => {
      const cleanKey = asString(key);
      const cleanValue = asString(value);
      if (cleanKey && cleanValue) acc[cleanKey] = cleanValue;
      return acc;
    }, {});
  }

  return {} as Record<string, string>;
}

function buildAuthHeaders(payload: Record<string, unknown>) {
  const authType = asString(payload.authType ?? payload.auth_type ?? "none").toLowerCase();
  const headers: Record<string, string> = {
    Accept: "application/json,text/plain,*/*",
    ...parseCustomHeaders(payload),
  };

  if (authType === "api_key") {
    const headerName = asString(payload.api_key_header ?? payload.apiKeyHeader) || "x-api-key";
    const apiKey = pickFirstString(payload, ["api_key", "apiKey"]);
    if (apiKey) headers[headerName] = apiKey;
  } else if (authType === "bearer_token") {
    const token = pickFirstString(payload, ["bearer_token", "bearerToken"]);
    if (token) headers.Authorization = `Bearer ${token}`;
  } else if (authType === "basic_auth") {
    const username = pickFirstString(payload, ["basic_username", "username"]);
    const password = pickFirstString(payload, ["basic_password", "password"]);
    if (username || password) {
      headers.Authorization = `Basic ${btoa(`${username}:${password}`)}`;
    }
  }

  return headers;
}

async function fetchProbe(url: string, init?: RequestInit) {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json,text/plain,*/*", ...(init?.headers ?? {}) },
    });
    const latencyMs = Math.max(1, Math.round(performance.now() - started));
    return {
      success: response.status < 500,
      latencyMs,
      message: response.status < 500 ? `Endpoint reachable (${response.status})` : `Endpoint returned ${response.status}`,
      status: response.status,
    };
  } catch (error) {
    return {
      success: false,
      latencyMs: Math.max(1, Math.round(performance.now() - started)),
      message: error instanceof Error ? error.message : "Network probe failed",
      status: 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeFirebaseBaseUrl(payload: Record<string, unknown>) {
  const raw = pickFirstString(payload, ["database_url", "databaseUrl", "base_url", "baseUrl", "url"]);
  if (!raw) return "";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function parseSpreadsheetId(spreadsheetUrl: string) {
  const pattern = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;
  const match = spreadsheetUrl.match(pattern);
  return match?.[1] ?? "";
}

async function tcpProbe(host: string, port: number) {
  const started = performance.now();
  let conn: Deno.Conn | null = null;
  try {
    conn = await Promise.race([
      Deno.connect({
        hostname: host,
        port,
        transport: "tcp",
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out while opening TCP connection")), 4000),
      ),
    ]);

    return {
      success: true,
      latencyMs: Math.max(1, Math.round(performance.now() - started)),
      message: `TCP connectivity established to ${host}:${port}`,
    };
  } catch (error) {
    return {
      success: false,
      latencyMs: Math.max(1, Math.round(performance.now() - started)),
      message: error instanceof Error ? error.message : `Could not connect to ${host}:${port}`,
    };
  } finally {
    conn?.close();
  }
}

function parseBoolean(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on", "require", "required"].includes(normalized)) return true;
    if (["false", "0", "no", "off", "disable", "disabled"].includes(normalized)) return false;
  }
  return fallback;
}

function parsePostgresSslConfig(payload: Record<string, unknown>) {
  const sslMode = asString(payload.ssl_mode ?? payload.sslMode).toLowerCase();
  if (sslMode === "disable") return false;
  if (sslMode === "verify-full") return { rejectUnauthorized: true };
  if (sslMode === "require" || sslMode === "prefer") return { rejectUnauthorized: false };
  return parseBoolean(payload.ssl, false) ? { rejectUnauthorized: false } : false;
}

function parseMySqlSslConfig(payload: Record<string, unknown>) {
  const sslMode = asString(payload.ssl_mode ?? payload.sslMode).toLowerCase();
  if (sslMode === "disable") return undefined;
  if (sslMode === "verify-full") return { rejectUnauthorized: true };
  if (sslMode === "require" || sslMode === "preferred") return { rejectUnauthorized: false };
  return parseBoolean(payload.ssl, false) ? { rejectUnauthorized: false } : undefined;
}

async function testPostgresConnection(payload: Record<string, unknown>) {
  const started = performance.now();
  const connectionString = pickFirstString(payload, ["connection_string", "connectionString", "base_url", "baseUrl", "url"]);
  const host = pickFirstString(payload, ["host"]);
  const port = Number(payload.port ?? 5432);
  const database = pickFirstString(payload, ["database"]);
  const username = pickFirstString(payload, ["username", "user"]);
  const password = pickFirstString(payload, ["password"]);

  const { Client } = await import("npm:pg@8.13.1");

  const clientConfig: Record<string, unknown> = {
    connectionTimeoutMillis: 8000,
    statement_timeout: 12000,
    ssl: parsePostgresSslConfig(payload),
  };

  if (connectionString) {
    clientConfig.connectionString = connectionString;
  } else {
    if (!host || !database || !username || !password) {
      throw new Error("PostgreSQL test requires host, database, username, and password");
    }
    clientConfig.host = host;
    clientConfig.port = Number.isFinite(port) ? port : 5432;
    clientConfig.database = database;
    clientConfig.user = username;
    clientConfig.password = password;
  }

  const client = new Client(clientConfig);
  await client.connect();
  try {
    const [dbInfo, tablesInfo] = await Promise.all([
      client.query("SELECT current_database() AS database_name, current_schema() AS schema_name"),
      client.query(`
        SELECT COUNT(*)::int AS table_count
        FROM information_schema.tables
        WHERE table_type = 'BASE TABLE'
          AND table_schema NOT IN ('pg_catalog', 'information_schema')
      `),
    ]);
    const latencyMs = Math.max(1, Math.round(performance.now() - started));
    const tableCount = Number(tablesInfo.rows?.[0]?.table_count ?? 0);
    const databaseName = String(dbInfo.rows?.[0]?.database_name ?? database ?? "unknown");
    return {
      success: true,
      latencyMs,
      message: `PostgreSQL authenticated. Found ${tableCount} tables in ${databaseName}.`,
      details: { tableCount, databaseName },
    };
  } finally {
    await client.end();
  }
}

async function testMySqlConnection(payload: Record<string, unknown>) {
  const started = performance.now();
  const connectionString = pickFirstString(payload, ["connection_string", "connectionString", "base_url", "baseUrl", "url"]);
  const host = pickFirstString(payload, ["host"]);
  const port = Number(payload.port ?? 3306);
  const database = pickFirstString(payload, ["database"]);
  const username = pickFirstString(payload, ["username", "user"]);
  const password = pickFirstString(payload, ["password"]);

  const mysql = await import("npm:mysql2@3.11.4/promise");
  let conn: Awaited<ReturnType<typeof mysql.createConnection>> | null = null;

  try {
    if (connectionString) {
      conn = await mysql.createConnection(connectionString);
    } else {
      if (!host || !database || !username || !password) {
        throw new Error("MySQL test requires host, database, username, and password");
      }
      conn = await mysql.createConnection({
        host,
        port: Number.isFinite(port) ? port : 3306,
        user: username,
        password,
        database,
        ssl: parseMySqlSslConfig(payload),
        connectTimeout: 8000,
      });
    }

    const [dbRows] = await conn.query("SELECT DATABASE() AS database_name");
    const connectedDb = String((dbRows as Array<Record<string, unknown>>)?.[0]?.database_name ?? database ?? "");
    if (!connectedDb) throw new Error("MySQL connection succeeded but no database was selected");

    const [tableRows] = await conn.query(
      `
      SELECT COUNT(*) AS table_count
      FROM information_schema.tables
      WHERE table_schema = ?
        AND table_type = 'BASE TABLE'
      `,
      [connectedDb],
    );
    const tableCount = Number((tableRows as Array<Record<string, unknown>>)?.[0]?.table_count ?? 0);
    const latencyMs = Math.max(1, Math.round(performance.now() - started));
    return {
      success: true,
      latencyMs,
      message: `MySQL authenticated. Found ${tableCount} tables in ${connectedDb}.`,
      details: { tableCount, databaseName: connectedDb },
    };
  } finally {
    await conn?.end();
  }
}

function parseMongoDatabaseFromConnectionString(connectionString: string) {
  try {
    const parsed = new URL(connectionString);
    return parsed.pathname.replace(/^\/+/, "").split("?")[0] || "";
  } catch {
    return "";
  }
}

async function testMongoConnection(payload: Record<string, unknown>) {
  const started = performance.now();
  const connectionString = pickFirstString(payload, ["connectionString", "connection_string", "baseUrl", "base_url", "url"]);
  if (!connectionString) throw new Error("MongoDB test requires connection string");

  const configuredDb = pickFirstString(payload, ["database"]);
  const derivedDb = configuredDb || parseMongoDatabaseFromConnectionString(connectionString);
  const { MongoClient } = await import("npm:mongodb@6.8.0");
  const client = new MongoClient(connectionString, {
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 2,
  });

  await client.connect();
  try {
    const db = derivedDb ? client.db(derivedDb) : client.db();
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    const latencyMs = Math.max(1, Math.round(performance.now() - started));
    return {
      success: true,
      latencyMs,
      message: `MongoDB authenticated. Found ${collections.length} collections in ${db.databaseName}.`,
      details: { collectionCount: collections.length, databaseName: db.databaseName },
    };
  } finally {
    await client.close();
  }
}

function parseHostPort(payload: Record<string, unknown>, defaults: { port: number }) {
  const explicitHost = asString(payload.host);
  const explicitPort = Number(payload.port ?? defaults.port);
  if (explicitHost) {
    return { host: explicitHost, port: Number.isFinite(explicitPort) ? explicitPort : defaults.port };
  }

  const base = pickFirstString(payload, [
    "baseUrl",
    "base_url",
    "connectionString",
    "connection_string",
    "url",
  ]);
  if (!base) return null;

  if (base.includes("://")) {
    try {
      const parsed = new URL(base);
      return {
        host: parsed.hostname,
        port: Number(parsed.port || defaults.port),
      };
    } catch {
      // continue to host:port parser below.
    }
  }

  const hostPort = base.split("/")[0];
  const [host, portRaw] = hostPort.split(":");
  if (!host) return null;
  const port = Number(portRaw || defaults.port);
  return {
    host,
    port: Number.isFinite(port) ? port : defaults.port,
  };
}

function normalizeConnectionType(raw: string) {
  const value = raw.trim().toLowerCase();
  if (value === "rest" || value === "rest_api" || value === "rest_openapi") return "rest_openapi";
  if (value === "custom_rest_api") return "custom_rest";
  if (value === "sheets") return "google_sheets";
  return value;
}

function normalizeDatabaseTestFailure(
  connectionType: "postgresql" | "mysql" | "mongodb",
  rawMessage: string,
  tcpMessage: string | null,
) {
  const message = asString(rawMessage) || "Connection handshake failed";
  const lower = message.toLowerCase();

  if (connectionType === "mongodb") {
    if (lower.includes("bad auth") || lower.includes("authentication failed")) {
      return "MongoDB authentication failed. Verify username/password and authSource.";
    }
    if (lower.includes("querysrv") || lower.includes("enotfound") || lower.includes("dns")) {
      return "MongoDB SRV host could not be resolved. Verify your Atlas cluster host and DNS/network access.";
    }
    if (lower.includes("not authorized") || lower.includes("ip") && lower.includes("allow")) {
      return "MongoDB access blocked by network policy. Add Supabase egress IPs to Atlas allowlist.";
    }
    if (lower.includes("timed out") || lower.includes("server selection")) {
      return "MongoDB server selection timed out. Check network allowlist, TLS requirements, and cluster reachability.";
    }
  }

  if (connectionType === "postgresql" || connectionType === "mysql") {
    if (lower.includes("authentication") || lower.includes("password")) {
      return `${connectionType === "postgresql" ? "PostgreSQL" : "MySQL"} authentication failed. Verify username/password.`;
    }
    if (lower.includes("database") && lower.includes("does not exist")) {
      return `${connectionType === "postgresql" ? "PostgreSQL" : "MySQL"} database not found. Verify database name.`;
    }
    if (lower.includes("timed out") || lower.includes("timeout")) {
      return `${connectionType === "postgresql" ? "PostgreSQL" : "MySQL"} connection timed out. Verify host, port, and firewall allowlist.`;
    }
    if (lower.includes("ssl")) {
      return `${connectionType === "postgresql" ? "PostgreSQL" : "MySQL"} SSL/TLS handshake failed. Verify SSL mode and certificates.`;
    }
  }

  if (tcpMessage && asString(tcpMessage)) {
    return `${message}. Network probe: ${asString(tcpMessage)}`;
  }

  return message;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let connectionType = "";
  let payload: Record<string, unknown> = {};

  try {
    const body = await req.json();
    connectionType = String(body?.connectionType ?? "").trim().toLowerCase();
    payload = body?.payload && typeof body.payload === "object" ? body.payload : {};
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!connectionType) {
    return errorResponse(400, "connectionType is required");
  }
  connectionType = normalizeConnectionType(connectionType);

  if (connectionType === "rest_openapi" || connectionType === "custom_rest") {
    const baseUrl = pickFirstString(payload, ["baseUrl", "base_url", "url"]);
    const specUrl = pickFirstString(payload, ["swaggerUrl", "swagger_url", "openapi_url", "openapiUrl"]);
    const probeUrl = specUrl || baseUrl;
    if (!probeUrl) return errorResponse(400, "REST test requires baseUrl or openapi_url");

    const headers = buildAuthHeaders(payload);
    const result = await fetchProbe(probeUrl, { headers });
    let openApiPaths: number | null = null;

    if (result.success && specUrl) {
      try {
        const response = await fetch(specUrl, {
          method: "GET",
          headers,
        });
        if (response.ok) {
          const text = await response.text();
          const parsed = JSON.parse(text) as Record<string, unknown>;
          const paths = parsed?.paths && typeof parsed.paths === "object" ? Object.keys(parsed.paths).length : 0;
          openApiPaths = paths;
        }
      } catch {
        // Keep primary success result; schema parse is optional for test endpoint.
      }
    }

    return jsonResponse(200, {
      ok: result.success,
      success: result.success,
      latencyMs: result.latencyMs,
      message: result.success
        ? openApiPaths !== null
          ? `Connection verified. OpenAPI paths detected: ${openApiPaths}`
          : result.message
        : result.message,
      details: {
        probeUrl,
        statusCode: result.status,
        openApiPaths,
        authType: asString(payload.authType ?? payload.auth_type ?? "none").toLowerCase(),
      },
    });
  }

  if (connectionType === "notion") {
    const token = pickFirstString(payload, ["integrationToken", "integration_token", "apiKey", "api_key"]);
    if (!token) return errorResponse(400, "Notion test requires integration token");
    const databaseId = pickFirstString(payload, ["databaseId", "database_id"]);

    const started = performance.now();
    const meResponse = await fetch("https://api.notion.com/v1/users/me", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
      },
    });
    const latencyMs = Math.max(1, Math.round(performance.now() - started));
    if (!meResponse.ok) {
      return jsonResponse(200, {
        ok: false,
        success: false,
        latencyMs,
        message: `Notion token validation failed (${meResponse.status})`,
      });
    }

    let dbStatus = "not_provided";
    if (databaseId) {
      const dbResponse = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
        },
      });
      dbStatus = dbResponse.ok ? "validated" : `invalid:${dbResponse.status}`;
    }

    return jsonResponse(200, {
      ok: dbStatus === "not_provided" || dbStatus === "validated",
      success: dbStatus === "not_provided" || dbStatus === "validated",
      latencyMs,
      message:
        dbStatus === "validated"
          ? "Notion token and database validated"
          : dbStatus === "not_provided"
            ? "Notion token validated"
            : `Notion database validation failed (${dbStatus})`,
    });
  }

  if (connectionType === "google_sheets") {
    const url = pickFirstString(payload, ["sheetUrl", "sheet_url", "url"]);
    if (!url) return errorResponse(400, "Google Sheets test requires sheet URL");
    const spreadsheetId = parseSpreadsheetId(url);
    if (!spreadsheetId) return errorResponse(400, "Invalid Google Sheets URL");

    const rawServiceJson = payload.service_account_json ?? payload.serviceAccountJson;
    const serviceAccountJson = parseJsonString(rawServiceJson);
    const serviceJsonValid =
      serviceAccountJson &&
      typeof serviceAccountJson === "object" &&
      !!asString((serviceAccountJson as Record<string, unknown>).client_email) &&
      !!asString((serviceAccountJson as Record<string, unknown>).private_key);

    const result = await fetchProbe(url);
    return jsonResponse(200, {
      ok: result.success,
      success: result.success,
      latencyMs: result.latencyMs,
      message: result.success
        ? serviceJsonValid
          ? "Spreadsheet reachable; service account payload is structurally valid"
          : "Spreadsheet reachable; provide service account JSON for background sync"
        : result.message,
      details: {
        spreadsheetId,
        serviceJsonValid,
      },
    });
  }

  if (connectionType === "firebase") {
    const baseUrl = normalizeFirebaseBaseUrl(payload);
    if (!baseUrl) return errorResponse(400, "Firebase test requires database URL");

    const authToken = pickFirstString(payload, ["auth_token", "authToken", "api_key", "apiKey"]);
    const params = new URLSearchParams({ shallow: "true" });
    if (authToken) params.set("auth", authToken);
    const probeUrl = `${baseUrl}/.json?${params.toString()}`;
    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(probeUrl, {
        method: "GET",
        signal: controller.signal,
      });
      const latencyMs = Math.max(1, Math.round(performance.now() - started));

      if (!response.ok) {
        const reason =
          response.status === 401 || response.status === 403
            ? "Firebase auth was rejected. Verify database auth token/rules."
            : `Firebase endpoint returned ${response.status}. Verify database URL and network access.`;
        return jsonResponse(200, {
          ok: false,
          success: false,
          latencyMs,
          message: reason,
          details: {
            statusCode: response.status,
            probeUrl: `${baseUrl}/.json?shallow=true`,
          },
        });
      }

      const payloadJson = await response.json();
      const validShape = payloadJson === null || typeof payloadJson === "object";
      if (!validShape) {
        return jsonResponse(200, {
          ok: false,
          success: false,
          latencyMs,
          message: "Firebase payload could not be introspected. Verify this is a Realtime Database URL.",
        });
      }

      const topLevelKeys =
        payloadJson && typeof payloadJson === "object" && !Array.isArray(payloadJson)
          ? Object.keys(payloadJson).length
          : 0;

      return jsonResponse(200, {
        ok: true,
        success: true,
        latencyMs,
        message: `Firebase connected. Top-level paths discovered: ${topLevelKeys}.`,
        details: {
          topLevelKeys,
          probeUrl: `${baseUrl}/.json?shallow=true`,
        },
      });
    } catch (error) {
      const latencyMs = Math.max(1, Math.round(performance.now() - started));
      return jsonResponse(200, {
        ok: false,
        success: false,
        latencyMs,
        message: error instanceof Error ? error.message : "Firebase test failed",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  if (connectionType === "postgresql" || connectionType === "mysql" || connectionType === "mongodb") {
    try {
      const result =
        connectionType === "postgresql"
          ? await testPostgresConnection(payload)
          : connectionType === "mysql"
            ? await testMySqlConnection(payload)
            : await testMongoConnection(payload);

      return jsonResponse(200, {
        ok: result.success,
        success: result.success,
        latencyMs: result.latencyMs,
        message: result.message,
        details: result.details,
      });
    } catch (error) {
      const defaults = {
        port: connectionType === "postgresql" ? 5432 : connectionType === "mysql" ? 3306 : 27017,
      };
      const target = parseHostPort(payload, defaults);
      const fallbackResult = target ? await tcpProbe(target.host, target.port) : null;
      const rawMessage = error instanceof Error ? error.message : "Connection handshake failed";
      const normalizedMessage = normalizeDatabaseTestFailure(connectionType, rawMessage, fallbackResult?.message ?? null);
      return jsonResponse(200, {
        ok: false,
        success: false,
        latencyMs: fallbackResult?.latencyMs ?? null,
        message: normalizedMessage,
        details: {
          host: target?.host ?? null,
          port: target?.port ?? null,
          tcpReachable: Boolean(fallbackResult?.success),
          tcpMessage: fallbackResult?.message ?? null,
        },
      });
    }
  }

  return errorResponse(400, `Unsupported connector type: ${connectionType}`);
});
