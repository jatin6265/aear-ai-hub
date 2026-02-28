import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { invokeFunction } from "../_shared/function-proxy.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const role = String(body.role ?? "member").trim().toLowerCase();
  const invites = Array.isArray(body.invites)
    ? body.invites
    : email
      ? [{ email, role }]
      : [];

  if (invites.length === 0) return errorResponse(400, "Provide invite email or invites[]");

  const proxied = await invokeFunction(req, "send-team-invites", { invites });
  if (!proxied.ok) return errorResponse(proxied.status, proxied.error ?? "Could not send invitations", proxied.data);

  return jsonResponse(200, { ok: true, data: proxied.data, error: null });
});
