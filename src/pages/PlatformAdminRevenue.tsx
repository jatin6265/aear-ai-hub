import { useCallback, useEffect, useState } from "react";
import { Download, FileText, Loader2, Mail, TrendingDown, TrendingUp } from "lucide-react";
import { NavLink } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Funnel,
  FunnelChart,
  LabelList,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdge } from "@/lib/edge-invoke";
import { cn } from "@/lib/utils";

type KpiMetrics = {
  mrr: number;
  mrrMoMChangePct: number | null;
  arr: number;
  churnRatePct: number;
  newMrrThisMonth: number;
  expansionMrr: number;
  trialConversionRatePct: number;
};

type MrrGrowthPoint = {
  month: string;
  label: string;
  mrr: number;
};

type RevenueByPlanPoint = {
  month: string;
  label: string;
  starter: number;
  pro: number;
  business: number;
  enterprise: number;
  total: number;
};

type NewVsChurnedPoint = {
  month: string;
  label: string;
  newTenants: number;
  churnedTenants: number;
};

type FunnelPoint = {
  stage: string;
  count: number;
};

type TopTenantRow = {
  tenantId: string;
  company: string;
  plan: string;
  mrr: number;
  since: string;
  ltv: number;
  churnRiskPct: number;
};

type ChurnRiskSignal = {
  tenantId: string;
  company: string;
  churnRiskPct: number;
  reason: string | null;
  suggestedAction: string;
};

type RevenuePayload = {
  generatedAt: string;
  months: number;
  metrics: KpiMetrics;
  charts: {
    mrrGrowth: MrrGrowthPoint[];
    revenueByPlan: RevenueByPlanPoint[];
    newVsChurned: NewVsChurnedPoint[];
    trialConversionFunnel: FunnelPoint[];
  };
  topTenantsByMrr: TopTenantRow[];
  churnRiskSignals: ChurnRiskSignal[];
};

const EMPTY_PAYLOAD: RevenuePayload = {
  generatedAt: new Date().toISOString(),
  months: 12,
  metrics: {
    mrr: 0,
    mrrMoMChangePct: null,
    arr: 0,
    churnRatePct: 0,
    newMrrThisMonth: 0,
    expansionMrr: 0,
    trialConversionRatePct: 0,
  },
  charts: {
    mrrGrowth: [],
    revenueByPlan: [],
    newVsChurned: [],
    trialConversionFunnel: [],
  },
  topTenantsByMrr: [],
  churnRiskSignals: [],
};

const PLAN_COLORS: Record<string, string> = {
  starter: "#94a3b8",
  pro: "#7c3aed",
  business: "#2563eb",
  enterprise: "#eab308",
};

const SUB_NAV = [
  { label: "Tenants", to: "/platform-admin/tenants" },
  { label: "Revenue", to: "/platform-admin/revenue" },
  { label: "Infrastructure", to: "/platform-admin/infrastructure" },
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Please try again.";
}

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePayload(value: unknown): RevenuePayload {
  const raw = asRecord(value);
  if (!raw) return EMPTY_PAYLOAD;

  const metrics = asRecord(raw.metrics);
  const charts = asRecord(raw.charts);

  const mrrGrowth = Array.isArray(charts?.mrrGrowth)
    ? charts.mrrGrowth
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          return {
            month: String(row.month ?? ""),
            label: String(row.label ?? ""),
            mrr: toNumber(row.mrr),
          } satisfies MrrGrowthPoint;
        })
        .filter((item): item is MrrGrowthPoint => Boolean(item) && item.month.length > 0)
    : [];

  const revenueByPlan = Array.isArray(charts?.revenueByPlan)
    ? charts.revenueByPlan
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          return {
            month: String(row.month ?? ""),
            label: String(row.label ?? ""),
            starter: toNumber(row.starter),
            pro: toNumber(row.pro),
            business: toNumber(row.business),
            enterprise: toNumber(row.enterprise),
            total: toNumber(row.total),
          } satisfies RevenueByPlanPoint;
        })
        .filter((item): item is RevenueByPlanPoint => Boolean(item) && item.month.length > 0)
    : [];

  const newVsChurned = Array.isArray(charts?.newVsChurned)
    ? charts.newVsChurned
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          return {
            month: String(row.month ?? ""),
            label: String(row.label ?? ""),
            newTenants: toNumber(row.newTenants),
            churnedTenants: toNumber(row.churnedTenants),
          } satisfies NewVsChurnedPoint;
        })
        .filter((item): item is NewVsChurnedPoint => Boolean(item) && item.month.length > 0)
    : [];

  const trialConversionFunnel = Array.isArray(charts?.trialConversionFunnel)
    ? charts.trialConversionFunnel
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const stage = String(row.stage ?? "").trim();
          if (!stage) return null;
          return {
            stage,
            count: toNumber(row.count),
          } satisfies FunnelPoint;
        })
        .filter((item): item is FunnelPoint => Boolean(item))
    : [];

  const topTenantsByMrr = Array.isArray(raw.topTenantsByMrr)
    ? raw.topTenantsByMrr
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const tenantId = String(row.tenantId ?? "").trim();
          const company = String(row.company ?? "").trim();
          if (!tenantId || !company) return null;
          return {
            tenantId,
            company,
            plan: String(row.plan ?? "starter").toLowerCase(),
            mrr: toNumber(row.mrr),
            since: String(row.since ?? ""),
            ltv: toNumber(row.ltv),
            churnRiskPct: toNumber(row.churnRiskPct),
          } satisfies TopTenantRow;
        })
        .filter((item): item is TopTenantRow => Boolean(item))
    : [];

  const churnRiskSignals = Array.isArray(raw.churnRiskSignals)
    ? raw.churnRiskSignals
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const tenantId = String(row.tenantId ?? "").trim();
          const company = String(row.company ?? "").trim();
          if (!tenantId || !company) return null;
          return {
            tenantId,
            company,
            churnRiskPct: toNumber(row.churnRiskPct),
            reason: row.reason ? String(row.reason) : null,
            suggestedAction: String(row.suggestedAction ?? "Send retention email"),
          } satisfies ChurnRiskSignal;
        })
        .filter((item): item is ChurnRiskSignal => Boolean(item))
    : [];

  return {
    generatedAt: String(raw.generatedAt ?? new Date().toISOString()),
    months: Math.max(6, Math.min(24, toNumber(raw.months, 12))),
    metrics: {
      mrr: toNumber(metrics?.mrr),
      mrrMoMChangePct:
        metrics?.mrrMoMChangePct === null || metrics?.mrrMoMChangePct === undefined
          ? null
          : toNumber(metrics.mrrMoMChangePct),
      arr: toNumber(metrics?.arr),
      churnRatePct: toNumber(metrics?.churnRatePct),
      newMrrThisMonth: toNumber(metrics?.newMrrThisMonth),
      expansionMrr: toNumber(metrics?.expansionMrr),
      trialConversionRatePct: toNumber(metrics?.trialConversionRatePct),
    },
    charts: {
      mrrGrowth,
      revenueByPlan,
      newVsChurned,
      trialConversionFunnel,
    },
    topTenantsByMrr,
    churnRiskSignals,
  };
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPct(value: number | null) {
  if (value === null || Number.isNaN(value)) return "N/A";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function csvEscape(value: unknown) {
  const raw = value === null || value === undefined ? "" : String(value);
  return `"${raw.replace(/"/g, '""')}"`;
}

function planBadgeClass(plan: string) {
  if (plan === "enterprise") return "bg-amber-100 text-amber-800";
  if (plan === "business") return "bg-blue-100 text-blue-800";
  if (plan === "pro") return "bg-violet-100 text-violet-800";
  return "bg-slate-200 text-slate-700";
}

function riskClass(value: number) {
  if (value >= 75) return "text-rose-700";
  if (value >= 45) return "text-amber-700";
  return "text-emerald-700";
}

export default function PlatformAdminRevenue() {
  const { toast } = useToast();
  const [months, setMonths] = useState("12");
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<RevenuePayload>(EMPTY_PAYLOAD);
  const [sendingTenantId, setSendingTenantId] = useState<string | null>(null);

  const loadPayload = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await invokeEdge("platform-admin-revenue", {
        body: {
          operation: "get_payload",
          months: Number(months),
        },
      });

      if (error) throw error;
      const response = asRecord(data);
      setPayload(normalizePayload(response?.payload));
    } catch (error) {
      toast({
        title: "Could not load revenue dashboard",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [months, toast]);

  useEffect(() => {
    void loadPayload();
  }, [loadPayload]);

  const sendRetentionEmail = useCallback(
    async (tenant: ChurnRiskSignal) => {
      setSendingTenantId(tenant.tenantId);
      try {
        const { error } = await invokeEdge("platform-admin-revenue", {
          body: {
            operation: "send_retention_email",
            tenantId: tenant.tenantId,
            note: `Automated retention workflow from revenue dashboard for ${tenant.company}`,
          },
        });

        if (error) throw error;
        toast({
          title: "Retention email queued",
          description: `Queued retention outreach for ${tenant.company}.`,
        });
      } catch (error) {
        toast({
          title: "Could not send retention email",
          description: normalizeError(error),
          variant: "destructive",
        });
      } finally {
        setSendingTenantId(null);
      }
    },
    [toast],
  );

  const exportCsv = () => {
    const lines = [
      ["Company", "Plan", "MRR", "Since", "LTV", "Churn Risk %"].map(csvEscape).join(","),
      ...payload.topTenantsByMrr.map((row) =>
        [
          row.company,
          row.plan,
          row.mrr.toFixed(2),
          row.since,
          row.ltv.toFixed(2),
          row.churnRiskPct.toFixed(1),
        ]
          .map(csvEscape)
          .join(","),
      ),
      "",
      ["Churn Risk Signals"].map(csvEscape).join(","),
      ["Company", "Risk %", "Reason"].map(csvEscape).join(","),
      ...payload.churnRiskSignals.map((row) => [row.company, row.churnRiskPct.toFixed(1), row.reason ?? ""]
        .map(csvEscape)
        .join(",")),
    ];

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `opsai-platform-revenue-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const exportPdf = () => {
    const report = window.open("", "_blank", "noopener,noreferrer,width=1000,height=800");
    if (!report) {
      toast({
        title: "Popup blocked",
        description: "Enable popups to export PDF report.",
        variant: "destructive",
      });
      return;
    }

    const topRows = payload.topTenantsByMrr
      .map(
        (row) => `
        <tr>
          <td>${row.company}</td>
          <td>${row.plan}</td>
          <td>${formatCurrency(row.mrr)}</td>
          <td>${new Date(row.since).toLocaleDateString()}</td>
          <td>${formatCurrency(row.ltv)}</td>
          <td>${row.churnRiskPct.toFixed(1)}%</td>
        </tr>`,
      )
      .join("");

    report.document.write(`
      <html>
        <head>
          <title>OpsAI Platform Revenue Report</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 24px; color: #0f172a; }
            h1 { margin-bottom: 6px; }
            .muted { color: #64748b; margin-bottom: 16px; }
            .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
            .card { border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 12px; }
            .label { font-size: 12px; color: #64748b; }
            .value { font-size: 20px; font-weight: 700; margin-top: 4px; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            th, td { border: 1px solid #e2e8f0; padding: 8px; text-align: left; font-size: 12px; }
            th { background: #f8fafc; }
          </style>
        </head>
        <body>
          <h1>OpsAI Platform Revenue Dashboard</h1>
          <p class="muted">Generated ${new Date(payload.generatedAt).toLocaleString()}</p>

          <div class="kpis">
            <div class="card"><div class="label">MRR</div><div class="value">${formatCurrency(payload.metrics.mrr)}</div></div>
            <div class="card"><div class="label">ARR</div><div class="value">${formatCurrency(payload.metrics.arr)}</div></div>
            <div class="card"><div class="label">Churn Rate</div><div class="value">${payload.metrics.churnRatePct.toFixed(2)}%</div></div>
            <div class="card"><div class="label">New MRR (Month)</div><div class="value">${formatCurrency(payload.metrics.newMrrThisMonth)}</div></div>
            <div class="card"><div class="label">Expansion MRR</div><div class="value">${formatCurrency(payload.metrics.expansionMrr)}</div></div>
            <div class="card"><div class="label">Trial Conversion</div><div class="value">${payload.metrics.trialConversionRatePct.toFixed(2)}%</div></div>
          </div>

          <h2>Top Tenants by MRR</h2>
          <table>
            <thead>
              <tr>
                <th>Company</th><th>Plan</th><th>MRR</th><th>Since</th><th>LTV</th><th>Churn Risk</th>
              </tr>
            </thead>
            <tbody>${topRows}</tbody>
          </table>
        </body>
      </html>
    `);
    report.document.close();
    report.focus();
    report.print();
  };

  const trendDirection = (payload.metrics.mrrMoMChangePct ?? 0) >= 0;

  return (
    <div className="space-y-6 animate-fade-in">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-600">Platform Super Admin</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Revenue Dashboard</h1>
        <p className="text-sm text-muted-foreground">Revenue analytics, churn risk, and retention workflows across all tenants.</p>
      </header>

      <nav className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
        <div className="flex flex-wrap gap-1">
          {SUB_NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
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

      <section className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Select value={months} onValueChange={setMonths}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Range" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="6">Last 6 months</SelectItem>
              <SelectItem value="12">Last 12 months</SelectItem>
              <SelectItem value="18">Last 18 months</SelectItem>
              <SelectItem value="24">Last 24 months</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => void loadPayload()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Refresh
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={exportCsv}>
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
          <Button variant="outline" onClick={exportPdf}>
            <FileText className="h-4 w-4" />
            Export PDF
          </Button>
        </div>
      </section>

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-80 w-full rounded-xl" />
          <Skeleton className="h-80 w-full rounded-xl" />
        </div>
      ) : (
        <>
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-slate-500">MRR</p>
              <p className="mt-1 text-3xl font-bold text-slate-900">{formatCurrency(payload.metrics.mrr)}</p>
              <p className={cn("mt-1 inline-flex items-center gap-1 text-xs font-medium", trendDirection ? "text-emerald-700" : "text-rose-700")}>
                {trendDirection ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                {formatPct(payload.metrics.mrrMoMChangePct)} MoM
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-slate-500">ARR</p>
              <p className="mt-1 text-3xl font-bold text-slate-900">{formatCurrency(payload.metrics.arr)}</p>
              <p className="mt-1 text-xs text-slate-500">Annualized recurring revenue</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-slate-500">Churn Rate</p>
              <p className="mt-1 text-3xl font-bold text-slate-900">{payload.metrics.churnRatePct.toFixed(2)}%</p>
              <p className="mt-1 text-xs text-slate-500">Current month tenant churn</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-slate-500">New MRR (Month)</p>
              <p className="mt-1 text-3xl font-bold text-slate-900">{formatCurrency(payload.metrics.newMrrThisMonth)}</p>
              <p className="mt-1 text-xs text-slate-500">MRR from newly created tenants</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-slate-500">Expansion MRR</p>
              <p className="mt-1 text-3xl font-bold text-slate-900">{formatCurrency(payload.metrics.expansionMrr)}</p>
              <p className="mt-1 text-xs text-slate-500">Upgrades this month</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-slate-500">Trial Conversion Rate</p>
              <p className="mt-1 text-3xl font-bold text-slate-900">{payload.metrics.trialConversionRatePct.toFixed(2)}%</p>
              <p className="mt-1 text-xs text-slate-500">Signed up to paid conversion</p>
            </div>
          </section>

          <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">MRR Growth</h2>
              <p className="text-xs text-slate-500">Last {payload.months} months trend</p>
              <div className="mt-3 h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={payload.charts.mrrGrowth}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
                    <YAxis tickLine={false} axisLine={false} fontSize={11} tickFormatter={(value) => `$${Math.round(value / 1000)}k`} />
                    <Tooltip formatter={(value: number) => formatCurrency(value)} />
                    <Line type="monotone" dataKey="mrr" stroke="#7c3aed" strokeWidth={2.5} dot={{ r: 2 }} activeDot={{ r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">Revenue by Plan</h2>
              <p className="text-xs text-slate-500">Starter / Pro / Business / Enterprise</p>
              <div className="mt-3 h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={payload.charts.revenueByPlan}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
                    <YAxis tickLine={false} axisLine={false} fontSize={11} tickFormatter={(value) => `$${Math.round(value / 1000)}k`} />
                    <Tooltip formatter={(value: number) => formatCurrency(value)} />
                    <Legend />
                    <Bar dataKey="starter" stackId="revenue" fill={PLAN_COLORS.starter} name="Starter" />
                    <Bar dataKey="pro" stackId="revenue" fill={PLAN_COLORS.pro} name="Pro" />
                    <Bar dataKey="business" stackId="revenue" fill={PLAN_COLORS.business} name="Business" />
                    <Bar dataKey="enterprise" stackId="revenue" fill={PLAN_COLORS.enterprise} name="Enterprise" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </section>

          <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">New vs Churned Tenants</h2>
              <p className="text-xs text-slate-500">Monthly acquisition and churn trend</p>
              <div className="mt-3 h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={payload.charts.newVsChurned}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
                    <YAxis tickLine={false} axisLine={false} fontSize={11} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="newTenants" fill="#10b981" name="New" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="churnedTenants" fill="#ef4444" name="Churned" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">Trial Conversion Funnel</h2>
              <p className="text-xs text-slate-500">Signed Up → Activated → Trial → Paid</p>
              <div className="mt-3 h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <FunnelChart>
                    <Tooltip />
                    <Funnel
                      dataKey="count"
                      data={payload.charts.trialConversionFunnel}
                      isAnimationActive
                      stroke="#ffffff"
                      fill="#7c3aed"
                    >
                      <LabelList position="right" fill="#334155" stroke="none" dataKey="stage" />
                    </Funnel>
                  </FunnelChart>
                </ResponsiveContainer>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">Top 20 Tenants by MRR</h2>
            <div className="mt-3 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead className="text-right">MRR</TableHead>
                    <TableHead>Since</TableHead>
                    <TableHead className="text-right">LTV</TableHead>
                    <TableHead className="text-right">Churn Risk</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payload.topTenantsByMrr.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-10 text-center text-sm text-slate-500">
                        No tenant revenue data available.
                      </TableCell>
                    </TableRow>
                  ) : (
                    payload.topTenantsByMrr.map((row) => (
                      <TableRow key={row.tenantId}>
                        <TableCell className="font-medium text-slate-900">{row.company}</TableCell>
                        <TableCell>
                          <Badge className={cn("capitalize", planBadgeClass(row.plan))}>{row.plan}</Badge>
                        </TableCell>
                        <TableCell className="text-right font-medium">{formatCurrency(row.mrr)}</TableCell>
                        <TableCell>{new Date(row.since).toLocaleDateString()}</TableCell>
                        <TableCell className="text-right">{formatCurrency(row.ltv)}</TableCell>
                        <TableCell className={cn("text-right font-medium", riskClass(row.churnRiskPct))}>
                          {row.churnRiskPct.toFixed(1)}%
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">Churn Risk Signals</h2>
            <p className="mt-1 text-xs text-slate-500">AI-calculated engagement and usage risk indicators.</p>

            <div className="mt-3 space-y-2">
              {payload.churnRiskSignals.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                  No elevated churn risk signals detected.
                </div>
              ) : (
                payload.churnRiskSignals.map((signal) => (
                  <div key={signal.tenantId} className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{signal.company}</p>
                      <p className="text-xs text-slate-600">
                        <span className={cn("font-semibold", riskClass(signal.churnRiskPct))}>{signal.churnRiskPct.toFixed(1)}% churn risk</span>
                        {signal.reason ? ` (${signal.reason})` : ""}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void sendRetentionEmail(signal)}
                      disabled={sendingTenantId === signal.tenantId}
                    >
                      {sendingTenantId === signal.tenantId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                      Send retention email
                    </Button>
                  </div>
                ))
              )}
            </div>
          </section>

          <footer className="text-xs text-slate-500">
            Updated: {new Date(payload.generatedAt).toLocaleString()} · Window: last {payload.months} months.
          </footer>
        </>
      )}
    </div>
  );
}
