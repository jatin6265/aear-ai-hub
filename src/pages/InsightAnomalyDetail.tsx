import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Loader2,
  ShieldAlert,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import {
  Area,
  ComposedChart,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdge } from "@/lib/edge-invoke";
import { cn } from "@/lib/utils";

type ZoomWindow = "7d" | "30d" | "60d" | "90d";

type AnomalyHeader = {
  severity: string;
  category: string;
  title: string;
  detectedAt: string;
  status: string;
  sourceName: string;
};

type ImpactSummary = {
  metric: string;
  expected: number;
  actual: number;
  deviationPct: number;
  confidence: number;
};

type ChartPoint = {
  date: string;
  expected: number | null;
  actual: number | null;
  lowerBand: number | null;
  upperBand: number | null;
  forecast: number | null;
  isAnomaly: boolean;
};

type RootCauseFactor = {
  name: string;
  impactPct: number;
  details: string | null;
};

type RecommendedAction = {
  id: string;
  title: string;
  prompt: string;
  actionType: string;
};

type SimilarEvent = {
  id: string;
  title: string;
  detectedAt: string;
  severity: string;
  deviationPct: number | null;
  details: string | null;
};

type AnomalyDetailPayload = {
  id: string;
  header: AnomalyHeader;
  impactSummary: ImpactSummary;
  chart: {
    window: ZoomWindow;
    points: ChartPoint[];
  };
  rootCauseAnalysis: {
    analysis: string;
    factors: RootCauseFactor[];
  };
  recommendedActions: RecommendedAction[];
  similarPastEvents: {
    count12Months: number;
    events: SimilarEvent[];
  };
};

const EMPTY_DETAIL: AnomalyDetailPayload = {
  id: "",
  header: {
    severity: "medium",
    category: "anomaly",
    title: "Revenue Anomaly Detected",
    detectedAt: new Date().toISOString(),
    status: "Active",
    sourceName: "Unknown source",
  },
  impactSummary: {
    metric: "Revenue (Weekly)",
    expected: 145000,
    actual: 96000,
    deviationPct: -33.8,
    confidence: 94,
  },
  chart: {
    window: "60d",
    points: [],
  },
  rootCauseAnalysis: {
    analysis:
      "The drop correlates with a 40% decrease in orders from Region X starting Dec 15. This coincides with the holiday period and may be seasonal.",
    factors: [
      { name: "Seasonal effect", impactPct: 45, details: null },
      { name: "Region X orders", impactPct: 38, details: null },
      { name: "Price change", impactPct: 17, details: null },
    ],
  },
  recommendedActions: [],
  similarPastEvents: {
    count12Months: 0,
    events: [],
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeWindow(value: unknown): ZoomWindow {
  const window = String(value ?? "").trim().toLowerCase();
  if (window === "7d" || window === "30d" || window === "90d") return window;
  return "60d";
}

function normalizePayload(value: unknown): AnomalyDetailPayload {
  const raw = asRecord(value);
  if (!raw) return EMPTY_DETAIL;
  const headerRaw = asRecord(raw.header);
  const impactRaw = asRecord(raw.impactSummary);
  const chartRaw = asRecord(raw.chart);
  const rootRaw = asRecord(raw.rootCauseAnalysis);
  const similarRaw = asRecord(raw.similarPastEvents);

  const points = Array.isArray(chartRaw?.points)
    ? chartRaw.points
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const date = String(row.date ?? "").trim();
          if (!date) return null;
          return {
            date,
            expected: row.expected === null || row.expected === undefined ? null : toNumber(row.expected),
            actual: row.actual === null || row.actual === undefined ? null : toNumber(row.actual),
            lowerBand: row.lowerBand === null || row.lowerBand === undefined ? null : toNumber(row.lowerBand),
            upperBand: row.upperBand === null || row.upperBand === undefined ? null : toNumber(row.upperBand),
            forecast: row.forecast === null || row.forecast === undefined ? null : toNumber(row.forecast),
            isAnomaly: row.isAnomaly === true,
          } satisfies ChartPoint;
        })
        .filter((item): item is ChartPoint => Boolean(item))
    : [];

  const factors = Array.isArray(rootRaw?.factors)
    ? rootRaw.factors
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          return {
            name: String(row.name ?? ""),
            impactPct: toNumber(row.impactPct),
            details: row.details ? String(row.details) : null,
          } satisfies RootCauseFactor;
        })
        .filter((item): item is RootCauseFactor => Boolean(item) && item.name.length > 0)
    : [];

  const actions = Array.isArray(raw.recommendedActions)
    ? raw.recommendedActions
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          return {
            id: String(row.id ?? ""),
            title: String(row.title ?? ""),
            prompt: String(row.prompt ?? ""),
            actionType: String(row.actionType ?? "chat"),
          } satisfies RecommendedAction;
        })
        .filter((item): item is RecommendedAction => Boolean(item) && item.id.length > 0)
    : [];

  const events = Array.isArray(similarRaw?.events)
    ? similarRaw.events
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          return {
            id: String(row.id ?? ""),
            title: String(row.title ?? ""),
            detectedAt: String(row.detectedAt ?? new Date().toISOString()),
            severity: String(row.severity ?? "medium"),
            deviationPct: row.deviationPct === null || row.deviationPct === undefined ? null : toNumber(row.deviationPct),
            details: row.details ? String(row.details) : null,
          } satisfies SimilarEvent;
        })
        .filter((item): item is SimilarEvent => Boolean(item) && item.id.length > 0)
    : [];

  return {
    id: String(raw.id ?? ""),
    header: {
      severity: String(headerRaw?.severity ?? "medium"),
      category: String(headerRaw?.category ?? "anomaly"),
      title: String(headerRaw?.title ?? "Revenue Anomaly Detected"),
      detectedAt: String(headerRaw?.detectedAt ?? new Date().toISOString()),
      status: String(headerRaw?.status ?? "Active"),
      sourceName: String(headerRaw?.sourceName ?? "Unknown source"),
    },
    impactSummary: {
      metric: String(impactRaw?.metric ?? "Revenue (Weekly)"),
      expected: toNumber(impactRaw?.expected, 145000),
      actual: toNumber(impactRaw?.actual, 96000),
      deviationPct: toNumber(impactRaw?.deviationPct, -33.8),
      confidence: toNumber(impactRaw?.confidence, 94),
    },
    chart: {
      window: normalizeWindow(chartRaw?.window),
      points,
    },
    rootCauseAnalysis: {
      analysis: String(
        rootRaw?.analysis ??
          "The drop correlates with a 40% decrease in orders from Region X starting Dec 15. This coincides with the holiday period and may be seasonal.",
      ),
      factors,
    },
    recommendedActions: actions,
    similarPastEvents: {
      count12Months: toNumber(similarRaw?.count12Months, 0),
      events,
    },
  };
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function formatPercent(value: number) {
  const abs = Math.abs(value).toFixed(1);
  return `${value >= 0 ? "+" : "-"}${abs}%`;
}

function formatMetric(value: number | null) {
  if (value === null) return "N/A";
  if (Math.abs(value) >= 1000) return new Intl.NumberFormat("en-US").format(Math.round(value));
  return value.toFixed(2);
}

function getSeverityBadgeClass(severity: string) {
  const normalized = severity.toLowerCase();
  if (normalized === "critical") return "border-0 bg-red-100 text-red-800";
  if (normalized === "high") return "border-0 bg-amber-100 text-amber-800";
  if (normalized === "low") return "border-0 bg-emerald-100 text-emerald-800";
  return "border-0 bg-slate-200 text-slate-800";
}

function getCategoryLabel(category: string) {
  const normalized = category.toLowerCase();
  if (normalized === "sla_risk") return "SLA Risk";
  if (normalized === "forecast") return "Forecast";
  if (normalized === "opportunity") return "Opportunity";
  if (normalized === "positive") return "Positive";
  if (normalized === "trend") return "Trend";
  return "Anomaly";
}

function getCategoryIcon(category: string) {
  const normalized = category.toLowerCase();
  if (normalized === "sla_risk") return ShieldAlert;
  if (normalized === "positive") return Sparkles;
  if (normalized === "forecast" || normalized === "trend") return TrendingUp;
  return AlertTriangle;
}

function normalizeStatusForApi(value: string): "active" | "investigating" | "resolved" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "investigating") return "investigating";
  if (normalized === "resolved") return "resolved";
  return "active";
}

export default function InsightAnomalyDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [window, setWindow] = useState<ZoomWindow>("60d");
  const [payload, setPayload] = useState<AnomalyDetailPayload>(EMPTY_DETAIL);
  const [updatingStatus, setUpdatingStatus] = useState(false);

  const loadDetail = useCallback(
    async (nextWindow: ZoomWindow) => {
      if (!id) return;
      const { data, error } = await invokeEdge("anomaly-detail", {
        body: {
          operation: "get_detail",
          insightId: id,
          window: nextWindow,
        },
      });
      if (error) throw error;
      const parsed = normalizePayload(asRecord(data)?.payload);
      setPayload(parsed);
    },
    [id],
  );

  useEffect(() => {
    if (!id) return;
    let active = true;
    setLoading(true);
    void loadDetail(window)
      .catch((error) => {
        if (!active) return;
        toast({
          title: "Could not load anomaly detail",
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
  }, [id, loadDetail, toast, window]);

  const onWindowChange = async (nextWindow: ZoomWindow) => {
    if (nextWindow === window) return;
    setWindow(nextWindow);
  };

  const updateStatus = async (nextStatus: "active" | "investigating" | "resolved") => {
    if (!id) return;
    setUpdatingStatus(true);
    try {
      const { error } = await invokeEdge("anomaly-detail", {
        body: {
          operation: "set_status",
          insightId: id,
          status: nextStatus,
        },
      });
      if (error) throw error;
      await loadDetail(window);
      toast({
        title: "Status updated",
        description: `Anomaly marked as ${nextStatus}.`,
      });
    } catch (error) {
      toast({
        title: "Could not update status",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setUpdatingStatus(false);
    }
  };

  const chartData = useMemo(
    () =>
      payload.chart.points.map((point) => ({
        ...point,
        dateLabel: new Date(point.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      })),
    [payload.chart.points],
  );

  const anomalyDots = useMemo(() => chartData.filter((point) => point.isAnomaly), [chartData]);
  const CategoryIcon = getCategoryIcon(payload.header.category);

  return (
    <div className="space-y-6 pb-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard/insights")} className="w-fit px-0 text-slate-600 hover:text-slate-900">
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back to Insights
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={getSeverityBadgeClass(payload.header.severity)}>{payload.header.severity.toUpperCase()}</Badge>
            <Badge className="border-0 bg-slate-200 text-slate-800">
              <CategoryIcon className="mr-1 h-3.5 w-3.5" />
              {getCategoryLabel(payload.header.category)}
            </Badge>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{payload.header.title || "Revenue Anomaly Detected"}</h1>
          <p className="text-sm text-slate-600">
            Detected {formatDistanceToNowStrict(new Date(payload.header.detectedAt), { addSuffix: true })} · Source: {payload.header.sourceName}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="border-0 bg-violet-100 text-violet-800">{payload.header.status}</Badge>
          <div className="flex items-center gap-1">
            {(["active", "investigating", "resolved"] as const).map((state) => (
              <Button
                key={state}
                size="sm"
                variant={normalizeStatusForApi(payload.header.status) === state ? "default" : "outline"}
                onClick={() => void updateStatus(state)}
                disabled={updatingStatus}
                className={normalizeStatusForApi(payload.header.status) === state ? "bg-violet-600 hover:bg-violet-700" : ""}
              >
                {state === "active" ? "Active" : state === "investigating" ? "Investigating" : "Resolved"}
              </Button>
            ))}
          </div>
        </div>
      </header>

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-80 w-full rounded-xl" />
          <Skeleton className="h-56 w-full rounded-xl" />
        </div>
      ) : (
        <>
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">Impact Summary</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs text-slate-500">Metric</p>
                <p className="text-sm font-semibold text-slate-900">{payload.impactSummary.metric}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs text-slate-500">Expected</p>
                <p className="text-sm font-semibold text-slate-900">{formatCurrency(payload.impactSummary.expected)}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs text-slate-500">Actual</p>
                <p className="text-sm font-semibold text-slate-900">{formatCurrency(payload.impactSummary.actual)}</p>
              </div>
              <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                <p className="text-xs text-red-600">Deviation</p>
                <p className="text-xl font-bold text-red-700">{formatPercent(payload.impactSummary.deviationPct)}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs text-slate-500">Confidence</p>
                <p className="text-sm font-semibold text-slate-900">{Math.round(payload.impactSummary.confidence)}%</p>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">Metric Trend</h2>
              <div className="flex items-center gap-1">
                {(["7d", "30d", "60d", "90d"] as const).map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={window === option ? "default" : "outline"}
                    onClick={() => void onWindowChange(option)}
                    className={window === option ? "bg-violet-600 hover:bg-violet-700" : ""}
                  >
                    {option}
                  </Button>
                ))}
              </div>
            </div>

            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData}>
                  <XAxis dataKey="dateLabel" tick={{ fontSize: 11 }} minTickGap={24} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip
                    formatter={(value: number | null, name: string) => {
                      if (value === null || value === undefined) return ["-", name];
                      return [formatMetric(value), name];
                    }}
                  />
                  <Area type="monotone" dataKey="upperBand" stroke="transparent" fill="rgba(59,130,246,0.18)" />
                  <Area type="monotone" dataKey="lowerBand" stroke="transparent" fill="#ffffff" />
                  <Line type="monotone" dataKey="expected" name="Expected" stroke="#475569" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="actual" name="Actual" stroke="#2563eb" strokeWidth={2.5} dot={false} />
                  <Line
                    type="monotone"
                    dataKey="forecast"
                    name="Forecast (14d)"
                    stroke="#f97316"
                    strokeWidth={2}
                    strokeDasharray="6 4"
                    dot={false}
                  />
                  {anomalyDots.map((dot) => (
                    <ReferenceDot
                      key={`anomaly-dot-${dot.date}`}
                      x={dot.dateLabel}
                      y={dot.actual ?? dot.expected ?? 0}
                      r={6}
                      fill="#ef4444"
                      stroke="#ffffff"
                      strokeWidth={2}
                    />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-semibold text-slate-900">Root Cause Analysis</h2>
              <p className="mt-2 text-sm text-slate-700">{payload.rootCauseAnalysis.analysis}</p>
              <div className="mt-4 space-y-3">
                {payload.rootCauseAnalysis.factors.map((factor) => (
                  <div key={factor.name} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-medium text-slate-800">{factor.name}</span>
                      <span className="font-semibold text-slate-900">{factor.impactPct.toFixed(0)}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-slate-200">
                      <div className="h-full rounded-full bg-violet-500" style={{ width: `${Math.min(100, Math.max(0, factor.impactPct))}%` }} />
                    </div>
                    {factor.details ? <p className="mt-2 text-xs text-slate-600">{factor.details}</p> : null}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-semibold text-slate-900">Recommended Actions</h2>
              <div className="mt-3 space-y-3">
                {payload.recommendedActions.map((action) => (
                  <Link
                    key={action.id}
                    to={`/dashboard/chat?q=${encodeURIComponent(action.prompt)}`}
                    className="group block rounded-lg border border-slate-200 bg-slate-50 p-3 transition hover:border-violet-300 hover:bg-violet-50"
                  >
                    <p className="text-sm font-medium text-slate-900">{action.title}</p>
                    <p className="mt-1 text-xs text-slate-600">Open chat with pre-filled prompt</p>
                    <p className="mt-2 inline-flex items-center text-xs font-medium text-violet-700">
                      Take action
                      <ArrowRight className="ml-1 h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
                    </p>
                  </Link>
                ))}
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">Similar Past Events</h2>
            <p className="mt-1 text-sm text-slate-600">
              This pattern occurred {payload.similarPastEvents.count12Months} time{payload.similarPastEvents.count12Months === 1 ? "" : "s"} in the past 12 months.
            </p>

            <div className="mt-4 space-y-3">
              {payload.similarPastEvents.events.length === 0 ? (
                <p className="text-sm text-slate-500">No similar events found.</p>
              ) : (
                payload.similarPastEvents.events.map((event) => (
                  <div key={event.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-slate-900">{event.title}</p>
                      <Badge className={cn("border-0", getSeverityBadgeClass(event.severity))}>{event.severity.toUpperCase()}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      {formatDistanceToNowStrict(new Date(event.detectedAt), { addSuffix: true })}
                      {event.deviationPct !== null ? ` · Deviation ${formatPercent(event.deviationPct)}` : ""}
                    </p>
                    {event.details ? <p className="mt-1 text-xs text-slate-600">{event.details}</p> : null}
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}

      {updatingStatus ? (
        <div className="fixed bottom-4 right-4 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 shadow-sm">
          <span className="inline-flex items-center gap-1">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Updating status...
          </span>
        </div>
      ) : null}
    </div>
  );
}

