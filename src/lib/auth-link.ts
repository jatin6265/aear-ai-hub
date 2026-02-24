import { supabase } from "@/integrations/supabase/client";

type AuthLinkMode = "confirm" | "magic" | "recovery";

type ConsumeResult =
  | { ok: true }
  | { ok: false; error: string };

function parseHashParams(hashValue: string) {
  const raw = hashValue.startsWith("#") ? hashValue.slice(1) : hashValue;
  return new URLSearchParams(raw);
}

function getFirstParam(query: URLSearchParams, hash: URLSearchParams, keys: string[]) {
  for (const key of keys) {
    const queryValue = query.get(key);
    if (queryValue) return queryValue;
    const hashValue = hash.get(key);
    if (hashValue) return hashValue;
  }
  return "";
}

function looksLikeTokenHash(value: string) {
  const token = value.trim();
  if (!token) return false;
  if (token.length < 20) return false;
  return /^[A-Za-z0-9_-]+$/.test(token);
}

async function setSessionFromHash(hashParams: URLSearchParams) {
  const accessToken = hashParams.get("access_token");
  const refreshToken = hashParams.get("refresh_token");

  if (!accessToken || !refreshToken) return { ok: false, error: "Missing session tokens." } as const;

  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  if (error) return { ok: false, error: error.message } as const;
  return { ok: true } as const;
}

async function verifyOtpFromQuery(tokenHash: string, linkType: string | null, mode: AuthLinkMode) {
  const normalizedType = linkType?.trim().toLowerCase() ?? "";

  const fallbackTypes: string[] =
    mode === "confirm"
      ? ["signup", "invite", "email_change"]
      : mode === "magic"
        ? ["magiclink", "signup"]
        : ["recovery"];

  const candidates = normalizedType ? [normalizedType, ...fallbackTypes.filter((type) => type !== normalizedType)] : fallbackTypes;

  let lastError = "Invalid or expired link.";
  for (const type of candidates) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as "signup" | "recovery" | "invite" | "magiclink" | "email_change",
    });

    if (!error) return { ok: true } as const;
    lastError = error.message || lastError;
  }

  return { ok: false, error: lastError } as const;
}

async function verifyOtpFromToken(
  token: string,
  linkType: string | null,
  mode: AuthLinkMode,
  email?: string | null,
) {
  const normalizedType = linkType?.trim().toLowerCase() ?? "";
  const fallbackTypes: string[] =
    mode === "confirm"
      ? ["signup", "invite", "email_change"]
      : mode === "magic"
        ? ["magiclink", "signup"]
        : ["recovery"];

  const candidates = normalizedType ? [normalizedType, ...fallbackTypes.filter((type) => type !== normalizedType)] : fallbackTypes;
  let lastError = "Invalid or expired link.";

  for (const type of candidates) {
    const payload: Record<string, string> = {
      token,
      type,
    };
    if (email) payload.email = email;

    const { error } = await supabase.auth.verifyOtp(payload as never);
    if (!error) return { ok: true } as const;
    lastError = error.message || lastError;
  }

  return { ok: false, error: lastError } as const;
}

function decodeMaybeUrlEncoded(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function consumeAuthLinkFromLocation(mode: AuthLinkMode): Promise<ConsumeResult> {
  const url = new URL(window.location.href);
  const query = url.searchParams;
  const hashParams = parseHashParams(url.hash);

  const queryError = query.get("error_description") || query.get("error");
  const hashError = hashParams.get("error_description") || hashParams.get("error");
  const authError = queryError || hashError;
  if (authError) {
    const { data: existingSession } = await supabase.auth.getSession();
    if (existingSession.session) return { ok: true };
    return { ok: false, error: decodeMaybeUrlEncoded(authError.replace(/\+/g, " ")) };
  }

  const code = getFirstParam(query, hashParams, ["code"]);
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  const tokenHash = getFirstParam(query, hashParams, ["token_hash", "tokenHash"]);
  const token = getFirstParam(query, hashParams, ["token", "otp", "access_token"]);
  const linkType = getFirstParam(query, hashParams, ["type"]);
  if (tokenHash) {
    return verifyOtpFromQuery(tokenHash, linkType, mode);
  }
  if (token) {
    if (looksLikeTokenHash(token)) {
      const hashResult = await verifyOtpFromQuery(token, linkType, mode);
      if (hashResult.ok) return hashResult;
    }

    const email = getFirstParam(query, hashParams, ["email", "email_address"]);
    const tokenResult = await verifyOtpFromToken(token, linkType, mode, email);
    if (tokenResult.ok) return tokenResult;

    // Some legacy flows already set session cookies before redirect.
    const { data } = await supabase.auth.getSession();
    if (data.session) return { ok: true };
    return tokenResult;
  }

  const hashHasTokens = hashParams.has("access_token") && hashParams.has("refresh_token");
  if (hashHasTokens) {
    return setSessionFromHash(hashParams);
  }

  const { data: existingSession } = await supabase.auth.getSession();
  if (existingSession.session) return { ok: true };

  return { ok: false, error: "Missing or invalid token." };
}
