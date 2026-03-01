/**
 * predictive-refresh: Hourly worker-triggered predictive anomaly detection.
 *
 * Calls refresh_predictive_insights_for_tenant() for every active tenant
 * (those with agent_runs or chat_messages in the last 48 h). Uses the full
 * Z-score / deviation SQL engine — not the legacy TS predictiveEngine.
 *
 * Authentication: X-Worker-Token header (same as proactive-insights).
 */
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { requireWorkerToken, getServiceClient } from "../_shared/service.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const workerAuth = requireWorkerToken(req);
  if (!workerAuth.ok) return workerAuth.response;

  const svc = getServiceClient();
  if (!svc.ok) return svc.response;

  // Active tenants = those with agent_runs OR chat sessions in the last 48 h
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data: agentRows, error: agentErr } = await svc.supabase
    .from("agent_runs")
    .select("tenant_id")
    .gte("created_at", since)
    .limit(500);

  if (agentErr) return errorResponse(500, "Failed to query active tenants", agentErr.message);

  const { data: chatRows } = await svc.supabase
    .from("chat_sessions")
    .select("tenant_id")
    .gte("created_at", since)
    .limit(500);

  const tenantIds = [
    ...new Set([
      ...(agentRows ?? []).map((r: Record<string, unknown>) => String(r.tenant_id)),
      ...(chatRows ?? []).map((r: Record<string, unknown>) => String(r.tenant_id)),
    ]),
  ].filter(Boolean);

  if (tenantIds.length === 0) {
    return jsonResponse(200, { ok: true, processed: 0, succeeded: 0, results: [] });
  }

  const results: Array<{ tenantId: string; ok: boolean; generated?: number; resolved?: number; error?: string }> = [];

  for (const tenantId of tenantIds) {
    try {
      const { data, error } = await svc.supabase.rpc("refresh_predictive_insights_for_tenant", {
        p_tenant_id: tenantId,
        p_force: false,
      });

      if (error) {
        results.push({ tenantId, ok: false, error: error.message });
      } else {
        const payload = data as { generated?: number; resolved?: number } | null;
        results.push({
          tenantId,
          ok: true,
          generated: payload?.generated ?? 0,
          resolved: payload?.resolved ?? 0,
        });
      }
    } catch (err) {
      results.push({
        tenantId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  const totalGenerated = results.reduce((s, r) => s + (r.generated ?? 0), 0);
  const totalResolved = results.reduce((s, r) => s + (r.resolved ?? 0), 0);

  console.log(
    `[predictive-refresh] ${succeeded}/${results.length} tenants refreshed — ` +
    `${totalGenerated} anomalies generated, ${totalResolved} resolved`,
  );

  return jsonResponse(200, {
    ok: true,
    processed: results.length,
    succeeded,
    totalGenerated,
    totalResolved,
    results,
  });
});
