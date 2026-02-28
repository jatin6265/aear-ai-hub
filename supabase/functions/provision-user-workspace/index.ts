import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let payload: Record<string, unknown> = {};
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    payload = {};
  }

  const { data, error } = await auth.supabase.rpc("provision_user_workspace", {
    p_company_name: String(payload.companyName ?? payload.company_name ?? "").trim() || null,
    p_company_slug: String(payload.companySlug ?? payload.company_slug ?? "").trim() || null,
    p_full_name: String(payload.fullName ?? payload.full_name ?? "").trim() || null,
    p_terms_accepted: payload.termsAccepted === undefined ? true : Boolean(payload.termsAccepted),
  });

  if (error) return errorResponse(400, "Could not provision user workspace", error.message);
  return jsonResponse(200, { ok: true, data: data?.[0] ?? null, error: null });
});
