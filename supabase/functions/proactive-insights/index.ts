/**
 * proactive-insights: Hourly worker-triggered executive summary generation.
 *
 * Called by the connector worker once per hour (INSIGHT_DISPATCH_INTERVAL_MS).
 * Finds all active tenants (those with agent runs in the last 24 h) and generates
 * an AI-powered executive briefing for each, stored in anomaly_insights.
 *
 * Authentication: X-Worker-Token header (same mechanism as credential-refresh-dispatch).
 */
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { requireWorkerToken, getServiceClient } from "../_shared/service.ts";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

type ServiceClient = Extract<ReturnType<typeof getServiceClient>, { ok: true }>;

async function generateInsightForTenant(
  svc: ServiceClient,
  tenantId: string,
): Promise<{ ok: boolean; error?: string }> {
  const since = new Date(Date.now() - 86_400_000).toISOString();

  // Skip if we already generated a proactive briefing today for this tenant
  const { data: existing } = await svc.supabase
    .from("anomaly_insights")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("title", "Executive Daily Briefing")
    .gte("detected_at", since)
    .limit(1)
    .maybeSingle();

  if (existing) return { ok: true }; // already done today

  const [agentRunsResult, approvalsResult, connectionsResult, anomaliesResult] = await Promise.all([
    svc.supabase
      .from("agent_runs")
      .select("status, input_tokens, output_tokens")
      .eq("tenant_id", tenantId)
      .gte("created_at", since)
      .limit(100),
    svc.supabase
      .from("approval_requests")
      .select("risk_level, status")
      .eq("tenant_id", tenantId)
      .gte("created_at", since),
    svc.supabase
      .from("api_connections")
      .select("sync_status")
      .eq("tenant_id", tenantId),
    svc.supabase
      .from("anomaly_insights")
      .select("severity, insight_category")
      .eq("tenant_id", tenantId)
      .eq("status", "new")
      .gte("detected_at", since),
  ]);

  const runs       = (agentRunsResult.data   ?? []) as Record<string, unknown>[];
  const approvals  = (approvalsResult.data   ?? []) as Record<string, unknown>[];
  const conns      = (connectionsResult.data ?? []) as Record<string, unknown>[];
  const anomalies  = (anomaliesResult.data   ?? []) as Record<string, unknown>[];

  const stats = {
    runs: {
      total:   runs.length,
      success: runs.filter((r) => r.status === "success").length,
      failed:  runs.filter((r) => r.status === "failed").length,
      tokens:  runs.reduce((s, r) => s + (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0), 0),
    },
    approvals: {
      pending:  approvals.filter((a) => a.status === "pending").length,
      highRisk: approvals.filter((a) => ["HIGH", "CRITICAL"].includes(String(a.risk_level ?? ""))).length,
    },
    connections: {
      total:   conns.length,
      healthy: conns.filter((c) => c.sync_status === "healthy").length,
      error:   conns.filter((c) => c.sync_status === "error").length,
    },
    anomalies: {
      total:    anomalies.length,
      critical: anomalies.filter((a) => a.severity === "critical").length,
      high:     anomalies.filter((a) => a.severity === "high").length,
    },
  };

  // Rule-based fallback summary (used when AI call fails or no runs exist)
  const healthPct = stats.connections.total > 0
    ? Math.round((stats.connections.healthy / stats.connections.total) * 100)
    : 100;
  const successPct = stats.runs.total > 0
    ? Math.round((stats.runs.success / stats.runs.total) * 100)
    : 100;

  let insightText =
    `📊 **Daily Briefing** — ${stats.runs.total} agent runs (${successPct}% success), ` +
    `${stats.approvals.pending} pending approvals, ${healthPct}% connections healthy.\n` +
    (stats.anomalies.total > 0
      ? `⚠️ ${stats.anomalies.total} active anomalies (${stats.anomalies.critical} critical, ${stats.anomalies.high} high) require attention.\n`
      : `✅ No active anomalies detected in the last 24 hours.\n`) +
    (stats.approvals.highRisk > 0
      ? `🔴 ${stats.approvals.highRisk} high/critical risk actions awaiting governance review.`
      : `🟢 No high-risk approvals pending.`);

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (apiKey && stats.runs.total > 0) {
    try {
      const resp = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "You are an enterprise AI operations analyst. Generate 2-3 crisp bullet executive insights. " +
                "Each bullet starts with an emoji. Be specific with numbers. Focus on risk, trend, and opportunity.",
            },
            { role: "user", content: `Last 24h operational data: ${JSON.stringify(stats)}` },
          ],
          max_tokens: 250,
          temperature: 0.5,
        }),
      });
      if (resp.ok) {
        const json = await resp.json() as { choices: Array<{ message: { content: string } }> };
        insightText = json.choices[0]?.message?.content ?? insightText;
      }
    } catch {
      // Keep rule-based fallback
    }
  }

  const severity =
    stats.anomalies.critical > 0 || stats.approvals.highRisk > 0 ? "high" :
    stats.anomalies.high > 0 ? "medium" : "low";

  const { error } = await svc.supabase.from("anomaly_insights").insert({
    tenant_id:           tenantId,
    severity,
    title:               "Executive Daily Briefing",
    description:         insightText,
    insight_category:    "trend",
    recommended_actions: [],
    status:              "new",
    detected_at:         new Date().toISOString(),
    metadata:            { stats, generated_by: "proactive_worker", source: "hourly_cron" },
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const workerAuth = requireWorkerToken(req);
  if (!workerAuth.ok) return workerAuth.response;

  const svc = getServiceClient();
  if (!svc.ok) return svc.response;

  // Active tenants = those with agent runs in the last 24 h
  const { data: recentRuns, error: queryError } = await svc.supabase
    .from("agent_runs")
    .select("tenant_id")
    .gte("created_at", new Date(Date.now() - 86_400_000).toISOString())
    .limit(500);

  if (queryError) return errorResponse(500, "Failed to query active tenants", queryError.message);

  const tenantIds = [...new Set(
    (recentRuns ?? []).map((r: Record<string, unknown>) => String(r.tenant_id)),
  )];

  const results: Array<{ tenantId: string; ok: boolean; error?: string }> = [];

  for (const tenantId of tenantIds) {
    const result = await generateInsightForTenant(svc, tenantId).catch((err) => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }));
    results.push({ tenantId, ...result });
  }

  const succeeded = results.filter((r) => r.ok).length;
  console.log(`[proactive-insights] Generated ${succeeded}/${results.length} tenant briefings`);

  return jsonResponse(200, { ok: true, processed: results.length, succeeded, results });
});
