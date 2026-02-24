import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { decryptJson, encryptJson } from "../_shared/crypto.ts";
import { getServiceClient, requireWorkerToken } from "../_shared/service.ts";

type Provider = "google" | "slack" | "notion" | "zoho";

type TokenPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  provider?: string;
  raw?: unknown;
};

function env(name: string, fallback?: string) {
  const value = Deno.env.get(name) ?? fallback ?? "";
  if (!value.trim()) throw new Error(`${name} is not configured`);
  return value.trim();
}

function normalizeProvider(value: unknown): Provider {
  const provider = String(value ?? "").trim().toLowerCase();
  if (provider === "google" || provider === "slack" || provider === "notion" || provider === "zoho") return provider;
  throw new Error(`Unsupported provider: ${provider}`);
}

async function refreshToken(provider: Provider, refreshToken: string): Promise<TokenPayload> {
  if (provider === "google") {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env("GOOGLE_OAUTH_CLIENT_ID"),
        client_secret: env("GOOGLE_OAUTH_CLIENT_SECRET"),
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`Google refresh failed: ${JSON.stringify(payload)}`);
    return payload as TokenPayload;
  }

  if (provider === "slack") {
    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env("SLACK_OAUTH_CLIENT_ID"),
        client_secret: env("SLACK_OAUTH_CLIENT_SECRET"),
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    const payload = await response.json();
    if (!response.ok || payload?.ok === false) throw new Error(`Slack refresh failed: ${JSON.stringify(payload)}`);
    return payload as TokenPayload;
  }

  if (provider === "notion") {
    const clientId = env("NOTION_OAUTH_CLIENT_ID");
    const clientSecret = env("NOTION_OAUTH_CLIENT_SECRET");

    const response = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(`Notion refresh failed: ${JSON.stringify(payload)}`);
    return payload as TokenPayload;
  }

  const response = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("ZOHO_OAUTH_CLIENT_ID"),
      client_secret: env("ZOHO_OAUTH_CLIENT_SECRET"),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const payload = await response.json();
  if (!response.ok || payload?.error) throw new Error(`Zoho refresh failed: ${JSON.stringify(payload)}`);
  return payload as TokenPayload;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const workerAuth = requireWorkerToken(req);
  if (!workerAuth.ok) return workerAuth.response;

  const service = getServiceClient();
  if (!service.ok) return service.response;

  let limit = 50;
  let thresholdMinutes = 20;
  try {
    const body = (await req.json()) as { limit?: number; thresholdMinutes?: number };
    limit = Math.max(1, Math.min(200, Number(body?.limit ?? 50)));
    thresholdMinutes = Math.max(1, Math.min(24 * 60, Number(body?.thresholdMinutes ?? 20)));
  } catch {
    // keep defaults
  }

  const thresholdIso = new Date(Date.now() + thresholdMinutes * 60_000).toISOString();

  const { data: rows, error: listError } = await service.supabase
    .from("integration_credentials")
    .select("id, tenant_id, service, label, iv, ciphertext, expires_at")
    .eq("status", "active")
    .not("expires_at", "is", null)
    .lte("expires_at", thresholdIso)
    .order("expires_at", { ascending: true })
    .limit(limit);

  if (listError) return errorResponse(400, "Could not load expiring credentials", listError.message);

  let refreshed = 0;
  let failed = 0;

  for (const row of rows ?? []) {
    try {
      const decoded = (await decryptJson({ iv: row.iv, ciphertext: row.ciphertext })) as TokenPayload;
      const provider = normalizeProvider(decoded.provider ?? row.service);
      const refresh = String(decoded.refresh_token ?? "").trim();
      if (!refresh) throw new Error("Credential has no refresh_token");

      const token = await refreshToken(provider, refresh);
      const accessToken = String(token.access_token ?? "").trim();
      if (!accessToken) throw new Error("Provider refresh returned empty access token");

      const expiresIn = Number(token.expires_in ?? 0);
      const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : row.expires_at;

      const encrypted = await encryptJson({
        access_token: accessToken,
        refresh_token: String(token.refresh_token ?? refresh),
        expires_in: expiresIn,
        scope: token.scope ?? decoded.scope ?? null,
        provider,
        refreshed_at: new Date().toISOString(),
        raw: token,
      });

      const { error: updateError } = await service.supabase
        .from("integration_credentials")
        .update({
          algorithm: encrypted.algorithm,
          key_version: encrypted.keyVersion,
          iv: encrypted.iv,
          ciphertext: encrypted.ciphertext,
          auth_tag: encrypted.authTag,
          expires_at: expiresAt,
          updated_at: new Date().toISOString(),
          metadata: {
            last_refreshed_at: new Date().toISOString(),
            provider,
          },
        })
        .eq("id", row.id)
        .eq("tenant_id", row.tenant_id);

      if (updateError) throw new Error(updateError.message);

      await service.supabase.from("credential_rotations").insert({
        tenant_id: row.tenant_id,
        credential_id: row.id,
        rotation_type: "refresh",
        status: "success",
        expires_at: expiresAt,
        details: {
          provider,
          label: row.label,
          source: "credential_refresh_dispatch",
        },
      });

      refreshed += 1;
    } catch (error) {
      failed += 1;
      const errorMessage = error instanceof Error ? error.message : "Credential refresh failed";

      await service.supabase
        .from("integration_credentials")
        .update({
          status: "error",
          updated_at: new Date().toISOString(),
          metadata: {
            last_refresh_error: errorMessage,
            last_refresh_failed_at: new Date().toISOString(),
          },
        })
        .eq("id", row.id)
        .eq("tenant_id", row.tenant_id);

      await service.supabase.from("credential_rotations").insert({
        tenant_id: row.tenant_id,
        credential_id: row.id,
        rotation_type: "refresh",
        status: "error",
        error: errorMessage,
        details: {
          provider: row.service,
          label: row.label,
          source: "credential_refresh_dispatch",
        },
      });
    }
  }

  return jsonResponse(200, {
    ok: true,
    scanned: (rows ?? []).length,
    refreshed,
    failed,
    thresholdMinutes,
  });
});
