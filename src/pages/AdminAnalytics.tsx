import { useCallback, useEffect, useMemo, useState } from "react";
import { format, parseISO, subDays } from "date-fns";
import { Download, FileText, Loader2 } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
} from "recharts";
import { NavLink } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { invokeEdge } from "@/lib/edge-invoke";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

type DatePreset = "7d" | "30d" | "90d" | "custom";
type SortKey = "agent" | "queries" | "successRate" | "avgTimeMs" | "topQuery";
type SortDirection = "asc" | "desc";

type QueryPerDayRow = {
  date: string;
  agent: string;
  queries: number;
};

type ResponseDistributionRow = {
  date: string;
  p50: number;
  p95: number;
  p99: number;
};

type MostActiveUserRow = {
  user: string;
  queries: number;
};

type QueriedResourceRow = {
  name: string;
  value: number;
};

type ActionBreakdownRow = {
  status: "success" | "failed" | "blocked" | "pending";
  count: number;
};

type AgentPerformanceRow = {
  agent: string;
  queries: number;
  successRate: number;
  avgTimeMs: number;
  topQuery: string;
};

type AnalyticsPayload = {
  range: {
    from: string;
    to: string;
    previousFrom: string;
    previousTo: string;
    days: number;
  };
  topMetrics: {
    totalAiQueries: number;
    actionsExecuted: number;
    avgResponseTimeMs: number;
    approvalRatePct: number;
    dataSourcesQueried: number;
  };
  usageCharts: {
    queriesPerDay: QueryPerDayRow[];
    agentKeys: string[];
    responseTimeDistribution: ResponseDistributionRow[];
    mostActiveUsers: MostActiveUserRow[];
    mostQueriedResources: QueriedResourceRow[];
    actionExecutionBreakdown: ActionBreakdownRow[];
  };
  agentPerformance: AgentPerformanceRow[];
  tokenUsage: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    trendPctVsPrevious: number;
    previousTotalTokens: number;
  };
  settings: {
    weeklyEmailReportEnabled: boolean;
  };
};

const EMPTY_PAYLOAD: AnalyticsPayload = {
  range: {
    from: format(subDays(new Date(), 6), "yyyy-MM-dd"),
    to: format(new Date(), "yyyy-MM-dd"),
    previousFrom: format(subDays(new Date(), 13), "yyyy-MM-dd"),
    previousTo: format(subDays(new Date(), 7), "yyyy-MM-dd"),
    days: 7,
  },
  topMetrics: {
    totalAiQueries: 0,
    actionsExecuted: 0,
    avgResponseTimeMs: 0,
    approvalRatePct: 0,
    dataSourcesQueried: 0,
  },
  usageCharts: {
    queriesPerDay: [],
    agentKeys: [],
    responseTimeDistribution: [],
    mostActiveUsers: [],
    mostQueriedResources: [],
    actionExecutionBreakdown: [],
  },
  agentPerformance: [],
  tokenUsage: {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    trendPctVsPrevious: 0,
    previousTotalTokens: 0,
  },
  settings: {
    weeklyEmailReportEnabled: false,
  },
};

const SUB_NAV = [
  { label: "Overview", to: "/dashboard/admin", end: true },
  { label: "Analytics", to: "/dashboard/admin/analytics" },
  { label: "Connections", to: "/dashboard/connections" },
  { label: "RACI", to: "/dashboard/raci" },
  { label: "Agents", to: "/dashboard/agents" },
  { label: "Users", to: "/dashboard/team" },
  { label: "Billing", to: "/dashboard/billing" },
  { label: "Settings", to: "/dashboard/settings" },
] as const;

const AGENT_COLORS = ["#7c3aed", "#2563eb", "#10b981", "#f97316", "#f59e0b", "#0ea5e9", "#14b8a6", "#ef4444"];
const ACTION_COLORS: Record<string, string> = {
  success: "#10b981",
  failed: "#ef4444",
  blocked: "#0f172a",
  pending: "#f59e0b",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

function formatMs(value: number) {
  if (value <= 0) return "0 ms";
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${Math.round(value)} ms`;
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDateLabel(value: string) {
  const parsed = parseISO(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return format(parsed, "MMM d");
}

function getPresetRange(preset: Exclude<DatePreset, "custom">) {
  const today = new Date();
  const days = preset === "7d" ? 7 : preset === "30d" ? 30 : 90;
  return {
    from: format(subDays(today, days - 1), "yyyy-MM-dd"),
    to: format(today, "yyyy-MM-dd"),
  };
}

function normalizePayload(value: unknown): AnalyticsPayload {
  const raw = asRecord(value);
  if (!raw) return EMPTY_PAYLOAD;

  const range = asRecord(raw.range);
  const topMetrics = asRecord(raw.topMetrics);
  const usageCharts = asRecord(raw.usageCharts);
  const tokenUsage = asRecord(raw.tokenUsage);
  const settings = asRecord(raw.settings);

  const queriesPerDay = Array.isArray(usageCharts?.queriesPerDay)
    ? usageCharts.queriesPerDay
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const date = String(row.date ?? "").trim();
          const agent = String(row.agent ?? "OpsAI Core").trim() || "OpsAI Core";
          if (!date) return null;
          return {
            date,
            agent,
            queries: Number(row.queries ?? 0) || 0,
          } satisfies QueryPerDayRow;
        })
        .filter((item): item is QueryPerDayRow => Boolean(item))
    : [];

  const responseTimeDistribution = Array.isArray(usageCharts?.responseTimeDistribution)
    ? usageCharts.responseTimeDistribution
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const date = String(row.date ?? "").trim();
          if (!date) return null;
          return {
            date,
            p50: Number(row.p50 ?? 0) || 0,
            p95: Number(row.p95 ?? 0) || 0,
            p99: Number(row.p99 ?? 0) || 0,
          } satisfies ResponseDistributionRow;
        })
        .filter((item): item is ResponseDistributionRow => Boolean(item))
    : [];

  const mostActiveUsers = Array.isArray(usageCharts?.mostActiveUsers)
    ? usageCharts.mostActiveUsers
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const user = String(row.user ?? "Unknown").trim() || "Unknown";
          return {
            user,
            queries: Number(row.queries ?? 0) || 0,
          } satisfies MostActiveUserRow;
        })
        .filter((item): item is MostActiveUserRow => Boolean(item))
    : [];

  const mostQueriedResources = Array.isArray(usageCharts?.mostQueriedResources)
    ? usageCharts.mostQueriedResources
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const name = String(row.name ?? "Unknown").trim() || "Unknown";
          return {
            name,
            value: Number(row.value ?? 0) || 0,
          } satisfies QueriedResourceRow;
        })
        .filter((item): item is QueriedResourceRow => Boolean(item))
    : [];

  const actionExecutionBreakdown = Array.isArray(usageCharts?.actionExecutionBreakdown)
    ? usageCharts.actionExecutionBreakdown
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const status = String(row.status ?? "pending").toLowerCase();
          if (status !== "success" && status !== "failed" && status !== "blocked" && status !== "pending") {
            return null;
          }
          return {
            status,
            count: Number(row.count ?? 0) || 0,
          } satisfies ActionBreakdownRow;
        })
        .filter((item): item is ActionBreakdownRow => Boolean(item))
    : [];

  const agentPerformance = Array.isArray(raw.agentPerformance)
    ? raw.agentPerformance
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const agent = String(row.agent ?? "OpsAI Core").trim() || "OpsAI Core";
          return {
            agent,
            queries: Number(row.queries ?? 0) || 0,
            successRate: Number(row.successRate ?? 0) || 0,
            avgTimeMs: Number(row.avgTimeMs ?? 0) || 0,
            topQuery: String(row.topQuery ?? "N/A"),
          } satisfies AgentPerformanceRow;
        })
        .filter((item): item is AgentPerformanceRow => Boolean(item))
    : [];

  return {
    range: {
      from: String(range?.from ?? EMPTY_PAYLOAD.range.from),
      to: String(range?.to ?? EMPTY_PAYLOAD.range.to),
      previousFrom: String(range?.previousFrom ?? EMPTY_PAYLOAD.range.previousFrom),
      previousTo: String(range?.previousTo ?? EMPTY_PAYLOAD.range.previousTo),
      days: Number(range?.days ?? EMPTY_PAYLOAD.range.days) || EMPTY_PAYLOAD.range.days,
    },
    topMetrics: {
      totalAiQueries: Number(topMetrics?.totalAiQueries ?? 0) || 0,
      actionsExecuted: Number(topMetrics?.actionsExecuted ?? 0) || 0,
      avgResponseTimeMs: Number(topMetrics?.avgResponseTimeMs ?? 0) || 0,
      approvalRatePct: Number(topMetrics?.approvalRatePct ?? 0) || 0,
      dataSourcesQueried: Number(topMetrics?.dataSourcesQueried ?? 0) || 0,
    },
    usageCharts: {
      queriesPerDay,
      agentKeys: Array.isArray(usageCharts?.agentKeys)
        ? usageCharts.agentKeys.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0)
        : [],
      responseTimeDistribution,
      mostActiveUsers,
      mostQueriedResources,
      actionExecutionBreakdown,
    },
    agentPerformance,
    tokenUsage: {
      totalTokens: Number(tokenUsage?.totalTokens ?? 0) || 0,
      inputTokens: Number(tokenUsage?.inputTokens ?? 0) || 0,
      outputTokens: Number(tokenUsage?.outputTokens ?? 0) || 0,
      estimatedCostUsd: Number(tokenUsage?.estimatedCostUsd ?? 0) || 0,
      trendPctVsPrevious: Number(tokenUsage?.trendPctVsPrevious ?? 0) || 0,
      previousTotalTokens: Number(tokenUsage?.previousTotalTokens ?? 0) || 0,
    },
    settings: {
      weeklyEmailReportEnabled: settings?.weeklyEmailReportEnabled === true,
    },
  };
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Please try again.";
}

function metricSubtitle(label: string) {
  if (label === "Total AI Queries") return "Total user prompts";
  if (label === "Actions Executed") return "All action runs";
  if (label === "Avg Response Time") return "Across SQL + tools";
  if (label === "Approval Rate") return "Approved / total decisions";
  return "Distinct connection IDs";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sortIcon(direction: SortDirection, active: boolean) {
  if (!active) return "↕";
  return direction === "asc" ? "↑" : "↓";
}

export default function AdminAnalytics() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [tenantId, setTenantId] = useState<string | null>(null);
  const [payload, setPayload] = useState<AnalyticsPayload>(EMPTY_PAYLOAD);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [preset, setPreset] = useState<DatePreset>("7d");
  const [dateFrom, setDateFrom] = useState(EMPTY_PAYLOAD.range.from);
  const [dateTo, setDateTo] = useState(EMPTY_PAYLOAD.range.to);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("queries");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  useEffect(() => {
    if (!user) {
      setTenantId(null);
      setPayload(EMPTY_PAYLOAD);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    let cancelled = false;

    const bootstrap = async () => {
      try {
        const workspace = await ensureUserWorkspace(user);
        if (cancelled) return;
        setTenantId(workspace.tenantId);
      } catch (error) {
        if (cancelled) return;
        setLoading(false);
        setRefreshing(false);
        toast({
          title: "Could not load workspace",
          description: normalizeError(error),
          variant: "destructive",
        });
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [toast, user]);

  const loadPayload = useCallback(
    async (withLoading = true) => {
      if (!tenantId) return;
      if (withLoading) setLoading(true);
      if (!withLoading) setRefreshing(true);

      try {
        const { data, error } = await invokeEdge("admin-analytics", {
          body: {
            operation: "get_payload",
            dateFrom,
            dateTo,
          },
        });

        if (error) throw error;

        const normalized = normalizePayload((asRecord(data)?.payload as unknown) ?? null);
        setPayload(normalized);
      } catch (error) {
        toast({
          title: "Could not load analytics",
          description: normalizeError(error),
          variant: "destructive",
        });
      } finally {
        if (withLoading) setLoading(false);
        if (!withLoading) setRefreshing(false);
      }
    },
    [dateFrom, dateTo, tenantId, toast],
  );

  useEffect(() => {
    if (!tenantId) return;
    void loadPayload(true);
  }, [tenantId, loadPayload]);

  useEffect(() => {
    if (!tenantId) return;

    const tables = [
      "chat_sessions",
      "chat_sql_runs",
      "agent_runs",
      "agent_tool_runs",
      "agent_action_runs",
      "approval_requests",
      "tenant_admin_report_settings",
    ];

    const channel = supabase.channel(`admin-analytics-${tenantId}`);

    tables.forEach((table) => {
      channel.on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table,
          filter: `tenant_id=eq.${tenantId}`,
        },
        () => {
          void loadPayload(false);
        },
      );
    });

    channel.subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [tenantId, loadPayload]);

  const handlePresetChange = (value: DatePreset) => {
    setPreset(value);

    if (value === "custom") return;

    const range = getPresetRange(value);
    setDateFrom(range.from);
    setDateTo(range.to);
  };

  const handleApplyCustomRange = () => {
    if (!dateFrom || !dateTo) {
      toast({
        title: "Date range required",
        description: "Choose both start and end date.",
        variant: "destructive",
      });
      return;
    }

    if (dateFrom > dateTo) {
      toast({
        title: "Invalid date range",
        description: "Start date must be before end date.",
        variant: "destructive",
      });
      return;
    }

    void loadPayload(true);
  };

  const handleRefresh = () => {
    void loadPayload(true);
  };

  const handleToggleWeeklyEmail = async (enabled: boolean) => {
    if (!tenantId || savingSchedule) return;
    setSavingSchedule(true);

    try {
      const { data, error } = await invokeEdge("admin-analytics", {
        body: {
          operation: "set_weekly_report",
          enabled,
          dateFrom,
          dateTo,
        },
      });

      if (error) throw error;

      const nextPayload = normalizePayload((asRecord(data)?.payload as unknown) ?? null);
      setPayload(nextPayload);

      toast({
        title: enabled ? "Weekly report enabled" : "Weekly report disabled",
        description: enabled
          ? "A weekly analytics email will be scheduled for admins."
          : "Weekly analytics emails are now paused.",
      });
    } catch (error) {
      toast({
        title: "Could not update schedule",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setSavingSchedule(false);
    }
  };

  const agentSeries = useMemo(() => {
    const names = new Set<string>();
    payload.usageCharts.agentKeys.forEach((name) => names.add(name));
    payload.usageCharts.queriesPerDay.forEach((row) => names.add(row.agent));

    return Array.from(names)
      .sort((a, b) => a.localeCompare(b))
      .map((agent, index) => ({
        agent,
        key: `agent_${index}`,
        color: AGENT_COLORS[index % AGENT_COLORS.length],
      }));
  }, [payload.usageCharts.agentKeys, payload.usageCharts.queriesPerDay]);

  const stackedQueryData = useMemo(() => {
    const byDate = new Map<string, Record<string, string | number>>();

    // Include all dates across range so the chart does not collapse on sparse data.
    const start = parseISO(payload.range.from);
    const end = parseISO(payload.range.to);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && start <= end) {
      const cursor = new Date(start);
      while (cursor <= end) {
        const date = format(cursor, "yyyy-MM-dd");
        byDate.set(date, {
          date,
          label: format(cursor, "MMM d"),
          total: 0,
        });
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    const seriesLookup = new Map(agentSeries.map((series) => [series.agent, series.key]));

    payload.usageCharts.queriesPerDay.forEach((row) => {
      if (!byDate.has(row.date)) {
        byDate.set(row.date, {
          date: row.date,
          label: formatDateLabel(row.date),
          total: 0,
        });
      }

      const target = byDate.get(row.date);
      if (!target) return;
      const key = seriesLookup.get(row.agent);
      if (!key) return;

      const current = Number(target[key] ?? 0) || 0;
      target[key] = current + row.queries;
      target.total = (Number(target.total ?? 0) || 0) + row.queries;
    });

    return Array.from(byDate.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [agentSeries, payload.range.from, payload.range.to, payload.usageCharts.queriesPerDay]);

  const actionBreakdownData = useMemo(() => {
    const labels = ["success", "failed", "blocked", "pending"] as const;
    const source = new Map(payload.usageCharts.actionExecutionBreakdown.map((row) => [row.status, row.count]));
    return labels.map((status) => ({
      status,
      count: source.get(status) ?? 0,
    }));
  }, [payload.usageCharts.actionExecutionBreakdown]);

  const sortedAgentPerformance = useMemo(() => {
    const rows = [...payload.agentPerformance];

    rows.sort((a, b) => {
      if (sortKey === "queries") {
        return sortDirection === "asc" ? a.queries - b.queries : b.queries - a.queries;
      }

      if (sortKey === "successRate") {
        return sortDirection === "asc" ? a.successRate - b.successRate : b.successRate - a.successRate;
      }

      if (sortKey === "avgTimeMs") {
        return sortDirection === "asc" ? a.avgTimeMs - b.avgTimeMs : b.avgTimeMs - a.avgTimeMs;
      }

      if (sortKey === "topQuery") {
        return sortDirection === "asc"
          ? a.topQuery.localeCompare(b.topQuery)
          : b.topQuery.localeCompare(a.topQuery);
      }

      return sortDirection === "asc" ? a.agent.localeCompare(b.agent) : b.agent.localeCompare(a.agent);
    });

    return rows;
  }, [payload.agentPerformance, sortDirection, sortKey]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }

    setSortKey(key);
    setSortDirection(key === "agent" || key === "topQuery" ? "asc" : "desc");
  };

  const handleCsvExport = () => {
    const lines: string[] = [];

    lines.push("OpsAI Tenant Analytics Report");
    lines.push(`Range,${payload.range.from},${payload.range.to}`);
    lines.push("");

    lines.push("Top Metrics");
    lines.push("Metric,Value,Description");
    lines.push(`Total AI Queries,${payload.topMetrics.totalAiQueries},Total user prompts`);
    lines.push(`Actions Executed,${payload.topMetrics.actionsExecuted},All action runs`);
    lines.push(`Avg Response Time,${payload.topMetrics.avgResponseTimeMs.toFixed(2)} ms,Across SQL + tools`);
    lines.push(`Approval Rate,${payload.topMetrics.approvalRatePct.toFixed(2)}%,Approved / total decisions`);
    lines.push(`Data Sources Queried,${payload.topMetrics.dataSourcesQueried},Distinct connection IDs`);
    lines.push("");

    lines.push("Token Usage");
    lines.push("Total Tokens,Input Tokens,Output Tokens,Estimated Cost (USD),Trend vs Previous (%)");
    lines.push(
      `${payload.tokenUsage.totalTokens},${payload.tokenUsage.inputTokens},${payload.tokenUsage.outputTokens},${payload.tokenUsage.estimatedCostUsd.toFixed(4)},${payload.tokenUsage.trendPctVsPrevious.toFixed(2)}`,
    );
    lines.push("");

    lines.push("Agent Performance");
    lines.push("Agent,Queries,Success Rate (%),Avg Time (ms),Top Query");
    sortedAgentPerformance.forEach((row) => {
      const escapedQuery = row.topQuery.replaceAll('"', '""');
      lines.push(`"${row.agent}",${row.queries},${row.successRate.toFixed(2)},${row.avgTimeMs.toFixed(2)},"${escapedQuery}"`);
    });

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tenant-analytics-${payload.range.from}-${payload.range.to}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const handlePdfExport = () => {
    const windowRef = window.open("", "_blank", "noopener,noreferrer,width=1024,height=800");
    if (!windowRef) {
      toast({
        title: "Popup blocked",
        description: "Allow popups to export PDF report.",
        variant: "destructive",
      });
      return;
    }

    const rowsHtml = sortedAgentPerformance
      .slice(0, 20)
      .map(
        (row) => `
          <tr>
            <td>${escapeHtml(row.agent)}</td>
            <td>${row.queries}</td>
            <td>${row.successRate.toFixed(1)}%</td>
            <td>${row.avgTimeMs.toFixed(1)} ms</td>
            <td>${escapeHtml(row.topQuery)}</td>
          </tr>
        `,
      )
      .join("\n");

    const html = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>OpsAI Analytics Report</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 24px; color: #0f172a; }
            h1 { margin: 0 0 8px; }
            p { margin: 0 0 12px; }
            .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 12px 0 20px; }
            .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; }
            .label { font-size: 12px; color: #64748b; }
            .value { font-size: 20px; font-weight: 700; margin-top: 4px; }
            table { width: 100%; border-collapse: collapse; margin-top: 12px; }
            th, td { border: 1px solid #e2e8f0; padding: 8px; text-align: left; font-size: 12px; }
            th { background: #f8fafc; }
          </style>
        </head>
        <body>
          <h1>OpsAI Tenant Analytics</h1>
          <p>Report range: ${escapeHtml(payload.range.from)} to ${escapeHtml(payload.range.to)}</p>

          <div class="grid">
            <div class="card"><div class="label">Total AI Queries</div><div class="value">${formatNumber(payload.topMetrics.totalAiQueries)}</div></div>
            <div class="card"><div class="label">Actions Executed</div><div class="value">${formatNumber(payload.topMetrics.actionsExecuted)}</div></div>
            <div class="card"><div class="label">Avg Response Time</div><div class="value">${escapeHtml(formatMs(payload.topMetrics.avgResponseTimeMs))}</div></div>
            <div class="card"><div class="label">Approval Rate</div><div class="value">${escapeHtml(formatPercent(payload.topMetrics.approvalRatePct))}</div></div>
          </div>

          <h2>Token Usage</h2>
          <p>Total tokens: ${formatNumber(payload.tokenUsage.totalTokens)} | Estimated cost: ${escapeHtml(formatCurrency(payload.tokenUsage.estimatedCostUsd))}</p>

          <h2>Agent Performance</h2>
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Queries</th>
                <th>Success Rate</th>
                <th>Avg Time</th>
                <th>Top Query</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </body>
      </html>
    `;

    windowRef.document.write(html);
    windowRef.document.close();
    windowRef.focus();
    window.setTimeout(() => {
      windowRef.print();
    }, 200);
  };

  const metrics = [
    {
      label: "Total AI Queries",
      value: formatNumber(payload.topMetrics.totalAiQueries),
    },
    {
      label: "Actions Executed",
      value: formatNumber(payload.topMetrics.actionsExecuted),
    },
    {
      label: "Avg Response Time",
      value: formatMs(payload.topMetrics.avgResponseTimeMs),
    },
    {
      label: "Approval Rate",
      value: formatPercent(payload.topMetrics.approvalRatePct),
    },
    {
      label: "Data Sources Queried",
      value: formatNumber(payload.topMetrics.dataSourcesQueried),
    },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <nav className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
        <div className="flex flex-wrap gap-1">
          {SUB_NAV.map((item) => (
            <NavLink
              key={item.label}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "rounded-lg px-3 py-2 text-sm font-medium transition",
                  isActive ? "bg-violet-100 text-violet-800" : "text-slate-600 hover:bg-slate-100 hover:text-slate-800",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      </nav>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Tenant Analytics</h1>
            <p className="text-sm text-slate-600">Operational insights for your workspace and agents.</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select value={preset} onValueChange={(value) => handlePresetChange(value as DatePreset)}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder="Select range" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
                <SelectItem value="90d">Last 90 days</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>

            {preset === "custom" && (
              <>
                <Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className="w-[165px]" />
                <Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className="w-[165px]" />
                <Button variant="outline" onClick={handleApplyCustomRange}>
                  Apply
                </Button>
              </>
            )}

            {preset !== "custom" && (
              <Button variant="outline" onClick={handleRefresh}>
                Refresh
              </Button>
            )}

            <Button variant="outline" onClick={handleCsvExport}>
              <Download className="h-4 w-4" />
              Download CSV
            </Button>
            <Button variant="outline" onClick={handlePdfExport}>
              <FileText className="h-4 w-4" />
              Download PDF
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <Switch
            checked={payload.settings.weeklyEmailReportEnabled}
            onCheckedChange={handleToggleWeeklyEmail}
            disabled={savingSchedule}
          />
          <div>
            <p className="text-sm font-medium text-slate-900">Schedule weekly email report</p>
            <p className="text-xs text-slate-600">Send a weekly summary to workspace admins.</p>
          </div>
          {savingSchedule && <Loader2 className="ml-auto h-4 w-4 animate-spin text-slate-500" />}
          {!savingSchedule && (
            <Badge className="ml-auto border-0 bg-slate-200 text-slate-700">
              {payload.settings.weeklyEmailReportEnabled ? "Enabled" : "Disabled"}
            </Badge>
          )}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {loading
          ? Array.from({ length: 5 }).map((_, index) => <Skeleton key={`metric-skeleton-${index}`} className="h-28 rounded-xl" />)
          : metrics.map((metric) => (
              <article key={metric.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{metric.label}</p>
                <p className="mt-2 text-2xl font-semibold text-slate-900">{metric.value}</p>
                <p className="mt-1 text-xs text-slate-500">{metricSubtitle(metric.label)}</p>
              </article>
            ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Queries per Day</h2>
            {refreshing && <Loader2 className="h-4 w-4 animate-spin text-slate-500" />}
          </div>
          <div className="h-[300px]">
            {loading ? (
              <Skeleton className="h-full w-full" />
            ) : stackedQueryData.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-300 text-sm text-slate-500">
                No query activity in selected period.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stackedQueryData} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
                  <Tooltip />
                  {agentSeries.map((series) => (
                    <Bar
                      key={series.key}
                      dataKey={series.key}
                      stackId="queries"
                      fill={series.color}
                      name={series.agent}
                      radius={[4, 4, 0, 0]}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Response Time Distribution (P50 / P95 / P99)</h2>
          <div className="h-[300px]">
            {loading ? (
              <Skeleton className="h-full w-full" />
            ) : payload.usageCharts.responseTimeDistribution.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-300 text-sm text-slate-500">
                No latency data available.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={payload.usageCharts.responseTimeDistribution} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={formatDateLabel} tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} />
                  <Tooltip labelFormatter={(value) => formatDateLabel(String(value))} />
                  <Line type="monotone" dataKey="p50" name="P50" stroke="#10b981" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="p95" name="P95" stroke="#f59e0b" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="p99" name="P99" stroke="#ef4444" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Most Active Users</h2>
          <div className="h-[280px]">
            {loading ? (
              <Skeleton className="h-full w-full" />
            ) : payload.usageCharts.mostActiveUsers.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-300 text-sm text-slate-500">
                No user activity in selected period.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={[...payload.usageCharts.mostActiveUsers].reverse()} layout="vertical" margin={{ left: 20, right: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="user" width={80} tickLine={false} axisLine={false} />
                  <Tooltip />
                  <Bar dataKey="queries" fill="#7c3aed" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Most Queried Resources</h2>
          <div className="h-[280px]">
            {loading ? (
              <Skeleton className="h-full w-full" />
            ) : payload.usageCharts.mostQueriedResources.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-300 text-sm text-slate-500">
                No resource hits in selected period.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <Treemap
                  data={payload.usageCharts.mostQueriedResources}
                  dataKey="value"
                  stroke="#fff"
                  fill="#7c3aed"
                >
                  <Tooltip formatter={(value: number) => formatNumber(Number(value) || 0)} />
                </Treemap>
              </ResponsiveContainer>
            )}
          </div>
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Action Execution Breakdown</h2>
          <div className="h-[280px]">
            {loading ? (
              <Skeleton className="h-full w-full" />
            ) : actionBreakdownData.every((item) => item.count === 0) ? (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-300 text-sm text-slate-500">
                No actions executed in selected period.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={actionBreakdownData}
                    dataKey="count"
                    nameKey="status"
                    cx="50%"
                    cy="50%"
                    innerRadius={70}
                    outerRadius={100}
                    paddingAngle={3}
                  >
                    {actionBreakdownData.map((entry) => (
                      <Cell key={entry.status} fill={ACTION_COLORS[entry.status]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => formatNumber(Number(value) || 0)} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
          {!loading && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              {actionBreakdownData.map((item) => (
                <div key={item.status} className="flex items-center justify-between rounded border border-slate-200 px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ACTION_COLORS[item.status] }} />
                    <span className="capitalize text-slate-700">{item.status}</span>
                  </div>
                  <span className="font-semibold text-slate-900">{formatNumber(item.count)}</span>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_350px]">
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Agent Performance</h2>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <button type="button" className="inline-flex items-center gap-1" onClick={() => handleSort("agent")}>
                      Agent {sortIcon(sortDirection, sortKey === "agent")}
                    </button>
                  </TableHead>
                  <TableHead>
                    <button type="button" className="inline-flex items-center gap-1" onClick={() => handleSort("queries")}>
                      Queries {sortIcon(sortDirection, sortKey === "queries")}
                    </button>
                  </TableHead>
                  <TableHead>
                    <button type="button" className="inline-flex items-center gap-1" onClick={() => handleSort("successRate")}>
                      Success Rate {sortIcon(sortDirection, sortKey === "successRate")}
                    </button>
                  </TableHead>
                  <TableHead>
                    <button type="button" className="inline-flex items-center gap-1" onClick={() => handleSort("avgTimeMs")}>
                      Avg Time {sortIcon(sortDirection, sortKey === "avgTimeMs")}
                    </button>
                  </TableHead>
                  <TableHead>
                    <button type="button" className="inline-flex items-center gap-1" onClick={() => handleSort("topQuery")}>
                      Top Query {sortIcon(sortDirection, sortKey === "topQuery")}
                    </button>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  Array.from({ length: 5 }).map((_, index) => (
                    <TableRow key={`agent-row-skeleton-${index}`}>
                      <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-14" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-40" /></TableCell>
                    </TableRow>
                  ))
                ) : sortedAgentPerformance.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-20 text-center text-sm text-slate-500">
                      No agent activity for this period.
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedAgentPerformance.map((row) => (
                    <TableRow key={`${row.agent}-${row.topQuery}`}>
                      <TableCell className="font-medium text-slate-900">{row.agent}</TableCell>
                      <TableCell>{formatNumber(row.queries)}</TableCell>
                      <TableCell>{row.successRate.toFixed(1)}%</TableCell>
                      <TableCell>{formatMs(row.avgTimeMs)}</TableCell>
                      <TableCell className="max-w-[340px] truncate text-slate-600" title={row.topQuery}>
                        {row.topQuery}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </article>

        <article className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Token Usage</h2>

          {loading ? (
            <>
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </>
          ) : (
            <>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Total Tokens</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">{formatNumber(payload.tokenUsage.totalTokens)}</p>
                <p className="mt-1 text-xs text-slate-600">Previous period: {formatNumber(payload.tokenUsage.previousTotalTokens)}</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="text-xs text-slate-500">Input Tokens</p>
                  <p className="text-lg font-semibold text-slate-900">{formatNumber(payload.tokenUsage.inputTokens)}</p>
                </div>
                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="text-xs text-slate-500">Output Tokens</p>
                  <p className="text-lg font-semibold text-slate-900">{formatNumber(payload.tokenUsage.outputTokens)}</p>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 p-3">
                <p className="text-xs text-slate-500">Estimated Cost</p>
                <p className="text-lg font-semibold text-slate-900">{formatCurrency(payload.tokenUsage.estimatedCostUsd)}</p>
              </div>

              <div
                className={cn(
                  "rounded-lg border px-3 py-2 text-sm",
                  payload.tokenUsage.trendPctVsPrevious > 0
                    ? "border-amber-200 bg-amber-50 text-amber-800"
                    : payload.tokenUsage.trendPctVsPrevious < 0
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-slate-200 bg-slate-50 text-slate-700",
                )}
              >
                Trend vs previous period: {payload.tokenUsage.trendPctVsPrevious >= 0 ? "+" : ""}
                {payload.tokenUsage.trendPctVsPrevious.toFixed(2)}%
              </div>
            </>
          )}
        </article>
      </section>
    </div>
  );
}
