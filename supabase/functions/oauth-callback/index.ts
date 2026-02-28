import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { encryptJson, verifyState } from "../_shared/crypto.ts";
import { getServiceClient } from "../_shared/service.ts";
import { bootstrapTenantIntegrationRuntime } from "../_shared/integration-runtime.ts";

type Provider = "google" | "slack" | "notion" | "zoho";

function resolveIntegrationCode(state: Record<string, unknown>, provider: Provider, scope: string | null): string {
  const explicit = String(state.integrationCode ?? "").trim().toLowerCase();
  if (explicit) return explicit;

  if (provider === "slack") return "slack";
  if (provider === "notion") return "notion";
  if (provider === "zoho") return "zoho_crm";
  if (provider === "google") {
    const scopeText = String(scope ?? "").toLowerCase();
    if (scopeText.includes("gmail")) return "gmail";
    if (scopeText.includes("drive")) return "google_drive";
    return "gmail";
  }
  return provider;
}

function env(name: string, fallback?: string) {
  const value = Deno.env.get(name) ?? fallback ?? "";
  if (!value.trim()) throw new Error(`${name} is not configured`);
  return value.trim();
}

function normalizeProvider(value: unknown): Provider {
  const provider = String(value ?? "").trim().toLowerCase();
  if (provider === "google" || provider === "slack" || provider === "notion" || provider === "zoho") {
    return provider;
  }
  throw new Error("Unsupported provider");
}

async function exchangeCode(provider: Provider, code: string, redirectUri: string) {
  if (provider === "google") {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env("GOOGLE_OAUTH_CLIENT_ID"),
        client_secret: env("GOOGLE_OAUTH_CLIENT_SECRET"),
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(`Google token exchange failed: ${JSON.stringify(payload)}`);
    return {
      accessToken: String(payload.access_token ?? ""),
      refreshToken: payload.refresh_token ? String(payload.refresh_token) : null,
      expiresIn: Number(payload.expires_in ?? 0),
      scope: payload.scope ? String(payload.scope) : null,
      raw: payload,
    };
  }

  if (provider === "slack") {
    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env("SLACK_OAUTH_CLIENT_ID"),
        client_secret: env("SLACK_OAUTH_CLIENT_SECRET"),
        code,
        redirect_uri: redirectUri,
      }),
    });

    const payload = await response.json();
    if (!response.ok || payload?.ok === false) throw new Error(`Slack token exchange failed: ${JSON.stringify(payload)}`);

    const accessToken = String(payload.access_token ?? payload?.authed_user?.access_token ?? "");
    return {
      accessToken,
      refreshToken: payload.refresh_token ? String(payload.refresh_token) : null,
      expiresIn: Number(payload.expires_in ?? 0),
      scope: payload.scope ? String(payload.scope) : null,
      raw: payload,
    };
  }

  if (provider === "notion") {
    const clientId = env("NOTION_OAUTH_CLIENT_ID");
    const clientSecret = env("NOTION_OAUTH_CLIENT_SECRET");
    const auth = btoa(`${clientId}:${clientSecret}`);

    const response = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(`Notion token exchange failed: ${JSON.stringify(payload)}`);

    return {
      accessToken: String(payload.access_token ?? ""),
      refreshToken: payload.refresh_token ? String(payload.refresh_token) : null,
      expiresIn: Number(payload.expires_in ?? 0),
      scope: payload.workspace_name ? String(payload.workspace_name) : null,
      raw: payload,
    };
  }

  const response = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("ZOHO_OAUTH_CLIENT_ID"),
      client_secret: env("ZOHO_OAUTH_CLIENT_SECRET"),
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  const payload = await response.json();
  if (!response.ok || payload?.error) throw new Error(`Zoho token exchange failed: ${JSON.stringify(payload)}`);

  return {
    accessToken: String(payload.access_token ?? ""),
    refreshToken: payload.refresh_token ? String(payload.refresh_token) : null,
    expiresIn: Number(payload.expires_in ?? 0),
    scope: payload.scope ? String(payload.scope) : null,
    raw: payload,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return errorResponse(405, "Method not allowed");

  const service = getServiceClient();
  if (!service.ok) return service.response;

  const url = new URL(req.url);
  const code = String(url.searchParams.get("code") ?? "").trim();
  const stateToken = String(url.searchParams.get("state") ?? "").trim();

  if (!code || !stateToken) return errorResponse(400, "Missing code or state");

  let state: Record<string, unknown>;
  try {
    state = await verifyState(stateToken);
  } catch (error) {
    return errorResponse(400, "Invalid OAuth state", error instanceof Error ? error.message : null);
  }

  let provider: Provider;
  try {
    provider = normalizeProvider(state.provider);
  } catch (error) {
    return errorResponse(400, "Invalid provider in OAuth state", error instanceof Error ? error.message : null);
  }

  const tenantId = String(state.tenantId ?? "").trim();
  const userId = String(state.userId ?? "").trim() || null;
  const label = String(state.label ?? "default").trim() || "default";

  if (!tenantId) return errorResponse(400, "Missing tenant in OAuth state");

  try {
    const supabaseUrl = env("SUPABASE_URL");
    const redirectUriByProvider: Record<Provider, string> = {
      google: env("GOOGLE_OAUTH_REDIRECT_URI", `${supabaseUrl}/functions/v1/oauth-callback`),
      slack: env("SLACK_OAUTH_REDIRECT_URI", `${supabaseUrl}/functions/v1/oauth-callback`),
      notion: env("NOTION_OAUTH_REDIRECT_URI", `${supabaseUrl}/functions/v1/oauth-callback`),
      zoho: env("ZOHO_OAUTH_REDIRECT_URI", `${supabaseUrl}/functions/v1/oauth-callback`),
    };

    const token = await exchangeCode(provider, code, redirectUriByProvider[provider]);
    if (!token.accessToken) throw new Error("Provider did not return an access token");

    const expiresAt = token.expiresIn > 0
      ? new Date(Date.now() + token.expiresIn * 1000).toISOString()
      : null;

    const encrypted = await encryptJson({
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      expires_in: token.expiresIn,
      scope: token.scope,
      provider,
      obtained_at: new Date().toISOString(),
      raw: token.raw,
    });

    const { data: credential, error: credentialError } = await service.supabase
      .from("integration_credentials")
      .upsert({
        tenant_id: tenantId,
        service: provider,
        label,
        credential_ref: `${provider}:${label}`,
        algorithm: encrypted.algorithm,
        key_version: encrypted.keyVersion,
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        auth_tag: encrypted.authTag,
        status: "active",
        expires_at: expiresAt,
        metadata: {
          scope: token.scope,
          last_refreshed_at: new Date().toISOString(),
        },
        created_by: userId,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "tenant_id,service,label",
      })
      .select("id")
      .single();

    if (credentialError) return errorResponse(400, "Could not persist encrypted credential", credentialError.message);

    await service.supabase.from("credential_rotations").insert({
      tenant_id: tenantId,
      credential_id: credential.id,
      rotation_type: "refresh",
      status: "success",
      expires_at: expiresAt,
      details: {
        provider,
        label,
        source: "oauth_callback",
      },
      rotated_by: userId,
    });

    const integrationCode = resolveIntegrationCode(state, provider, token.scope);
    const runtimeProvisioning = await bootstrapTenantIntegrationRuntime({
      supabase: service.supabase,
      tenantId,
      userId,
      integrationCode,
      credentialId: credential.id,
    });

    const successRedirect = Deno.env.get("OAUTH_SUCCESS_REDIRECT");
    if (successRedirect) {
      const redirect = new URL(successRedirect);
      redirect.searchParams.set("provider", provider);
      redirect.searchParams.set("status", "connected");
      redirect.searchParams.set("integration", integrationCode);
      return Response.redirect(redirect.toString(), 302);
    }

    return jsonResponse(200, {
      ok: true,
      provider,
      integrationCode,
      tenantId,
      credentialId: credential.id,
      expiresAt,
      runtimeProvisioning,
    });
  } catch (error) {
    return errorResponse(500, "OAuth callback processing failed", error instanceof Error ? error.message : null);
  }
});
