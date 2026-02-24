import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

type Operation =
  | "get"
  | "rename"
  | "toggle_agent"
  | "toggle_tool"
  | "update_raci_role"
  | "clear_memory";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let operation: Operation = "get";
  let agentId = "";
  let name = "";
  let enabled = true;
  let toolId = "";
  let bindingId = "";
  let roleName = "";
  let memoryType = "all";

  try {
    const body = await req.json();
    operation = String(body?.operation ?? "get").trim().toLowerCase() as Operation;
    agentId = String(body?.agentId ?? "").trim();
    name = String(body?.name ?? "").trim();
    enabled = Boolean(body?.enabled);
    toolId = String(body?.toolId ?? "").trim();
    bindingId = String(body?.bindingId ?? "").trim();
    roleName = String(body?.roleName ?? "").trim();
    memoryType = String(body?.memoryType ?? "all").trim().toLowerCase();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!agentId) return errorResponse(400, "agentId is required");

  try {
    if (operation === "rename") {
      const { error } = await auth.supabase.rpc("rename_agent", {
        p_agent_id: agentId,
        p_name: name,
      });
      if (error) return errorResponse(400, "Failed to rename agent", error.message);
    } else if (operation === "toggle_agent") {
      const { error } = await auth.supabase.rpc("set_agent_enabled", {
        p_agent_id: agentId,
        p_enabled: enabled,
      });
      if (error) return errorResponse(400, "Failed to toggle agent", error.message);
    } else if (operation === "toggle_tool") {
      if (!toolId) return errorResponse(400, "toolId is required");
      const { error } = await auth.supabase.rpc("set_agent_tool_enabled", {
        p_tool_id: toolId,
        p_enabled: enabled,
      });
      if (error) return errorResponse(400, "Failed to toggle tool", error.message);
    } else if (operation === "update_raci_role") {
      if (!bindingId) return errorResponse(400, "bindingId is required");
      const { error } = await auth.supabase.rpc("update_agent_raci_binding_role", {
        p_binding_id: bindingId,
        p_role_name: roleName,
      });
      if (error) return errorResponse(400, "Failed to update RACI role", error.message);
    } else if (operation === "clear_memory") {
      const { error } = await auth.supabase.rpc("clear_agent_memory_entries", {
        p_agent_id: agentId,
        p_memory_type: memoryType,
      });
      if (error) return errorResponse(400, "Failed to clear memory", error.message);
    }

    const { data, error } = await auth.supabase.rpc("get_agent_detail_payload", {
      p_agent_id: agentId,
    });
    if (error) return errorResponse(400, "Failed to load agent detail", error.message);

    return jsonResponse(200, {
      ok: true,
      detail: data ?? {},
    });
  } catch (error) {
    return errorResponse(500, "Unexpected agent detail error", error instanceof Error ? error.message : null);
  }
});
