import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { signState } from "../_shared/crypto.ts";

type Provider = "google" | "gmail" | "slack" | "notion" | "zoho";

function toProvider(value: unknown): Provider {
  const provider = String(value ?? "").trim().toLowerCase();
  if (provider === "gmail") return "gmail";
  if (provider === "google") return "google";
  if (provider === "slack") return "slack";
  if (provider === "notion") return "notion";
  if (provider === "zoho") return "zoho";
  throw new Error("Unsupported provider");
}

function env(name: string, fallback?: string) {
  const value = Deno.env.get(name) ?? fallback ?? "";
  if (!value.trim()) throw new Error(`${name} is not configured`);
  return value.trim();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let provider: Provider;
  let label = "default";
  let integrationCode = "";
  try {
    const body = (await req.json()) as { provider?: string; label?: string; integrationCode?: string };
    provider = toProvider(body?.provider);
    label = String(body?.label ?? "default").trim() || "default";
    integrationCode = String(body?.integrationCode ?? "").trim().toLowerCase();
  } catch (error) {
    return errorResponse(400, "Invalid OAuth start payload", error instanceof Error ? error.message : null);
  }

  const { data: tenantId, error: tenantError } = await auth.supabase.rpc("get_user_tenant_id");
  if (tenantError || !tenantId) return errorResponse(400, "Could not resolve tenant", tenantError?.message ?? null);

  const canonicalProvider = provider === "gmail" ? "google" : provider;
  const state = await signState({
    tenantId,
    userId: auth.user.id,
    provider: canonicalProvider,
    label,
    integrationCode,
    exp: Math.floor(Date.now() / 1000) + 10 * 60,
  });

  try {
    const supabaseUrl = env("SUPABASE_URL");

    if (canonicalProvider === "google") {
      const clientId = env("GOOGLE_OAUTH_CLIENT_ID");
      const redirectUri = env("GOOGLE_OAUTH_REDIRECT_URI", `${supabaseUrl}/functions/v1/oauth-callback`);
      const scope = Deno.env.get("GOOGLE_OAUTH_SCOPES")
        ?? "openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scope);
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("state", state);

      return jsonResponse(200, { ok: true, provider: canonicalProvider, authorizationUrl: url.toString(), state });
    }

    if (canonicalProvider === "slack") {
      const clientId = env("SLACK_OAUTH_CLIENT_ID");
      const redirectUri = env("SLACK_OAUTH_REDIRECT_URI", `${supabaseUrl}/functions/v1/oauth-callback`);
      const scope = Deno.env.get("SLACK_OAUTH_SCOPES") ?? "chat:write,channels:read,channels:history";

      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", scope);
      url.searchParams.set("state", state);

      return jsonResponse(200, { ok: true, provider: canonicalProvider, authorizationUrl: url.toString(), state });
    }

    if (canonicalProvider === "notion") {
      const clientId = env("NOTION_OAUTH_CLIENT_ID");
      const redirectUri = env("NOTION_OAUTH_REDIRECT_URI", `${supabaseUrl}/functions/v1/oauth-callback`);

      const url = new URL("https://api.notion.com/v1/oauth/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("owner", "user");
      url.searchParams.set("state", state);

      return jsonResponse(200, { ok: true, provider: canonicalProvider, authorizationUrl: url.toString(), state });
    }

    const clientId = env("ZOHO_OAUTH_CLIENT_ID");
    const redirectUri = env("ZOHO_OAUTH_REDIRECT_URI", `${supabaseUrl}/functions/v1/oauth-callback`);
    const scope = Deno.env.get("ZOHO_OAUTH_SCOPES") ?? "ZohoDesk.tickets.ALL";

    const url = new URL("https://accounts.zoho.com/oauth/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scope);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);

    return jsonResponse(200, { ok: true, provider: canonicalProvider, authorizationUrl: url.toString(), state });
  } catch (error) {
    return errorResponse(500, "Could not build OAuth URL", error instanceof Error ? error.message : null);
  }
});
