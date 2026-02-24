import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let runId = "";
  try {
    const body = (await req.json()) as { runId?: string };
    runId = String(body.runId ?? "").trim();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!runId) return errorResponse(400, "runId is required");

  const { data: run, error: runError } = await auth.supabase
    .from("agent_runs")
    .select("id, tenant_id, agent_id, session_id, requested_by, trigger_type, status, input, output, input_tokens, output_tokens, tool_calls, total_cost_credits, reservation_id, error, queued_at, started_at, completed_at, created_at, updated_at")
    .eq("id", runId)
    .maybeSingle();

  if (runError) return errorResponse(400, "Could not load run", runError.message);
  if (!run) return errorResponse(404, "Run not found");

  const [{ data: steps, error: stepsError }, { data: jobs, error: jobsError }] = await Promise.all([
    auth.supabase.rpc("list_agent_run_replay", { p_run_id: runId }),
    auth.supabase
      .from("agent_run_jobs")
      .select("id, status, attempt_count, max_attempts, worker_id, last_error, scheduled_at, started_at, finished_at, updated_at")
      .eq("run_id", runId)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  if (stepsError) return errorResponse(400, "Could not load run steps", stepsError.message);
  if (jobsError) return errorResponse(400, "Could not load run job", jobsError.message);

  return jsonResponse(200, {
    ok: true,
    run,
    steps: steps ?? [],
    job: jobs?.[0] ?? null,
  });
});
