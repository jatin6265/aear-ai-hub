import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";

type Operation = "get_payload";

type RequestBody = {
  operation?: Operation;
  hours?: number;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeHours(value: unknown) {
  const parsed = Number(value ?? 24);
  if (!Number.isFinite(parsed)) return 24;
  return Math.max(6, Math.min(168, Math.floor(parsed)));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const operation = clean(body.operation || "get_payload").toLowerCase() as Operation;
  if (operation !== "get_payload") {
    return errorResponse(400, "Unsupported operation");
  }

  const { data, error } = await auth.supabase.rpc("get_platform_super_admin_infrastructure_health", {
    p_hours: normalizeHours(body.hours),
  });

  if (error) {
    return errorResponse(400, "Could not load platform infrastructure health", error.message);
  }

  return jsonResponse(200, {
    ok: true,
    operation,
    payload: data ?? null,
  });
});
