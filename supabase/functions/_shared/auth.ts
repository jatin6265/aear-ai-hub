import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { errorResponse } from "./http.ts";

function extractBearerToken(headerValue: string) {
  const trimmed = headerValue.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() ?? "";
  if (!token) return "";
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1).trim();
  }
  return token;
}

function looksLikeJwt(token: string) {
  return token.split(".").length === 3;
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

function issuerBaseFromToken(token: string) {
  const payload = decodeJwtPayload(token);
  const issuer = typeof payload?.iss === "string" ? payload.iss : "";
  if (!issuer) return "";
  return issuer.replace(/\/auth\/v1\/?$/i, "").trim();
}

function uniqueNonEmpty(values: Array<string | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter((value) => value.length > 0),
    ),
  );
}

function buildUrlCandidates(token: string) {
  const envPrimary = Deno.env.get("SUPABASE_URL");
  const envFallback = Deno.env.get("VITE_SUPABASE_URL");
  const issuerBase = issuerBaseFromToken(token);
  return uniqueNonEmpty([envPrimary, envFallback, issuerBase]);
}

function hasProjectIssuerMismatch(token: string, urlCandidates: string[]) {
  const issuerBase = issuerBaseFromToken(token);
  if (!issuerBase) return false;
  if (urlCandidates.length === 0) return false;
  return !urlCandidates.some((value) => value === issuerBase);
}

type VerifiedUser = {
  id: string;
  [key: string]: unknown;
};

export async function getAuthedClient(req: Request) {
  const requestApiKey = req.headers.get("apikey") ?? req.headers.get("x-api-key") ?? "";
  const publicKeys = uniqueNonEmpty([
    requestApiKey,
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY"),
    Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY"),
    Deno.env.get("SUPABASE_ANON_KEY"),
    Deno.env.get("VITE_SUPABASE_ANON_KEY"),
  ]);
  const serviceKeys = uniqueNonEmpty([
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    Deno.env.get("VITE_SUPABASE_SERVICE_ROLE_KEY"),
  ]);

  if (serviceKeys.length === 0 && publicKeys.length === 0) {
    return {
      ok: false as const,
      response: errorResponse(
        500,
        "Missing Supabase runtime keys (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY or publishable/anon key)",
      ),
    };
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return {
      ok: false as const,
      response: errorResponse(401, "Missing authorization header"),
    };
  }
  const accessToken = extractBearerToken(authHeader);
  if (!accessToken) {
    return {
      ok: false as const,
      response: errorResponse(401, "Malformed authorization header"),
    };
  }
  if (!looksLikeJwt(accessToken)) {
    return {
      ok: false as const,
      response: errorResponse(
        401,
        "Unauthorized",
        "Authorization header did not include a user JWT. Sign in again and retry.",
      ),
    };
  }

  const urlCandidates = buildUrlCandidates(accessToken);
  if (urlCandidates.length === 0) {
    return {
      ok: false as const,
      response: errorResponse(
        500,
        "Missing Supabase runtime URL (SUPABASE_URL or VITE_SUPABASE_URL)",
      ),
    };
  }

  // Verify with runtime keys in deterministic order:
  // service keys first (stable for JWT verification), then request/public fallbacks.
  const verificationCandidates = uniqueNonEmpty([...serviceKeys, ...publicKeys]);

  let verifiedUser: VerifiedUser | null = null;
  let verificationErrorMessage = "";
  let selectedUrl = "";
  let selectedVerificationKey = "";

  for (const candidateUrl of urlCandidates) {
    for (const candidateKey of verificationCandidates) {
      const verificationClient = createClient(candidateUrl, candidateKey, {
        global: {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      });

      const {
        data: { user },
        error,
      } = await verificationClient.auth.getUser(accessToken);

      if (!error && user) {
        verifiedUser = user as unknown as VerifiedUser;
        selectedUrl = candidateUrl;
        selectedVerificationKey = candidateKey;
        break;
      }

      if (error?.message) verificationErrorMessage = error.message;
    }
    if (verifiedUser) break;
  }

  if (!verifiedUser) {
    if (hasProjectIssuerMismatch(accessToken, urlCandidates)) {
      return {
        ok: false as const,
        response: errorResponse(
          401,
          "Unauthorized",
          "JWT issuer does not match this Supabase project. Sign out and sign in again.",
        ),
      };
    }
    return {
      ok: false as const,
      response: errorResponse(401, "Unauthorized", verificationErrorMessage || "Could not verify access token"),
    };
  }

  // Use the exact key that successfully verified this JWT.
  // This avoids split-brain failures when service/public keys drift in runtime secrets.
  const runtimeKey = selectedVerificationKey || serviceKeys[0];
  const runtimeUrl = selectedUrl || urlCandidates[0];

  if (!runtimeKey || !runtimeUrl) {
    return {
      ok: false as const,
      response: errorResponse(500, "Missing Supabase runtime URL/key after verification"),
    };
  }

  const supabase = createClient(runtimeUrl, runtimeKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });

  return {
    ok: true as const,
    supabase,
    user: verifiedUser,
  };
}
