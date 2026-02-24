import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

function normalizeWindowDays(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 30;
  return Math.max(7, Math.min(Math.round(parsed), 90));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let windowDays = 30;

  if (req.method === "GET") {
    const url = new URL(req.url);
    windowDays = normalizeWindowDays(url.searchParams.get("windowDays"));
  } else {
    try {
      const body = (await req.json()) as { windowDays?: number };
      windowDays = normalizeWindowDays(body?.windowDays);
    } catch {
      return errorResponse(400, "Invalid JSON body");
    }
  }

  const { data, error } = await auth.supabase.rpc("get_tenant_billing_dashboard", {
    p_window_days: windowDays,
  });

  if (error) return errorResponse(400, "Could not load billing dashboard", error.message);

  return jsonResponse(200, {
    ok: true,
    windowDays,
    payload: data ?? {},
  });
});

