import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

type Operation =
  | "get_payload"
  | "set_cell"
  | "add_role"
  | "rename_role"
  | "delete_role"
  | "add_rule"
  | "import_csv"
  | "validate";

async function loadPayload(supabase: { rpc: (...args: unknown[]) => Promise<{ data: unknown; error: { message?: string } | null }> }) {
  const { data, error } = await supabase.rpc("get_raci_editor_payload");
  if (error) throw new Error(error.message || "Failed to load RACI editor payload");
  return data ?? { roles: [], resources: [], cells: [] };
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
    if (operation === "set_cell") {
      const resourceKey = String(body?.resourceKey ?? "").trim();
      const action = String(body?.action ?? "execute").trim();
      const roleName = String(body?.roleName ?? "").trim();
      const raciType = String(body?.raciType ?? "-").trim();

      if (!resourceKey || !roleName) {
        return errorResponse(400, "resourceKey and roleName are required");
      }

      const { error } = await auth.supabase.rpc("set_raci_cell", {
        p_resource_key: resourceKey,
        p_action: action,
        p_role_name: roleName,
        p_raci_type: raciType,
      });
      if (error) return errorResponse(400, "Failed to set RACI cell", error.message);
    } else if (operation === "add_role") {
      const roleName = String(body?.roleName ?? "").trim();
      if (!roleName) return errorResponse(400, "roleName is required");

      const { error } = await auth.supabase.rpc("add_raci_role", {
        p_role_name: roleName,
      });
      if (error) return errorResponse(400, "Failed to add role", error.message);
    } else if (operation === "rename_role") {
      const oldRoleName = String(body?.oldRoleName ?? "").trim();
      const newRoleName = String(body?.newRoleName ?? "").trim();
      if (!oldRoleName || !newRoleName) {
        return errorResponse(400, "oldRoleName and newRoleName are required");
      }

      const { error } = await auth.supabase.rpc("rename_raci_role", {
        p_old_role_name: oldRoleName,
        p_new_role_name: newRoleName,
      });
      if (error) return errorResponse(400, "Failed to rename role", error.message);
    } else if (operation === "delete_role") {
      const roleName = String(body?.roleName ?? "").trim();
      const force = Boolean(body?.force);
      if (!roleName) return errorResponse(400, "roleName is required");

      const { data, error } = await auth.supabase.rpc("delete_raci_role", {
        p_role_name: roleName,
        p_force: force,
      });

      if (error) {
        const message = String(error.message ?? "");
        if (message.toLowerCase().includes("active rules")) {
          const { count } = await auth.supabase
            .from("raci_matrix")
            .select("id", { count: "exact", head: true })
            .ilike("role_name", roleName);

          return jsonResponse(409, {
            ok: false,
            error: "Role has active rules",
            requiresForce: true,
            roleName,
            ruleCount: count ?? 0,
          });
        }
        return errorResponse(400, "Failed to delete role", error.message);
      }

      const payload = await loadPayload(auth.supabase);
      return jsonResponse(200, {
        ok: true,
        deleted: Number(data ?? 0),
        payload,
      });
    } else if (operation === "add_rule") {
      const resourceKey = String(body?.resourceKey ?? "").trim();
      const action = String(body?.action ?? "execute").trim();
      const categoryRaw = body?.category;
      const category = typeof categoryRaw === "string" && categoryRaw.trim() ? categoryRaw.trim() : null;
      if (!resourceKey) return errorResponse(400, "resourceKey is required");

      const { error } = await auth.supabase.rpc("add_raci_rule_resource", {
        p_resource_key: resourceKey,
        p_action: action,
        p_category: category,
      });
      if (error) return errorResponse(400, "Failed to add rule resource", error.message);
    } else if (operation === "import_csv") {
      const rows = Array.isArray(body?.rows) ? body.rows : [];

      const { data, error } = await auth.supabase.rpc("import_raci_rules_csv_rows", {
        p_rows: rows,
      });
      if (error) return errorResponse(400, "Failed to import CSV rows", error.message);

      const payload = await loadPayload(auth.supabase);
      return jsonResponse(200, {
        ok: true,
        importedCount: Number(data ?? 0),
        payload,
      });
    } else if (operation === "validate") {
      const { data, error } = await auth.supabase.rpc("validate_raci_matrix_rules");
      if (error) return errorResponse(400, "Failed to validate RACI rules", error.message);

      return jsonResponse(200, {
        ok: true,
        validation: data ?? {
          totalResources: 0,
          compliantResources: 0,
          issuesCount: 0,
          issues: [],
        },
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
    return errorResponse(500, "Unexpected RACI editor error", error instanceof Error ? error.message : null);
  }
});
