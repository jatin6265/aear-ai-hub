import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { errorResponse } from "./http.ts";

function uniqueNonEmpty(values: Array<string | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter((value) => value.length > 0),
    ),
  );
}

function decodeJwtPayload(token: string) {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function projectRefFromUrl(url: string) {
  try {
    const [projectRef] = new URL(url).hostname.split(".");
    return String(projectRef || "").trim();
  } catch {
    return "";
  }
}

function keyMatchesUrlProject(key: string, url: string) {
  if (!key || !url) return false;
  // Opaque publishable/secret keys cannot be decoded in runtime; treat as possibly valid.
  if (key.startsWith("sb_publishable_") || key.startsWith("sb_secret_")) return true;

  const payload = decodeJwtPayload(key);
  if (!payload) return false;
  const keyRef = typeof payload.ref === "string" ? payload.ref.trim() : "";
  const expectedRef = projectRefFromUrl(url);
  if (keyRef && expectedRef) return keyRef === expectedRef;

  const issuer = typeof payload.iss === "string" ? payload.iss : "";
  return Boolean(issuer && issuer.startsWith(`${url}/auth/v1`));
}

function resolveRuntimePair(urls: string[], keys: string[]) {
  for (const url of urls) {
    const matchingKey = keys.find((key) => keyMatchesUrlProject(key, url));
    if (matchingKey) return { url, key: matchingKey, matched: true };
  }
  return {
    url: urls[0] || "",
    key: keys[0] || "",
    matched: false,
  };
}

export function getServiceClient() {
  // Prefer canonical runtime secrets; keep VITE_* only as fallback for legacy deployments.
  const supabaseUrls = uniqueNonEmpty([
    Deno.env.get("SUPABASE_URL"),
    Deno.env.get("VITE_SUPABASE_URL"),
  ]);
  const canonicalServiceRoleKey = String(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const viteServiceRoleKey = String(Deno.env.get("VITE_SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const serviceKeys = uniqueNonEmpty([canonicalServiceRoleKey, viteServiceRoleKey]);

  if (
    viteServiceRoleKey.length > 0 &&
    canonicalServiceRoleKey.length > 0 &&
    viteServiceRoleKey !== canonicalServiceRoleKey
  ) {
    console.warn(
      "SUPABASE service role keys differ; selected canonical SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  if (supabaseUrls.length === 0 || serviceKeys.length === 0) {
    return {
      ok: false as const,
      response: errorResponse(
        500,
        "Missing Supabase service keys (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)",
      ),
    };
  }

  if (supabaseUrls.length > 1) {
    console.warn("SUPABASE URLs differ; selected canonical SUPABASE_URL.");
  }

  const resolved = resolveRuntimePair(supabaseUrls, serviceKeys);
  if (!resolved.matched && supabaseUrls.length > 1 && serviceKeys.length > 1) {
    console.warn("Could not verify URL/key project match from token metadata; using first runtime pair.");
  }

  const supabase = createClient(resolved.url, resolved.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return {
    ok: true as const,
    supabase,
  };
}

export function requireWorkerToken(req: Request) {
  const expected = Deno.env.get("CONNECTOR_WORKER_TOKEN") ?? Deno.env.get("VITE_CONNECTOR_WORKER_TOKEN");
  if (!expected) {
    return {
      ok: false as const,
      response: errorResponse(500, "CONNECTOR_WORKER_TOKEN is not configured"),
    };
  }

  const fromHeader = req.headers.get("x-worker-token") ?? "";
  if (fromHeader && fromHeader === expected) {
    return { ok: true as const };
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (token === expected) {
    return { ok: true as const };
  }

  return {
    ok: false as const,
    response: errorResponse(401, "Invalid worker token"),
  };
}
