import { errorResponse, jsonResponse } from "./http.ts";

function runtimeBaseUrl() {
  const base = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("VITE_SUPABASE_URL") ?? "";
  return base.trim().replace(/\/+$/, "");
}

function runtimeApiKey() {
  return (
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
    Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY") ??
    Deno.env.get("SUPABASE_ANON_KEY") ??
    Deno.env.get("VITE_SUPABASE_ANON_KEY") ??
    ""
  ).trim();
}

export async function invokeFunction(
  req: Request,
  functionName: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: unknown; error: string | null }> {
  const base = runtimeBaseUrl();
  if (!base) {
    return {
      ok: false,
      status: 500,
      data: null,
      error: "SUPABASE_URL or VITE_SUPABASE_URL is not configured",
    };
  }

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.trim()) {
    return {
      ok: false,
      status: 401,
      data: null,
      error: "Missing authorization header",
    };
  }

  const headers: HeadersInit = {
    "content-type": "application/json",
    authorization: authHeader,
  };

  const apikey = runtimeApiKey();
  if (apikey) headers["apikey"] = apikey;

  const response = await fetch(`${base}/functions/v1/${functionName}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errorMessage =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as Record<string, unknown>).error ?? "Upstream function failed")
        : `Upstream function failed (${response.status})`;

    return {
      ok: false,
      status: response.status,
      data: payload,
      error: errorMessage,
    };
  }

  return {
    ok: true,
    status: response.status,
    data: payload,
    error: null,
  };
}

export function proxyFailure(status: number, message: string, details?: unknown) {
  return errorResponse(status, message, details);
}

export function proxySuccess(data: unknown) {
  return jsonResponse(200, { ok: true, data, error: null });
}
