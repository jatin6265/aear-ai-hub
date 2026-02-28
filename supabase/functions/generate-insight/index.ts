/**
 * generate-insight: AI-powered insight generation from usage patterns.
 *
 * Analyzes agent runs, token usage, approval patterns, and connection health
 * to generate actionable business insights for the tenant dashboard.
 *
 * Can be called:
 * - Manually from the insights dashboard
 * - Scheduled via pg_cron (hourly)
 * - Triggered by anomaly detection
 */
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/service.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

async function callOpenAI(
  messages: Array<{ role: string; content: string }>,
  model = "gpt-4o-mini",
  maxTokens = 300
): Promise<string> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.6,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${err}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message?.content ?? "";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  const { supabase, tenantId, userId } = auth;

  let body: { insightType?: string; period?: string } = {};
  try {
    body = await req.json() as typeof body;
  } catch {
    // Use defaults
  }

  const insightType = String(body.insightType ?? "general").toLowerCase();
  const period = String(body.period ?? "7d");

  // Calculate time range
  const periodMs: Record<string, number> = {
    "1d": 86400000,
    "7d": 7 * 86400000,
    "30d": 30 * 86400000,
  };
  const lookbackMs = periodMs[period] ?? periodMs["7d"];
  const since = new Date(Date.now() - lookbackMs).toISOString();

  const service = getServiceClient();
  if (!service.ok) return service.response;

  try {
    // Gather usage data
    const [agentRunsResult, billingResult, approvalsResult, connectionsResult] = await Promise.all([
      service.supabase
        .from("agent_runs")
        .select("status, input_tokens, output_tokens, duration_ms, created_at")
        .eq("tenant_id", tenantId)
        .gte("created_at", since)
        .limit(200),
      service.supabase
        .from("billing_events")
        .select("tokens_used, cost_usd, event_type, created_at")
        .eq("tenant_id", tenantId)
        .gte("created_at", since)
        .limit(200),
      service.supabase
        .from("approval_requests")
        .select("risk_level, status, created_at")
        .eq("tenant_id", tenantId)
        .gte("created_at", since),
      service.supabase
        .from("api_connections")
        .select("connection_type, sync_status, last_sync_at")
        .eq("tenant_id", tenantId),
    ]);

    const agentRuns = agentRunsResult.data ?? [];
    const billingEvents = billingResult.data ?? [];
    const approvals = approvalsResult.data ?? [];
    const connections = connectionsResult.data ?? [];

    // Compute summary stats
    const stats = {
      period,
      agent_runs: {
        total: agentRuns.length,
        successful: agentRuns.filter((r: Record<string, unknown>) => r.status === "success").length,
        failed: agentRuns.filter((r: Record<string, unknown>) => r.status === "failed").length,
        avg_duration_ms: agentRuns.length > 0
          ? Math.round(agentRuns.reduce((s: number, r: Record<string, unknown>) => s + (Number(r.duration_ms) || 0), 0) / agentRuns.length)
          : 0,
        total_tokens: agentRuns.reduce((s: number, r: Record<string, unknown>) =>
          s + (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0), 0),
      },
      billing: {
        total_cost: billingEvents.reduce((s: number, e: Record<string, unknown>) => s + (Number(e.cost_usd) || 0), 0),
        total_tokens: billingEvents.reduce((s: number, e: Record<string, unknown>) => s + (Number(e.tokens_used) || 0), 0),
        event_count: billingEvents.length,
      },
      approvals: {
        total: approvals.length,
        pending: approvals.filter((a: Record<string, unknown>) => a.status === "pending").length,
        approved: approvals.filter((a: Record<string, unknown>) => a.status === "approved").length,
        rejected: approvals.filter((a: Record<string, unknown>) => a.status === "rejected").length,
        high_critical: approvals.filter((a: Record<string, unknown>) =>
          a.risk_level === "HIGH" || a.risk_level === "CRITICAL"
        ).length,
      },
      connections: {
        total: connections.length,
        healthy: connections.filter((c: Record<string, unknown>) => c.sync_status === "healthy").length,
        error: connections.filter((c: Record<string, unknown>) => c.sync_status === "error").length,
      },
    };

    // Generate insight using AI
    const systemPrompt = `You are OpsAI's enterprise analytics engine. Generate concise, actionable business insights.
Format: 2-4 bullet points, each starting with an emoji and being 1-2 sentences.
Focus on: trends, anomalies, risks, and opportunities. Be specific with numbers.`;

    const userPrompt = `Generate insights for an enterprise AI operations platform. Period: last ${period}.
Data: ${JSON.stringify(stats, null, 2)}
Insight type requested: ${insightType}`;

    const insightText = await callOpenAI([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);

    // Store the generated insight
    const { data: savedInsight, error: saveError } = await service.supabase
      .from("anomaly_insights")
      .insert({
        tenant_id: tenantId,
        severity: "low",
        title: `AI Platform Insight — Last ${period}`,
        description: insightText,
        recommended_actions: [],
        status: "new",
        detected_at: new Date().toISOString(),
        metadata: { stats, insight_type: insightType, generated_by: userId },
      })
      .select("id")
      .single();

    if (saveError) {
      console.warn("Failed to save insight:", saveError.message);
    }

    return jsonResponse(200, {
      insight: insightText,
      stats,
      insight_id: (savedInsight as Record<string, unknown> | null)?.id ?? null,
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("generate-insight error:", message);
    return errorResponse(500, `Failed to generate insight: ${message}`);
  }
});
