type ResponseLike = {
  status?: unknown;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
  clone?: () => ResponseLike;
};

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isResponseLike(value: unknown): value is ResponseLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as ResponseLike;
  return typeof candidate.json === "function" || typeof candidate.text === "function";
}

function cloneResponseLike(value: ResponseLike) {
  if (typeof value.clone !== "function") return value;
  try {
    return value.clone();
  } catch {
    return value;
  }
}

function extractDetailsFromPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;

  const direct =
    asString(record.message) ||
    asString(record.reason) ||
    asString(record.detail) ||
    asString(record.details) ||
    asString(record.error);
  if (direct) return direct;

  if (record.details && typeof record.details === "object") {
    const detailsRecord = record.details as Record<string, unknown>;
    const summary = asString(detailsRecord.summary);
    if (summary) return summary;
    if (Array.isArray(detailsRecord.failures) && detailsRecord.failures.length > 0) {
      const first = detailsRecord.failures[0];
      if (first && typeof first === "object") {
        const reason = asString((first as Record<string, unknown>).reason);
        if (reason) return reason;
      }
    }
    try {
      return JSON.stringify(detailsRecord);
    } catch {
      return "";
    }
  }

  return "";
}

export function getEdgeFunctionStatus(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const asRecord = error as Record<string, unknown>;
  const directStatus = asNumber(asRecord.status);
  if (directStatus !== null) return directStatus;

  const context = asRecord.context;
  if (context && typeof context === "object") {
    const contextStatus = asNumber((context as Record<string, unknown>).status);
    if (contextStatus !== null) return contextStatus;
  }
  const response = asRecord.response;
  if (response && typeof response === "object") {
    const responseStatus = asNumber((response as Record<string, unknown>).status);
    if (responseStatus !== null) return responseStatus;
  }
  return null;
}

export async function formatEdgeFunctionError(error: unknown, options?: { functionName?: string }) {
  if (!error || typeof error !== "object") return "Unknown edge function error.";

  const asRecord = error as Record<string, unknown>;
  const baseMessage = asString(asRecord.message) || "Unknown edge function error.";
  const status = getEdgeFunctionStatus(error);
  const context = asRecord.context ?? asRecord.response;
  let details = "";

  if (isResponseLike(context)) {
    const response = cloneResponseLike(context);
    if (typeof response.json === "function") {
      try {
        const payload = await response.json();
        details = extractDetailsFromPayload(payload);
      } catch {
        // Fall through to text parsing.
      }
    }
    if (!details && typeof response.text === "function") {
      try {
        details = asString(await response.text());
      } catch {
        // Ignore text parse failures.
      }
    }
  }

  if (details) {
    const detailsLower = details.toLowerCase();
    if (
      detailsLower.includes("insufficient_quota") ||
      detailsLower.includes("quota exceeded") ||
      detailsLower.includes("billing_hard_limit_reached") ||
      detailsLower.includes("rate limit reached for requests")
    ) {
      return "LLM provider quota/credits are exhausted. Top up OpenAI billing or switch to fallback mode.";
    }
    if (detailsLower.includes("missing authorization header")) {
      return "Backend auth header missing. Please retry; if it persists, redeploy edge functions.";
    }
    if (detailsLower.includes("invalid jwt")) {
      return "Backend rejected access token for this request. This is often backend runtime key mismatch; refresh once, then verify deployed Supabase secrets if it continues.";
    }
    if (detailsLower.includes("did not include a user jwt")) {
      return "Request did not include a user session JWT. Refresh and retry; if it persists, verify edge runtime auth wiring.";
    }
    if (detailsLower.includes("unauthorized")) {
      return "Backend authorization failed. Sign in again and retry.";
    }
    return details;
  }

  if (status === 401) {
    return "Unauthorized request from backend. Sign in again and retry.";
  }
  if (status === 403) {
    return "You do not have permission for this action.";
  }
  if (status === 404 && options?.functionName) {
    return `Backend function '${options.functionName}' is not deployed in this Supabase project.`;
  }
  if (status && options?.functionName) {
    return `Backend function '${options.functionName}' failed with HTTP ${status}. Check function logs.`;
  }

  if (baseMessage.toLowerCase().includes("non-2xx") && options?.functionName) {
    return `Backend function '${options.functionName}' returned an HTTP error. Check deployment and function logs.`;
  }

  return baseMessage;
}

export function isLikelyAuthEdgeError(error: unknown, parsedMessage?: string) {
  const status = getEdgeFunctionStatus(error);
  if (status === 401) return true;
  const combined = `${asString(parsedMessage)} ${asString((error as { message?: unknown })?.message)}`.toLowerCase();
  return (
    combined.includes("authorization header did not include a user jwt") ||
    combined.includes("missing authorization header") ||
    combined.includes("invalid jwt") ||
    combined.includes("jwt expired") ||
    combined.includes("invalid refresh token") ||
    combined.includes("session token belongs to another supabase project")
  );
}

export function sanitizeConnectionErrorMessage(message: string) {
  let sanitized = message;
  sanitized = sanitized.replace(
    /(mongodb(?:\+srv)?:\/\/)([^:@/\s]+):([^@/\s]+)@/gi,
    "$1$2:[REDACTED]@",
  );
  sanitized = sanitized.replace(/(["']?(?:password|api[_-]?key|token)["']?\s*[:=]\s*["'])([^"']+)(["'])/gi, "$1[REDACTED]$3");
  return sanitized;
}

export function isSessionExpiredMessage(message: string) {
  const normalized = asString(message).toLowerCase();
  return (
    normalized.includes("session expired") ||
    normalized.includes("refresh token") ||
    normalized.includes("jwt expired")
  );
}
