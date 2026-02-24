import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import {
  AlertTriangle,
  ArrowRight,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip } from "recharts";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdge } from "@/lib/edge-invoke";
import { cn } from "@/lib/utils";

type InsightTab = "all" | "anomalies" | "forecasts" | "sla_risks" | "positive";

type SourceOption = {
  id: string;
  name: string;
  type: string;
  status: string;
};

type AlertInsight = {
  id: string;
  title: string;
  severity: string;
  metricName: string | null;
  metricValue: number | null;
  detectedAt: string;
  actionPrompt: string;
  dataSource: string;
};

type FeedInsight = {
  id: string;
  title: string;
  description: string;
  severity: string;
  category: string;
  metricName: string | null;
  metricValue: number | null;
  metricPreviousValue: number | null;
  confidenceScore: number;
  dataSource: string;
  connectionId: string | null;
  connectionName: string | null;
  connectionType: string | null;
  sparkline: number[];
  actionPrompt: string;
  status: string;
  detectedAt: string;
};

type InsightsPayload = {
  tab: InsightTab;
  sourceId: string | null;
  lastUpdatedAt: string | null;
  counts: {
    activeInsights: number;
    totalInsights: number;
    connectionsCount: number;
  };
  alerts: AlertInsight[];
  insights: FeedInsight[];
  dismissedInsights: FeedInsight[];
  sources: SourceOption[];
};

const EMPTY_PAYLOAD: InsightsPayload = {
  tab: "all",
  sourceId: null,
  lastUpdatedAt: null,
  counts: {
    activeInsights: 0,
    totalInsights: 0,
    connectionsCount: 0,
  },
  alerts: [],
  insights: [],
  dismissedInsights: [],
  sources: [],
};

const TAB_OPTIONS: Array<{ key: InsightTab; label: string }> = [
  { key: "all", label: "All" },
  { key: "anomalies", label: "Anomalies" },
  { key: "forecasts", label: "Forecasts" },
  { key: "sla_risks", label: "SLA Risks" },
  { key: "positive", label: "Positive" },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeTab(value: unknown): InsightTab {
  const tab = String(value ?? "").trim().toLowerCase();
  if (tab === "anomalies" || tab === "forecasts" || tab === "sla_risks" || tab === "positive") return tab;
  return "all";
}

function toSparkline(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((point) => toNumber(point)).filter((point) => Number.isFinite(point));
}

function normalizeInsight(value: unknown): FeedInsight | null {
  const row = asRecord(value);
  if (!row) return null;
  const id = String(row.id ?? "").trim();
  if (!id) return null;
  return {
    id,
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    severity: String(row.severity ?? "medium").toLowerCase(),
    category: String(row.category ?? "trend").toLowerCase(),
    metricName: row.metricName ? String(row.metricName) : null,
    metricValue: row.metricValue === null || row.metricValue === undefined ? null : toNumber(row.metricValue),
    metricPreviousValue:
      row.metricPreviousValue === null || row.metricPreviousValue === undefined ? null : toNumber(row.metricPreviousValue),
    confidenceScore: toNumber(row.confidenceScore, 80),
    dataSource: String(row.dataSource ?? "Unknown source"),
    connectionId: row.connectionId ? String(row.connectionId) : null,
    connectionName: row.connectionName ? String(row.connectionName) : null,
    connectionType: row.connectionType ? String(row.connectionType) : null,
    sparkline: toSparkline(row.sparkline),
    actionPrompt: String(row.actionPrompt ?? "Investigate this insight and propose next best action."),
    status: String(row.status ?? "open").toLowerCase(),
    detectedAt: String(row.detectedAt ?? new Date().toISOString()),
  };
}

function normalizePayload(value: unknown): InsightsPayload {
  const raw = asRecord(value);
  if (!raw) return EMPTY_PAYLOAD;

  const countsRaw = asRecord(raw.counts);
  const alerts = Array.isArray(raw.alerts)
    ? raw.alerts
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const id = String(row.id ?? "").trim();
          if (!id) return null;
          return {
            id,
            title: String(row.title ?? ""),
            severity: String(row.severity ?? "high").toLowerCase(),
            metricName: row.metricName ? String(row.metricName) : null,
            metricValue: row.metricValue === null || row.metricValue === undefined ? null : toNumber(row.metricValue),
            detectedAt: String(row.detectedAt ?? new Date().toISOString()),
            actionPrompt: String(row.actionPrompt ?? "Investigate and recommend immediate next action."),
            dataSource: String(row.dataSource ?? "Unknown source"),
          } satisfies AlertInsight;
        })
        .filter((item): item is AlertInsight => Boolean(item))
    : [];

  const sources = Array.isArray(raw.sources)
    ? raw.sources
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const id = String(row.id ?? "").trim();
          if (!id) return null;
          return {
            id,
            name: String(row.name ?? "Unknown"),
            type: String(row.type ?? "unknown"),
            status: String(row.status ?? "active"),
          } satisfies SourceOption;
        })
        .filter((item): item is SourceOption => Boolean(item))
    : [];

  const insights = Array.isArray(raw.insights)
    ? raw.insights.map(normalizeInsight).filter((item): item is FeedInsight => Boolean(item))
    : [];

  const dismissedInsights = Array.isArray(raw.dismissedInsights)
    ? raw.dismissedInsights.map(normalizeInsight).filter((item): item is FeedInsight => Boolean(item))
    : [];

  return {
    tab: normalizeTab(raw.tab),
    sourceId: raw.sourceId ? String(raw.sourceId) : null,
    lastUpdatedAt: raw.lastUpdatedAt ? String(raw.lastUpdatedAt) : null,
    counts: {
      activeInsights: toNumber(countsRaw?.activeInsights, 0),
      totalInsights: toNumber(countsRaw?.totalInsights, 0),
      connectionsCount: toNumber(countsRaw?.connectionsCount, 0),
    },
    alerts,
    insights,
    dismissedInsights,
    sources,
  };
}

function getRelative(value: string | null) {
  if (!value) return "just now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "just now";
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

function getCategoryLabel(category: string) {
  switch (category) {
    case "anomaly":
      return "Anomaly";
    case "forecast":
      return "Forecast";
    case "opportunity":
      return "Opportunity";
    case "sla_risk":
      return "SLA Risk";
    case "positive":
      return "Positive";
    default:
      return "Trend";
  }
}

function getCategoryIcon(category: string) {
  if (category === "anomaly") return AlertTriangle;
  if (category === "forecast") return TrendingUp;
  if (category === "sla_risk") return ShieldAlert;
  if (category === "positive") return Sparkles;
  return TrendingUp;
}

function getSeverityTone(severity: string) {
  if (severity === "critical") return "text-red-700";
  if (severity === "high") return "text-amber-700";
  if (severity === "low") return "text-emerald-700";
  return "text-slate-700";
}

function getLeftBarClass(insight: FeedInsight) {
  if (insight.category === "anomaly") return "bg-red-500";
  if (insight.category === "forecast" || insight.category === "sla_risk") return "bg-amber-500";
  if (insight.category === "positive") return "bg-emerald-500";
  return "bg-blue-500";
}

function getConfidenceLabel(score: number) {
  if (score >= 90) return "High confidence";
  if (score >= 75) return "Medium confidence";
  return "Based on limited data";
}

function formatMetric(value: number | null) {
  if (value === null) return "N/A";
  if (Math.abs(value) >= 1000) return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  if (Math.abs(value) % 1 !== 0) return value.toFixed(2);
  return String(value);
}

function buildSparklineData(values: number[]) {
  return values.map((value, index) => ({ index, value }));
}

export default function Insights() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [payload, setPayload] = useState<InsightsPayload>(EMPTY_PAYLOAD);
  const [tab, setTab] = useState<InsightTab>("all");
  const [sourceId, setSourceId] = useState<string>("all");
  const [showDismissed, setShowDismissed] = useState(false);

  const loadPayload = useCallback(
    async (params: { tab?: InsightTab; sourceId?: string; includeDismissed?: boolean; operation?: "get_payload" | "refresh" | "dismiss"; insightId?: string } = {}) => {
      const nextTab = params.tab ?? tab;
      const nextSourceId = params.sourceId ?? sourceId;
      const includeDismissed = params.includeDismissed ?? showDismissed;
      const operation = params.operation ?? "get_payload";

      const invokeBody: Record<string, unknown> = {
        operation,
        tab: nextTab,
        sourceId: nextSourceId === "all" ? "" : nextSourceId,
        includeDismissed,
      };
      if (params.insightId) invokeBody.insightId = params.insightId;

      const { data, error } = await invokeEdge("insights-feed", { body: invokeBody });
      if (error) throw error;
      const parsed = normalizePayload(asRecord(data)?.payload);
      setPayload(parsed);
      return parsed;
    },
    [showDismissed, sourceId, tab],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadPayload()
      .catch((error) => {
        if (!active) return;
        toast({
          title: "Could not load insights feed",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadPayload, toast]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await loadPayload({ operation: "refresh" });
    } catch (error) {
      toast({
        title: "Could not refresh insights",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setRefreshing(false);
    }
  };

  const onTabChange = async (nextTab: InsightTab) => {
    if (nextTab === tab) return;
    setTab(nextTab);
    setLoading(true);
    try {
      await loadPayload({ tab: nextTab, sourceId, includeDismissed: showDismissed });
    } catch (error) {
      toast({
        title: "Could not change filter",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const onSourceChange = async (nextSourceId: string) => {
    setSourceId(nextSourceId);
    setLoading(true);
    try {
      await loadPayload({ tab, sourceId: nextSourceId, includeDismissed: showDismissed });
    } catch (error) {
      toast({
        title: "Could not change source filter",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const dismissInsight = async (insightId: string) => {
    setDismissingId(insightId);
    try {
      await loadPayload({
        operation: "dismiss",
        insightId,
        tab,
        sourceId,
        includeDismissed: showDismissed,
      });
      toast({
        title: "Insight dismissed",
        description: "You can review it in dismissed history.",
      });
    } catch (error) {
      toast({
        title: "Could not dismiss insight",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setDismissingId(null);
    }
  };

  const dismissedInsights = useMemo(() => payload.dismissedInsights, [payload.dismissedInsights]);

  const insightCountText = `${payload.counts.activeInsights} active insights across ${payload.counts.connectionsCount} connection${payload.counts.connectionsCount === 1 ? "" : "s"}`;

  return (
    <div className="space-y-6 pb-8">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">AI Insights</h1>
          <p className="mt-1 text-sm text-slate-600">{insightCountText}</p>
        </div>
        <div className="flex items-center gap-2">
          <p className="text-xs text-slate-500">Updated {getRelative(payload.lastUpdatedAt)}</p>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </header>

      {payload.alerts.length > 0 ? (
        <section className="space-y-3">
          {payload.alerts.slice(0, 3).map((alert) => {
            const critical = alert.severity === "critical";
            return (
              <article
                key={alert.id}
                className={cn(
                  "rounded-xl border p-4",
                  critical ? "border-red-300 bg-red-50" : "border-amber-300 bg-amber-50",
                )}
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className={cn("text-sm font-semibold", critical ? "text-red-900" : "text-amber-900")}>{alert.title}</p>
                    <p className={cn("mt-1 text-xs", critical ? "text-red-800" : "text-amber-800")}>
                      {alert.metricName ? `${alert.metricName}: ${formatMetric(alert.metricValue)}` : "High priority signal"} · Detected {getRelative(alert.detectedAt)}
                    </p>
                  </div>
                  <Button size="sm" asChild>
                    <Link to={`/dashboard/chat?q=${encodeURIComponent(alert.actionPrompt)}`}>Investigate</Link>
                  </Button>
                </div>
              </article>
            );
          })}
        </section>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2">
            {TAB_OPTIONS.map((tabOption) => (
              <button
                key={tabOption.key}
                type="button"
                onClick={() => void onTabChange(tabOption.key)}
                className={cn(
                  "rounded-full px-3 py-1.5 text-xs font-medium transition",
                  tab === tabOption.key ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200",
                )}
              >
                {tabOption.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500" htmlFor="insights-source-filter">
              Data source
            </label>
            <select
              id="insights-source-filter"
              value={sourceId}
              onChange={(event) => void onSourceChange(event.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700"
            >
              <option value="all">All sources</option>
              {payload.sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, index) => <Skeleton key={`insight-skeleton-${index}`} className="h-48 w-full rounded-xl" />)
        ) : payload.insights.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            No active insights for this filter.
          </div>
        ) : (
          payload.insights.map((insight) => {
            const CategoryIcon = getCategoryIcon(insight.category);
            const sparklineData = buildSparklineData(insight.sparkline);

            return (
              <article key={insight.id} className="relative overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <div className={cn("absolute left-0 top-0 h-full w-1.5", getLeftBarClass(insight))} />
                <div className="space-y-4 p-4 pl-6">
                  <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className="flex items-center gap-2 text-xs font-medium text-slate-600">
                        <CategoryIcon className="h-3.5 w-3.5" />
                        {getCategoryLabel(insight.category)}
                      </p>
                      <h2 className="mt-1 text-base font-semibold text-slate-900">{insight.title}</h2>
                      <p className="mt-1 text-sm text-slate-700">{insight.description}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className="border-0 bg-slate-100 text-slate-800">
                        {getConfidenceLabel(insight.confidenceScore)} ({Math.round(insight.confidenceScore)}%)
                      </Badge>
                      <Badge className="border-0 bg-blue-100 text-blue-800">{insight.dataSource}</Badge>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    {sparklineData.length >= 2 ? (
                      <div className="h-20 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={sparklineData}>
                            <Tooltip formatter={(value: number) => [formatMetric(value), insight.metricName ?? "Metric"]} />
                            <Line
                              type="monotone"
                              dataKey="value"
                              stroke={insight.category === "anomaly" ? "#ef4444" : insight.category === "positive" ? "#16a34a" : "#2563eb"}
                              strokeWidth={2}
                              dot={false}
                            />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    ) : (
                      <p className="text-sm text-slate-700">
                        {insight.metricName ? `${insight.metricName}: ` : ""}
                        {formatMetric(insight.metricPreviousValue)} {"->"} {formatMetric(insight.metricValue)}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <p className={cn("text-xs", getSeverityTone(insight.severity))}>
                      Severity: {insight.severity.toUpperCase()} · Detected {getRelative(insight.detectedAt)}
                    </p>
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" asChild>
                        <Link to={`/dashboard/insights/${insight.id}`}>View Details</Link>
                      </Button>
                      <Button variant="outline" size="sm" asChild>
                        <Link to={`/dashboard/chat?q=${encodeURIComponent(insight.actionPrompt)}`}>
                          Take Action
                          <ArrowRight className="ml-1 h-3.5 w-3.5" />
                        </Link>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void dismissInsight(insight.id)}
                        disabled={dismissingId === insight.id}
                        title="Dismiss"
                      >
                        {dismissingId === insight.id ? <RefreshCw className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                </div>
              </article>
            );
          })
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <button
          type="button"
          onClick={async () => {
            const next = !showDismissed;
            setShowDismissed(next);
            setLoading(true);
            try {
              await loadPayload({ tab, sourceId, includeDismissed: next });
            } catch (error) {
              toast({
                title: "Could not load dismissed insights",
                description: error instanceof Error ? error.message : "Please try again.",
                variant: "destructive",
              });
            } finally {
              setLoading(false);
            }
          }}
          className="text-sm font-medium text-slate-800"
        >
          {showDismissed ? "Hide dismissed insights" : "Show dismissed insights"}
        </button>

        {showDismissed ? (
          <div className="mt-3 space-y-2">
            {dismissedInsights.length === 0 ? (
              <p className="text-sm text-slate-500">No dismissed insights.</p>
            ) : (
              dismissedInsights.map((insight) => (
                <div key={insight.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-sm font-medium text-slate-800">{insight.title}</p>
                  <p className="mt-1 text-xs text-slate-500">Dismissed · originally detected {getRelative(insight.detectedAt)}</p>
                </div>
              ))
            )}
          </div>
        ) : null}
      </section>

    </div>
  );
}
