import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/service.ts";
import { sha256Hex } from "../_shared/crypto.ts";

type Caller = {
  mode: "api_key" | "jwt";
  tenantId: string;
  userId: string | null;
  scopes: string[];
  apiKeyId: string | null;
  supabase: ReturnType<typeof getServiceClient> extends { ok: true; supabase: infer S } ? S : never;
};

function parseRoute(req: Request, bodyRoute: string | null): string {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const index = segments.findIndex((segment) => segment === "api-v1-gateway");
  if (index >= 0) {
    const suffix = segments.slice(index + 1).join("/");
    if (suffix) return `/${suffix}`;
  }
  return bodyRoute ? `/${bodyRoute.replace(/^\/+/, "")}` : "/";
}

function parseBearer(req: Request): string {
  const auth = req.headers.get("Authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

function hasScope(scopes: string[], required: string) {
  if (scopes.includes("admin") || scopes.includes("*")) return true;
  if (required.endsWith(":read") && scopes.includes("read")) return true;
  if (required.endsWith(":write") && scopes.includes("write")) return true;
  return scopes.includes(required);
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function resolveCaller(req: Request): Promise<{ ok: true; caller: Caller } | { ok: false; response: Response }> {
  const service = getServiceClient();
  if (!service.ok) return { ok: false, response: service.response };

  const token = parseBearer(req);
  if (!token) return { ok: false, response: errorResponse(401, "Missing bearer token") };

  if (token.startsWith("opsai_") || token.startsWith("ak_")) {
    const hash = await sha256Hex(token);
    const { data: keyRow, error: keyError } = await service.supabase
      .from("api_keys")
      .select("id, tenant_id, scopes, expires_at")
      .eq("key_hash", hash)
      .is("revoked_at", null)
      .maybeSingle();

    if (keyError) return { ok: false, response: errorResponse(401, "Invalid API key", keyError.message) };
    if (!keyRow) return { ok: false, response: errorResponse(401, "Invalid API key") };
    if (keyRow.expires_at && new Date(keyRow.expires_at).getTime() <= Date.now()) {
      return { ok: false, response: errorResponse(401, "API key expired") };
    }

    await service.supabase
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", String(keyRow.id))
      .is("revoked_at", null);

    return {
      ok: true,
      caller: {
        mode: "api_key",
        tenantId: String(keyRow.tenant_id),
        userId: null,
        scopes: Array.isArray(keyRow.scopes) ? keyRow.scopes.map((scope) => String(scope)) : ["read"],
        apiKeyId: String(keyRow.id),
        supabase: service.supabase,
      },
    };
  }

  const auth = await getAuthedClient(req);
  if (!auth.ok) return { ok: false, response: auth.response };

  const { data: tenantId, error: tenantError } = await auth.supabase.rpc("get_user_tenant_id");
  if (tenantError || !tenantId) {
    return { ok: false, response: errorResponse(400, "Could not resolve tenant", tenantError?.message ?? null) };
  }

  return {
    ok: true,
      caller: {
        mode: "jwt",
        tenantId: String(tenantId),
        userId: auth.user.id,
        scopes: ["admin", "read", "write"],
        apiKeyId: null,
        supabase: auth.supabase,
      },
    };
  }

async function enqueueRunDirect(args: {
  caller: Caller;
  agentId: string;
  input: Record<string, unknown>;
  triggerType: string;
  estimatedCredits: number;
  priority: number;
  invokedVia: string;
}) {
  const { caller } = args;

  const [{ data: agent, error: agentError }, { data: entitlementRows, error: entitlementError }] = await Promise.all([
    caller.supabase
      .from("ai_agents")
      .select("id, tenant_id, status")
      .eq("id", args.agentId)
      .eq("tenant_id", caller.tenantId)
      .maybeSingle(),
    caller.supabase.rpc("tenant_entitlements_check", {
      p_capability: "agent_runs",
      p_requested: 1,
      p_tenant_id: caller.tenantId,
    }),
  ]);

  if (agentError) throw new Error(agentError.message);
  if (!agent) throw new Error("Agent not found");
  if (agent.status === "disabled") throw new Error("Agent is disabled");

  if (entitlementError) throw new Error(entitlementError.message);
  const entitlement = entitlementRows?.[0];
  if (entitlement && !entitlement.allowed) throw new Error(String(entitlement.reason ?? "Entitlement denied"));

  const { data: reserveRows, error: reserveError } = await caller.supabase.rpc("reserve_credits", {
    p_estimated_credits: Math.max(1, Math.round(args.estimatedCredits || 10)),
    p_tenant_id: caller.tenantId,
    p_run_id: null,
  });
  if (reserveError) throw new Error(reserveError.message);

  const reserve = reserveRows?.[0];
  if (!reserve?.allowed || !reserve.reservation_id) throw new Error(String(reserve?.reason ?? "Insufficient credits"));

  const triggerType = ["manual", "event", "schedule", "webhook", "api"].includes(args.triggerType)
    ? args.triggerType
    : "manual";

  const { data: run, error: runError } = await caller.supabase
    .from("agent_runs")
    .insert({
      tenant_id: caller.tenantId,
      agent_id: args.agentId,
      requested_by: caller.userId,
      trigger_type: triggerType,
      status: "queued",
      input: args.input,
      reservation_id: reserve.reservation_id,
      queued_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (runError) throw new Error(runError.message);

  const { data: job, error: jobError } = await caller.supabase
    .from("agent_run_jobs")
    .insert({
      tenant_id: caller.tenantId,
      run_id: run.id,
      agent_id: args.agentId,
      queue: "agent-runtime",
      status: "queued",
      priority: Math.max(1, Math.min(100, Math.round(args.priority || 50))),
      payload: {
        input: args.input,
        trigger_type: triggerType,
        invoked_via: args.invokedVia,
      },
      triggered_by: caller.userId,
      scheduled_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (jobError) throw new Error(jobError.message);

  await caller.supabase
    .from("credit_ledger")
    .update({ run_id: run.id })
    .eq("id", reserve.reservation_id);

  return {
    runId: run.id,
    jobId: job.id,
    reservationId: reserve.reservation_id,
    status: "queued",
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: Record<string, unknown> = {};
  try {
    if (req.method !== "GET") {
      body = (await req.json()) as Record<string, unknown>;
    }
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const callerResult = await resolveCaller(req);
  if (!callerResult.ok) return callerResult.response;
  const { caller } = callerResult;

  const route = parseRoute(req, body.route ? String(body.route) : null);
  const method = req.method.toUpperCase();

  if (caller.mode === "api_key" && caller.apiKeyId) {
    await caller.supabase.from("api_key_usage_events").insert({
      tenant_id: caller.tenantId,
      api_key_id: caller.apiKeyId,
      endpoint: route,
      method,
      response_status: null,
      metadata: {},
    });
  }

  try {
    if (method === "POST" && route === "/v1/agents") {
      if (!hasScope(caller.scopes, "agents:write")) return errorResponse(403, "Missing scope agents:write");

      const name = String(body.name ?? "").trim();
      if (!name) return errorResponse(400, "name is required");

      const domain = String(body.domain ?? "operations").trim().toLowerCase() || "operations";
      const baseSlug = slugify(name) || `agent-${crypto.randomUUID().slice(0, 8)}`;
      const slug = `${baseSlug}-${crypto.randomUUID().slice(0, 6)}`;

      const { data, error } = await caller.supabase
        .from("ai_agents")
        .insert({
          tenant_id: caller.tenantId,
          name,
          slug,
          domain,
          description: body.description ? String(body.description) : null,
          status: "draft",
          config: typeof body.config === "object" && body.config !== null ? body.config : {},
          created_by: caller.userId,
        })
        .select("id, name, slug, domain, status, created_at")
        .single();

      if (error) return errorResponse(400, "Could not create agent", error.message);
      return jsonResponse(200, { ok: true, agent: data });
    }

    if (method === "GET" && route === "/v1/agents") {
      if (!hasScope(caller.scopes, "agents:read")) return errorResponse(403, "Missing scope agents:read");

      const { data, error } = await caller.supabase
        .from("ai_agents")
        .select("id, name, slug, domain, description, status, config, created_at, updated_at")
        .eq("tenant_id", caller.tenantId)
        .order("updated_at", { ascending: false })
        .limit(100);

      if (error) return errorResponse(400, "Could not list agents", error.message);
      return jsonResponse(200, { ok: true, agents: data ?? [] });
    }

    if (method === "POST" && /^\/v1\/agents\/[^/]+\/run$/.test(route)) {
      if (!hasScope(caller.scopes, "agent_runs:write")) return errorResponse(403, "Missing scope agent_runs:write");

      const [, , , agentId] = route.split("/");
      const result = await enqueueRunDirect({
        caller,
        agentId,
        input: typeof body.input === "object" && body.input !== null ? (body.input as Record<string, unknown>) : {},
        triggerType: String(body.triggerType ?? "api").toLowerCase(),
        estimatedCredits: Number(body.estimatedCredits ?? 10),
        priority: Number(body.priority ?? 60),
        invokedVia: "api",
      });

      return jsonResponse(200, { ok: true, ...result });
    }

    if (method === "GET" && /^\/v1\/runs\/[^/]+$/.test(route)) {
      if (!hasScope(caller.scopes, "runs:read")) return errorResponse(403, "Missing scope runs:read");

      const [, , , runId] = route.split("/");

      const [{ data: run, error: runError }, { data: steps, error: stepsError }] = await Promise.all([
        caller.supabase
          .from("agent_runs")
          .select("id, agent_id, status, trigger_type, input, output, input_tokens, output_tokens, tool_calls, total_cost_credits, error, queued_at, started_at, completed_at, created_at, updated_at")
          .eq("tenant_id", caller.tenantId)
          .eq("id", runId)
          .maybeSingle(),
        caller.supabase
          .from("agent_run_steps")
          .select("step_index, step_type, status, tool_name, data, latency_ms, cost_credits, created_at")
          .eq("tenant_id", caller.tenantId)
          .eq("run_id", runId)
          .order("step_index", { ascending: true }),
      ]);

      if (runError) return errorResponse(400, "Could not load run", runError.message);
      if (!run) return errorResponse(404, "Run not found");
      if (stepsError) return errorResponse(400, "Could not load run steps", stepsError.message);

      return jsonResponse(200, { ok: true, run, steps: steps ?? [] });
    }

    if (method === "GET" && route === "/v1/runs") {
      if (!hasScope(caller.scopes, "runs:read")) return errorResponse(403, "Missing scope runs:read");

      const url = new URL(req.url);
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 20)));
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

      const { data, error } = await caller.supabase
        .from("agent_runs")
        .select("id, agent_id, status, trigger_type, input_tokens, output_tokens, tool_calls, total_cost_credits, error, queued_at, started_at, completed_at, created_at")
        .eq("tenant_id", caller.tenantId)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) return errorResponse(400, "Could not list runs", error.message);
      return jsonResponse(200, { ok: true, runs: data ?? [], limit, offset });
    }

    if (method === "POST" && route === "/v1/documents") {
      if (!hasScope(caller.scopes, "documents:write")) return errorResponse(403, "Missing scope documents:write");

      const title = String(body.title ?? body.fileName ?? "").trim();
      const fileName = String(body.fileName ?? "").trim();
      const fileType = String(body.fileType ?? "txt").trim().toLowerCase() || "txt";

      if (!title || !fileName) return errorResponse(400, "title and fileName are required");

      const { data, error } = await caller.supabase
        .from("knowledge_documents")
        .insert({
          tenant_id: caller.tenantId,
          uploaded_by: caller.userId,
          title,
          file_name: fileName,
          file_type: fileType,
          source_type: String(body.sourceType ?? "upload"),
          storage_path: body.storagePath ? String(body.storagePath) : null,
          external_url: body.externalUrl ? String(body.externalUrl) : null,
          excerpt: body.excerpt ? String(body.excerpt) : null,
          status: "processing",
        })
        .select("id, title, file_name, file_type, status, created_at")
        .single();

      if (error) return errorResponse(400, "Could not create document", error.message);
      return jsonResponse(200, { ok: true, document: data });
    }

    if (method === "POST" && route === "/v1/api-keys") {
      if (caller.mode !== "jwt") return errorResponse(403, "API key creation requires user JWT context");
      if (!hasScope(caller.scopes, "api_keys:write")) return errorResponse(403, "Missing scope api_keys:write");

      const name = String(body.name ?? "").trim();
      if (!name) return errorResponse(400, "name is required");

      const scopes = Array.isArray(body.scopes) ? body.scopes.map((scope) => String(scope)) : ["read"];
      const environment = ["production", "development", "testing"].includes(String(body.environment ?? "").toLowerCase())
        ? String(body.environment).toLowerCase()
        : "production";
      const expiresAt = body.expiresAt ? String(body.expiresAt) : null;

      const { data, error } = await caller.supabase.rpc("create_api_key_v2", {
        p_name: name,
        p_scopes: scopes,
        p_environment: environment,
        p_expires_at: expiresAt,
      });

      if (error) return errorResponse(400, "Could not create API key", error.message);
      return jsonResponse(200, { ok: true, apiKey: data?.[0] ?? null });
    }

    if (method === "GET" && route === "/v1/usage") {
      if (!hasScope(caller.scopes, "usage:read")) return errorResponse(403, "Missing scope usage:read");

      const url = new URL(req.url);
      const windowDays = Math.max(1, Math.min(365, Number(url.searchParams.get("windowDays") ?? 30)));

      const { data, error } = await caller.supabase.rpc("get_usage_summary", {
        p_tenant_id: caller.tenantId,
        p_window_days: windowDays,
      });

      if (error) return errorResponse(400, "Could not load usage summary", error.message);
      return jsonResponse(200, { ok: true, usage: data ?? {} });
    }

    return errorResponse(404, "Unsupported route", { route, method });
  } catch (error) {
    return errorResponse(500, "API gateway failed", error instanceof Error ? error.message : null);
  }
});
