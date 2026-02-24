import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

function isUsableSession(session: Session | null) {
  if (!session?.access_token) return false;
  if (!session.expires_at) return true;
  return session.expires_at * 1000 > Date.now() + 5_000;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
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

function hasProjectTokenMismatch(token: string) {
  const payload = decodeJwtPayload(token);
  const issuer = typeof payload?.iss === "string" ? payload.iss : "";
  const expected = `${import.meta.env.VITE_SUPABASE_URL}/auth/v1`;
  if (!issuer || !expected) return false;
  return !issuer.startsWith(expected);
}

function isHardRefreshFailure(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const status = Number((error as { status?: unknown })?.status ?? 0);
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  if (status === 401) return true;
  return (
    message.includes("invalid refresh token") ||
    message.includes("refresh token not found") ||
    message.includes("token has expired") ||
    message.includes("jwt expired")
  );
}

export async function ensureActiveUserSession() {
  const current = await supabase.auth.getSession();
  const active = current.data.session ?? null;
  if (active?.access_token && hasProjectTokenMismatch(active.access_token)) {
    await supabase.auth.signOut({ scope: "local" });
    return null;
  }
  if (isUsableSession(active)) return active;

  const refreshed = await supabase.auth.refreshSession();
  if (isHardRefreshFailure(refreshed.error)) {
    await supabase.auth.signOut({ scope: "local" });
    return null;
  }
  const refreshedSession = refreshed.data.session ?? null;
  if (refreshedSession?.access_token && hasProjectTokenMismatch(refreshedSession.access_token)) {
    await supabase.auth.signOut({ scope: "local" });
    return null;
  }
  if (isUsableSession(refreshedSession)) return refreshedSession;

  // Keep current token if refresh failed transiently but token still exists.
  if (active?.access_token) return active;
  return null;
}
