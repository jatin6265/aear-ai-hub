import { supabase } from "@/integrations/supabase/client";
import { formatEdgeFunctionError, getEdgeFunctionStatus, isLikelyAuthEdgeError } from "@/lib/edge-function-error";

type InvokeOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  requireAuth?: boolean;
  retryAuth?: boolean;
  timeoutMs?: number;
};

function isTokenExpiringSoon(expiresAt?: number | null, skewMs = 60_000) {
  if (!expiresAt) return true;
  return expiresAt * 1000 <= Date.now() + skewMs;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const json = atob(padded);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasProjectTokenMismatch(token: string) {
  const payload = decodeJwtPayload(token);
  const issuer = typeof payload?.iss === "string" ? payload.iss : "";
  const expectedAuthPrefix = `${import.meta.env.VITE_SUPABASE_URL}/auth/v1`;
  if (!issuer || !expectedAuthPrefix) return false;
  return !issuer.startsWith(expectedAuthPrefix);
}

function looksLikeJwt(token: string) {
  return token.split(".").length === 3;
}

function shouldTreatAsSessionExpired(error: unknown, parsedMessage?: string) {
  const status = getEdgeFunctionStatus(error);
  if (status !== 401) return false;
  const normalized = `${String(parsedMessage ?? "")} ${String((error as { message?: unknown })?.message ?? "")}`
    .toLowerCase();
  return (
    normalized.includes("jwt expired") ||
    normalized.includes("token is expired") ||
    normalized.includes("refresh token")
  );
}

function shouldResetLocalSessionFromEdgeError(error: unknown, parsedMessage?: string) {
  const normalized = `${String(parsedMessage ?? "")} ${String((error as { message?: unknown })?.message ?? "")}`
    .toLowerCase();
  return (
    normalized.includes("session token belongs to another supabase project") ||
    normalized.includes("jwt issuer does not match this supabase project")
  );
}

let refreshInFlight: Promise<string> | null = null;

function isInvalidSessionError(error: unknown) {
  const status = getEdgeFunctionStatus(error);
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return (
    status === 401 ||
    message.includes("invalid jwt") ||
    message.includes("jwt expired") ||
    message.includes("refresh token") ||
    message.includes("invalid refresh token") ||
    message.includes("token is expired")
  );
}

function isHardRefreshFailure(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const status = getEdgeFunctionStatus(error);
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  if (status === 401) return true;
  return (
    message.includes("invalid refresh token") ||
    message.includes("refresh token not found") ||
    message.includes("token has expired") ||
    message.includes("jwt expired")
  );
}

function clearSupabaseAuthStorage() {
  try {
    const keysToDelete: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key) continue;
      const lower = key.toLowerCase();
      if (lower.startsWith("sb-") && lower.includes("auth-token")) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) localStorage.removeItem(key);
  } catch {
    // Ignore storage errors.
  }
}

async function resetLocalSession() {
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // Ignore sign-out errors.
  }
  clearSupabaseAuthStorage();
}

function edgeAuthHeaders(token: string, extra?: Record<string, string>) {
  const apikey = String(
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
      import.meta.env.VITE_SUPABASE_ANON_KEY ??
      "",
  );
  return {
    ...(extra ?? {}),
    Authorization: `Bearer ${token}`,
    apikey,
  };
}

function timeoutError(functionName: string, timeoutMs: number) {
  return new Error(`Edge function '${functionName}' timed out after ${Math.max(1, Math.floor(timeoutMs / 1000))}s.`);
}

async function invokeWithTimeout<T>(
  functionName: string,
  body: unknown,
  headers: Record<string, string> | undefined,
  timeoutMs: number,
) {
  const invokePromise = supabase.functions.invoke<T>(functionName, { body, headers });
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return invokePromise;

  let timeoutId: number | null = null;
  const timeoutPromise = new Promise<{ data: T | null; error: Error }>((resolve) => {
    timeoutId = window.setTimeout(() => {
      resolve({
        data: null,
        error: timeoutError(functionName, timeoutMs),
      });
    }, timeoutMs);
  });

  const result = await Promise.race([
    invokePromise as Promise<{ data: T | null; error: Error | null }>,
    timeoutPromise,
  ]);

  if (timeoutId !== null) window.clearTimeout(timeoutId);
  return result;
}

async function refreshAccessToken() {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const refreshed = await supabase.auth.refreshSession();
      if (refreshed.data.session?.access_token) return refreshed.data.session.access_token;
      if (isHardRefreshFailure(refreshed.error)) {
        await resetLocalSession();
      }
      return "";
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function resolveAccessToken() {
  const sessionResult = await supabase.auth.getSession();
  const session = sessionResult.data.session;
  const existing = session?.access_token ?? "";
  if (existing && !isTokenExpiringSoon(session?.expires_at)) return existing;

  const refreshedToken = await refreshAccessToken();
  if (refreshedToken) return refreshedToken;

  // Final fallback only if current token is still valid.
  if (existing && !isTokenExpiringSoon(session?.expires_at, 0)) return existing;
  return "";
}

export async function invokeEdge<T = unknown>(functionName: string, options?: InvokeOptions) {
  const requireAuth = options?.requireAuth ?? true;
  const retryAuth = options?.retryAuth ?? true;
  const body = options?.body;
  const baseHeaders = options?.headers;
  const timeoutMs = options?.timeoutMs ?? 20_000;

  if (!requireAuth) {
    return invokeWithTimeout<T>(functionName, body, baseHeaders, timeoutMs);
  }

  let accessToken = await resolveAccessToken();
  if (!accessToken || !looksLikeJwt(accessToken)) {
    return {
      data: null,
      error: new Error("Session expired. Please sign in again."),
    } as { data: T | null; error: Error };
  }
  if (hasProjectTokenMismatch(accessToken)) {
    await resetLocalSession();
    return {
      data: null,
      error: new Error("Session token belongs to another Supabase project. Please sign out and sign in again."),
    } as { data: T | null; error: Error };
  }

  let result = await invokeWithTimeout<T>(functionName, body, edgeAuthHeaders(accessToken, baseHeaders), timeoutMs);

  let shouldRetryAuth = false;
  if (result.error && retryAuth) {
    shouldRetryAuth = isLikelyAuthEdgeError(result.error);
    if (!shouldRetryAuth) {
      const parsed = await formatEdgeFunctionError(result.error, { functionName });
      shouldRetryAuth = isLikelyAuthEdgeError(result.error, parsed);
    }
    if (!shouldRetryAuth) {
      const status = getEdgeFunctionStatus(result.error);
      shouldRetryAuth = status === 401;
    }
  }

  if (result.error && retryAuth && shouldRetryAuth) {
    accessToken = await refreshAccessToken();
    if (!accessToken || !looksLikeJwt(accessToken)) {
      return {
        data: null,
        error: new Error("Session expired. Please sign in again."),
      } as { data: T | null; error: Error };
    }
    if (hasProjectTokenMismatch(accessToken)) {
      await resetLocalSession();
      return {
        data: null,
        error: new Error("Session token belongs to another Supabase project. Please sign out and sign in again."),
      } as { data: T | null; error: Error };
    }
    result = await invokeWithTimeout<T>(functionName, body, edgeAuthHeaders(accessToken, baseHeaders), timeoutMs);
  }

  if (result.error) {
    const parsed = await formatEdgeFunctionError(result.error, { functionName });
    if (shouldResetLocalSessionFromEdgeError(result.error, parsed)) {
      await resetLocalSession();
    }
    if (shouldTreatAsSessionExpired(result.error, parsed)) {
      return {
        data: null,
        error: new Error("Session may be expired for this request. Please refresh and sign in again if it continues."),
      } as { data: T | null; error: Error };
    }
  }

  return result;
}
