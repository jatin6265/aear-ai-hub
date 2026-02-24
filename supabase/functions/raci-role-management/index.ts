import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

type Operation = "get_payload" | "upsert_role" | "apply_template" | "delete_role";

function normalizeMemberIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length > 0);
}

async function loadPayload(supabase: { rpc: (...args: unknown[]) => Promise<{ data: unknown; error: { message?: string } | null }> }) {
  const { data, error } = await supabase.rpc("get_raci_role_management_payload");
  if (error) throw new Error(error.message || "Failed to load RACI roles payload");
  return data ?? { roles: [], members: [], templates: [] };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let operation: Operation = "get_payload";
  let body: Record<string, unknown> = {};

  try {
    body = (await req.json()) as Record<string, unknown>;
    operation = String(body?.operation ?? "get_payload").trim().toLowerCase() as Operation;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  try {
    if (operation === "upsert_role") {
      const roleName = String(body?.roleName ?? "").trim();
      const previousRoleName = String(body?.previousRoleName ?? "").trim();
      const description = String(body?.description ?? "").trim();
      const icon = String(body?.icon ?? "").trim();
      const memberIds = normalizeMemberIds(body?.memberIds);

      if (!roleName) return errorResponse(400, "roleName is required");

      const { error } = await auth.supabase.rpc("upsert_raci_role_management", {
        p_role_name: roleName,
        p_description: description || null,
        p_icon: icon || null,
        p_member_ids: memberIds,
        p_previous_role_name: previousRoleName || null,
      });
      if (error) return errorResponse(400, "Failed to save role", error.message);
    } else if (operation === "apply_template") {
      const templateKey = String(body?.templateKey ?? "").trim();
      const roleName = String(body?.roleName ?? "").trim();
      const memberIds = normalizeMemberIds(body?.memberIds);

      if (!templateKey) return errorResponse(400, "templateKey is required");

      const { data, error } = await auth.supabase.rpc("apply_raci_role_template", {
        p_template_key: templateKey,
        p_member_ids: memberIds,
        p_role_name: roleName || null,
      });
      if (error) return errorResponse(400, "Failed to apply role template", error.message);

      const payload = await loadPayload(auth.supabase);
      return jsonResponse(200, {
        ok: true,
        templateResult: data ?? null,
        payload,
      });
    } else if (operation === "delete_role") {
      const roleName = String(body?.roleName ?? "").trim();
      if (!roleName) return errorResponse(400, "roleName is required");

      const { data, error } = await auth.supabase.rpc("delete_raci_role", {
        p_role_name: roleName,
        p_force: true,
      });
      if (error) return errorResponse(400, "Failed to delete role", error.message);

      const payload = await loadPayload(auth.supabase);
      return jsonResponse(200, {
        ok: true,
        deleted: Number(data ?? 0),
        payload,
      });
    } else if (operation !== "get_payload") {
      return errorResponse(400, "Unsupported operation");
    }

    const payload = await loadPayload(auth.supabase);
    return jsonResponse(200, {
      ok: true,
      payload,
    });
  } catch (error) {
    return errorResponse(500, "Unexpected RACI role management error", error instanceof Error ? error.message : null);
  }
});
