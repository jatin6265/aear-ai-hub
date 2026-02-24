import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

type Operation = "get_payload" | "create_key" | "revoke_key";
type Environment = "production" | "development" | "testing";
type ExpiryMode = "never" | "30_days" | "90_days" | "1_year" | "custom";

type RequestBody = {
  operation?: Operation;
  keyId?: string;
  name?: string;
  environment?: Environment;
  scopes?: string[];
  expiryMode?: ExpiryMode;
  customExpiryDate?: string;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeEnvironment(value: unknown): Environment {
  const normalized = clean(value).toLowerCase();
  if (normalized === "production" || normalized === "development" || normalized === "testing") {
    return normalized;
  }
  return "production";
}

function normalizeScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return ["read"];
  const allowed = new Set(["read", "write", "admin", "billing"]);
  const unique = new Set<string>();

  value.forEach((scope) => {
    const item = clean(scope).toLowerCase();
    if (allowed.has(item)) unique.add(item);
  });

  if (unique.size === 0) unique.add("read");
  return [...unique];
}

function normalizeExpiryMode(value: unknown): ExpiryMode {
  const normalized = clean(value).toLowerCase();
  if (
    normalized === "never" ||
    normalized === "30_days" ||
    normalized === "90_days" ||
    normalized === "1_year" ||
    normalized === "custom"
  ) {
    return normalized;
  }
  return "never";
}

function computeExpiry(mode: ExpiryMode, customDate: string): string | null {
  const now = new Date();
  if (mode === "never") return null;

  if (mode === "30_days") {
    now.setDate(now.getDate() + 30);
    return now.toISOString();
  }

  if (mode === "90_days") {
    now.setDate(now.getDate() + 90);
    return now.toISOString();
  }

  if (mode === "1_year") {
    now.setFullYear(now.getFullYear() + 1);
    return now.toISOString();
  }

  const trimmed = clean(customDate);
  if (!trimmed) {
    throw new Error("Custom expiry date is required");
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid custom expiry date");
  }

  // Set to end-of-day UTC for better UX.
  parsed.setUTCHours(23, 59, 59, 999);
  if (parsed.getTime() <= Date.now()) {
    throw new Error("Custom expiry date must be in the future");
  }

  return parsed.toISOString();
}

async function loadPayload(
  supabase: { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }> },
) {
  const { data, error } = await supabase.rpc("get_api_keys_management_payload");
  if (error) throw new Error(error.message || "Failed to load API key payload");
  return data;
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

  try {
    if (operation === "create_key") {
      const name = clean(body.name);
      if (!name) return errorResponse(400, "Key name is required");

      const environment = normalizeEnvironment(body.environment);
      const scopes = normalizeScopes(body.scopes);
      const expiryMode = normalizeExpiryMode(body.expiryMode);

      let expiresAt: string | null = null;
      try {
        expiresAt = computeExpiry(expiryMode, clean(body.customExpiryDate));
      } catch (error) {
        return errorResponse(400, error instanceof Error ? error.message : "Invalid expiry date");
      }

      const { data: createdRows, error: createError } = await auth.supabase.rpc("create_api_key_v2", {
        p_name: name,
        p_scopes: scopes,
        p_environment: environment,
        p_expires_at: expiresAt,
      });

      if (createError) return errorResponse(400, "Could not create API key", createError.message);

      const created = Array.isArray(createdRows) ? createdRows[0] : null;
      const payload = await loadPayload(auth.supabase);

      return jsonResponse(200, {
        ok: true,
        operation,
        payload,
        created: {
          keyId: created?.id ?? null,
          key: created?.plain_key ?? null,
          keyPrefix: created?.key_prefix ?? null,
          createdAt: created?.created_at ?? null,
          environment: created?.environment ?? environment,
          expiresAt: created?.expires_at ?? expiresAt,
          scopes: created?.scopes ?? scopes,
        },
      });
    }

    if (operation === "revoke_key") {
      const keyId = clean(body.keyId);
      if (!keyId) return errorResponse(400, "keyId is required");

      const { data, error } = await auth.supabase.rpc("revoke_api_key", {
        p_key_id: keyId,
      });

      if (error) return errorResponse(400, "Could not revoke API key", error.message);

      const payload = await loadPayload(auth.supabase);
      return jsonResponse(200, {
        ok: true,
        operation,
        revoked: Boolean(data),
        payload,
      });
    }

    if (operation !== "get_payload") {
      return errorResponse(400, "Unsupported operation");
    }

    const payload = await loadPayload(auth.supabase);
    return jsonResponse(200, {
      ok: true,
      operation,
      payload,
    });
  } catch (error) {
    return errorResponse(500, "Unexpected API keys management error", error instanceof Error ? error.message : null);
  }
});
