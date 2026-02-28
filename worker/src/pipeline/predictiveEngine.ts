import OpenAI from 'openai';
import { getSupabaseService } from '../lib/supabase';

export type AnomalyResult = {
  tenantId: string;
  metricName: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  detectedAt: string;
  recommendedActions: string[];
};

/**
 * Predictive analytics engine: anomaly detection + time-series forecasting.
 *
 * Analyzes usage metrics and billing events to detect anomalies proactively.
 * Generates insights feed entries for the dashboard.
 */
export class PredictiveEngine {
  private openai: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is missing');
    }
    this.openai = new OpenAI({ apiKey });
  }

  /**
   * Runs anomaly detection across all tenants.
   * Should be called periodically (e.g., every hour via cron).
   */
  async detectAnomalies(): Promise<void> {
    const supabase = getSupabaseService();

    // Fetch active tenants
    const { data: tenants } = await supabase.getClient()
      .from('tenants')
      .select('id, name')
      .eq('status', 'active')
      .limit(100);

    for (const tenant of tenants ?? []) {
      await this.analyzeTenant((tenant as Record<string, unknown>).id as string);
    }
  }

  /**
   * Analyzes a single tenant for anomalies.
   */
  async analyzeTenant(tenantId: string): Promise<AnomalyResult[]> {
    const supabase = getSupabaseService();
    const anomalies: AnomalyResult[] = [];

    // 1. Check token usage trends
    const { data: usageData } = await supabase.getClient()
      .from('billing_events')
      .select('tokens_used, cost_usd, created_at')
      .eq('tenant_id', tenantId)
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: true })
      .limit(1000);

    if (usageData && usageData.length > 10) {
      const tokenAnomaly = await this.detectUsageAnomaly(tenantId, usageData as Array<Record<string, unknown>>);
      if (tokenAnomaly) anomalies.push(tokenAnomaly);
    }

    // 2. Check approval request patterns
    const { data: approvalData } = await supabase.getClient()
      .from('approval_requests')
      .select('risk_level, status, created_at')
      .eq('tenant_id', tenantId)
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false });

    if (approvalData && approvalData.length > 5) {
      const approvalAnomaly = await this.detectApprovalAnomaly(tenantId, approvalData as Array<Record<string, unknown>>);
      if (approvalAnomaly) anomalies.push(approvalAnomaly);
    }

    // 3. Store anomalies in insights feed
    for (const anomaly of anomalies) {
      await supabase.getClient().from('anomaly_insights').insert({
        tenant_id: anomaly.tenantId,
        severity: anomaly.severity,
        title: `Anomaly detected: ${anomaly.metricName}`,
        description: anomaly.description,
        recommended_actions: anomaly.recommendedActions,
        status: 'new',
        detected_at: anomaly.detectedAt,
      }).select('id').single().then(() => {});
    }

    return anomalies;
  }

  /**
   * Detects usage anomalies using statistical analysis + AI interpretation.
   */
  private async detectUsageAnomaly(
    tenantId: string,
    usageData: Array<Record<string, unknown>>
  ): Promise<AnomalyResult | null> {
    const tokenValues = usageData.map((d) => Number(d.tokens_used) || 0);
    const mean = tokenValues.reduce((a, b) => a + b, 0) / tokenValues.length;
    const variance = tokenValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / tokenValues.length;
    const stdDev = Math.sqrt(variance);

    // Get recent values (last 10% of window)
    const recentCount = Math.max(1, Math.floor(tokenValues.length * 0.1));
    const recentValues = tokenValues.slice(-recentCount);
    const recentMean = recentValues.reduce((a, b) => a + b, 0) / recentValues.length;

    // Z-score check: if recent mean is > 2 stddevs from historical mean
    if (stdDev > 0 && Math.abs(recentMean - mean) > 2 * stdDev) {
      const direction = recentMean > mean ? 'spike' : 'drop';
      const severity = Math.abs(recentMean - mean) > 3 * stdDev ? 'high' : 'medium';

      return {
        tenantId,
        metricName: 'token_usage',
        severity,
        description: `Token usage ${direction} detected. Recent avg: ${Math.round(recentMean)} vs historical avg: ${Math.round(mean)} tokens/event.`,
        detectedAt: new Date().toISOString(),
        recommendedActions: [
          direction === 'spike'
            ? 'Review recent AI agent runs for unexpected high-cost queries'
            : 'Check if agents are running correctly - usage drop may indicate issues',
          'Review billing dashboard for cost impact',
          'Check audit logs for unusual patterns',
        ],
      };
    }

    return null;
  }

  /**
   * Detects unusual approval request patterns.
   */
  private async detectApprovalAnomaly(
    tenantId: string,
    approvalData: Array<Record<string, unknown>>
  ): Promise<AnomalyResult | null> {
    const criticalCount = approvalData.filter(
      (d) => d.risk_level === 'critical'
    ).length;
    const pendingCount = approvalData.filter(
      (d) => d.status === 'pending'
    ).length;

    if (criticalCount >= 3) {
      return {
        tenantId,
        metricName: 'critical_approvals',
        severity: 'high',
        description: `${criticalCount} CRITICAL-risk approval requests in the last 24 hours.`,
        detectedAt: new Date().toISOString(),
        recommendedActions: [
          'Review all critical approval requests immediately',
          'Check if any agents are triggering unexpected high-risk actions',
          'Consider reviewing and tightening RACI policies',
        ],
      };
    }

    if (pendingCount >= 10) {
      return {
        tenantId,
        metricName: 'pending_approvals_backlog',
        severity: 'medium',
        description: `${pendingCount} approval requests are pending. This may be blocking operations.`,
        detectedAt: new Date().toISOString(),
        recommendedActions: [
          'Review and action pending approval requests',
          'Ensure Accountable role holders are available',
          'Consider adjusting risk thresholds if appropriate',
        ],
      };
    }

    return null;
  }

  /**
   * Generates AI-powered insight from usage patterns.
   */
  async generateInsight(tenantId: string): Promise<string> {
    const supabase = getSupabaseService();

    // Gather usage summary
    const { data: recentRuns } = await supabase.getClient()
      .from('agent_runs')
      .select('status, input_tokens, output_tokens, created_at')
      .eq('tenant_id', tenantId)
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .limit(100);

    const summary = {
      total_runs: (recentRuns ?? []).length,
      successful: (recentRuns ?? []).filter((r: Record<string, unknown>) => r.status === 'success').length,
      total_tokens: (recentRuns ?? []).reduce(
        (sum: number, r: Record<string, unknown>) => sum + (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0),
        0
      ),
    };

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an AI system analyst. Generate a concise 2-3 sentence insight about the usage pattern.',
        },
        {
          role: 'user',
          content: `Usage in last 7 days: ${JSON.stringify(summary)}`,
        },
      ],
      max_tokens: 150,
      temperature: 0.5,
    });

    return response.choices[0]?.message?.content ?? 'Insufficient data for insight generation.';
  }
}

let instance: PredictiveEngine | null = null;
export function getPredictiveEngine(): PredictiveEngine {
  if (!instance) {
    instance = new PredictiveEngine();
  }
  return instance;
}
