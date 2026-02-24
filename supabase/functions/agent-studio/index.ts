import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

type Operation =
  | "get_payload"
  | "suggest_from_prompt"
  | "save_agent"
  | "sync_agent"
  | "create_from_chat"
  | "delete_agent";

function asString(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asBoolean(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  return fallback;
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return value
    .map((entry) => asString(entry))
    .filter((entry) => entry.length > 0);
}

function asUuidArray(value: unknown) {
  return asStringArray(value).filter((entry) => /^[0-9a-fA-F-]{36}$/.test(entry));
}

async function loadPayload(supabase: { rpc: (...args: unknown[]) => Promise<{ data: unknown; error: { message?: string } | null }> }, agentId?: string | null) {
  const { data, error } = await supabase.rpc("get_agent_studio_payload", {
    p_agent_id: agentId || null,
  });
  if (error) throw new Error(error.message || "Failed to load agent studio payload");
  return data ?? { templates: [], connections: [], agents: [], selectedAgent: null };
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
    if (operation === "suggest_from_prompt") {
      const prompt = asString(body?.prompt);
      if (!prompt) return errorResponse(400, "prompt is required");

      const { data, error } = await auth.supabase.rpc("suggest_custom_agent_blueprint", {
        p_prompt: prompt,
      });
      if (error) return errorResponse(400, "Failed to generate agent blueprint", error.message);

      return jsonResponse(200, {
        ok: true,
        blueprint: data ?? null,
      });
    }

    if (operation === "save_agent") {
      const agentId = asString(body?.agentId) || null;
      const name = asString(body?.name, "Custom Copilot");
      const description = asString(body?.description) || null;
      const domain = asString(body?.domain) || null;
      const prompt = asString(body?.prompt) || null;
      const objective = asString(body?.objective) || null;
      const systemPrompt = asString(body?.systemPrompt) || null;
      const avatarEmoji = asString(body?.avatarEmoji) || null;
      const capabilities = asStringArray(body?.capabilities);
      const sourceConnectionIds = asUuidArray(body?.sourceConnectionIds);
      const syncFrequency = asString(body?.syncFrequency, "hourly");
      const vectorStrategy = asString(body?.vectorStrategy, "hybrid");
      const ragEnabled = asBoolean(body?.ragEnabled, true);
      const autoSync = asBoolean(body?.autoSync, true);
      const autoDeploy = asBoolean(body?.autoDeploy, true);
      const deployNow = asBoolean(body?.deployNow, true);
      const raciScope = asString(body?.raciScope) || null;

      const { data, error } = await auth.supabase.rpc("upsert_custom_agent_studio", {
        p_agent_id: agentId,
        p_name: name,
        p_description: description,
        p_domain: domain,
        p_prompt: prompt,
        p_objective: objective,
        p_system_prompt: systemPrompt,
        p_avatar_emoji: avatarEmoji,
        p_capabilities: capabilities,
        p_source_connection_ids: sourceConnectionIds,
        p_sync_frequency: syncFrequency,
        p_vector_strategy: vectorStrategy,
        p_rag_enabled: ragEnabled,
        p_auto_sync: autoSync,
        p_auto_deploy: autoDeploy,
        p_deploy_now: deployNow,
        p_raci_scope: raciScope,
      });
      if (error) return errorResponse(400, "Failed to save custom agent", error.message);

      const payload = await loadPayload(auth.supabase, (data as Record<string, unknown> | null)?.agentId as string | undefined);

      return jsonResponse(200, {
        ok: true,
        result: data ?? null,
        payload,
      });
    }

    if (operation === "sync_agent") {
      const agentId = asString(body?.agentId);
      if (!agentId) return errorResponse(400, "agentId is required");

      const { data, error } = await auth.supabase.rpc("sync_custom_agent", {
        p_agent_id: agentId,
      });
      if (error) return errorResponse(400, "Failed to sync custom agent", error.message);

      const payload = await loadPayload(auth.supabase, agentId);
      return jsonResponse(200, {
        ok: true,
        result: data ?? null,
        payload,
      });
    }

    if (operation === "create_from_chat") {
      const prompt = asString(body?.prompt);
      const sessionId = asString(body?.sessionId) || null;
      if (!prompt) return errorResponse(400, "prompt is required");

      const { data, error } = await auth.supabase.rpc("create_custom_agent_from_chat_prompt", {
        p_prompt: prompt,
        p_session_id: sessionId,
      });
      if (error) return errorResponse(400, "Failed to create agent from chat prompt", error.message);

      return jsonResponse(200, {
        ok: true,
        result: data ?? null,
      });
    }

    if (operation === "delete_agent") {
      const agentId = asString(body?.agentId);
      if (!agentId) return errorResponse(400, "agentId is required");

      const { error } = await auth.supabase
        .from("ai_agents")
        .delete()
        .eq("id", agentId)
        .eq("is_custom", true);

      if (error) return errorResponse(400, "Failed to delete custom agent", error.message);

      const payload = await loadPayload(auth.supabase, null);
      return jsonResponse(200, {
        ok: true,
        payload,
      });
    }

    if (operation !== "get_payload") return errorResponse(400, "Unsupported operation");

    const payload = await loadPayload(auth.supabase, asString(body?.agentId) || null);
    return jsonResponse(200, {
      ok: true,
      payload,
    });
  } catch (error) {
    return errorResponse(500, "Unexpected agent studio error", error instanceof Error ? error.message : null);
  }
});
