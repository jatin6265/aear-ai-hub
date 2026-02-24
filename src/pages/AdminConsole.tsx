import { useCallback, useEffect, useMemo, useState } from "react";
import { format, subDays } from "date-fns";
import {
  AlertCircle,
  ArrowRight,
  BadgeCheck,
  Download,
  Link2,
  Settings,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { formatEdgeFunctionError, sanitizeConnectionErrorMessage } from "@/lib/edge-function-error";
import { invokeEdge } from "@/lib/edge-invoke";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

type RecentAdminEvent = {
  id: string;
  message: string;
  createdAt: string;
  actorName: string;
  action: string;
  resource: string;
};

type AdminOverviewPayload = {
  profileRole: string;
  isAdmin: boolean;
  workspaceHealthScore: number;
  healthBreakdown: {
    connectionHealth: number;
    raciCoverage: number;
    auditLogClean: number;
    billingCurrent: number;
  };
  stats: {
    connections: { total: number; healthy: number; errors: number };
    teamMembers: { active: number; pending: number };
    raciRules: { defined: number; coverageScore: number };
    pendingApprovals: number;
    agents: { active: number; total: number };
  };
  recentAdminEvents: RecentAdminEvent[];
  riskOverview: {
    raciDistribution: Array<{ type: "R" | "A" | "C" | "I"; count: number }>;
    criticalResources: { covered: number; uncovered: number; total: number };
  };
};

const EMPTY_PAYLOAD: AdminOverviewPayload = {
  profileRole: "member",
  isAdmin: false,
  workspaceHealthScore: 0,
  healthBreakdown: {
    connectionHealth: 0,
    raciCoverage: 0,
    auditLogClean: 0,
    billingCurrent: 0,
  },
  stats: {
    connections: { total: 0, healthy: 0, errors: 0 },
    teamMembers: { active: 0, pending: 0 },
    raciRules: { defined: 0, coverageScore: 0 },
    pendingApprovals: 0,
    agents: { active: 0, total: 0 },
  },
  recentAdminEvents: [],
  riskOverview: {
    raciDistribution: [
      { type: "R", count: 0 },
      { type: "A", count: 0 },
      { type: "C", count: 0 },
      { type: "I", count: 0 },
    ],
    criticalResources: { covered: 0, uncovered: 0, total: 0 },
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizePayload(value: unknown): AdminOverviewPayload {
  const raw = asRecord(value);
  if (!raw) return EMPTY_PAYLOAD;

  const breakdown = asRecord(raw.healthBreakdown);
  const stats = asRecord(raw.stats);
  const connections = asRecord(stats?.connections);
  const teamMembers = asRecord(stats?.teamMembers);
  const raciRules = asRecord(stats?.raciRules);
  const agents = asRecord(stats?.agents);
  const riskOverview = asRecord(raw.riskOverview);
  const criticalResources = asRecord(riskOverview?.criticalResources);

  const events = Array.isArray(raw.recentAdminEvents)
    ? raw.recentAdminEvents
        .map((event) => {
          const item = asRecord(event);
          if (!item) return null;

          const id = String(item.id ?? "").trim();
          const message = String(item.message ?? "").trim();
          if (!id || !message) return null;

          return {
            id,
            message,
            createdAt: String(item.createdAt ?? ""),
            actorName: String(item.actorName ?? "Admin"),
            action: String(item.action ?? ""),
            resource: String(item.resource ?? ""),
          } satisfies RecentAdminEvent;
        })
        .filter((event): event is RecentAdminEvent => Boolean(event))
    : [];

  const distributionMap: Record<"R" | "A" | "C" | "I", number> = { R: 0, A: 0, C: 0, I: 0 };
  if (Array.isArray(riskOverview?.raciDistribution)) {
    riskOverview.raciDistribution.forEach((entry) => {
      const row = asRecord(entry);
      if (!row) return;
      const type = String(row.type ?? "").toUpperCase();
      const count = Number(row.count ?? 0) || 0;
      if (type === "R" || type === "A" || type === "C" || type === "I") {
        distributionMap[type] = count;
      }
    });
  }

  return {
    profileRole: String(raw.profileRole ?? "member"),
    isAdmin: raw.isAdmin === true,
    workspaceHealthScore: Math.max(0, Math.min(100, Number(raw.workspaceHealthScore ?? 0) || 0)),
    healthBreakdown: {
      connectionHealth: Math.max(0, Math.min(100, Number(breakdown?.connectionHealth ?? 0) || 0)),
      raciCoverage: Math.max(0, Math.min(100, Number(breakdown?.raciCoverage ?? 0) || 0)),
      auditLogClean: Math.max(0, Math.min(100, Number(breakdown?.auditLogClean ?? 0) || 0)),
      billingCurrent: Math.max(0, Math.min(100, Number(breakdown?.billingCurrent ?? 0) || 0)),
    },
    stats: {
      connections: {
        total: Number(connections?.total ?? 0) || 0,
        healthy: Number(connections?.healthy ?? 0) || 0,
        errors: Number(connections?.errors ?? 0) || 0,
      },
      teamMembers: {
        active: Number(teamMembers?.active ?? 0) || 0,
        pending: Number(teamMembers?.pending ?? 0) || 0,
      },
      raciRules: {
        defined: Number(raciRules?.defined ?? 0) || 0,
        coverageScore: Number(raciRules?.coverageScore ?? 0) || 0,
      },
      pendingApprovals: Number(stats?.pendingApprovals ?? 0) || 0,
      agents: {
        active: Number(agents?.active ?? 0) || 0,
        total: Number(agents?.total ?? 0) || 0,
      },
    },
    recentAdminEvents: events,
    riskOverview: {
      raciDistribution: [
        { type: "R", count: distributionMap.R },
        { type: "A", count: distributionMap.A },
        { type: "C", count: distributionMap.C },
        { type: "I", count: distributionMap.I },
      ],
      criticalResources: {
        covered: Number(criticalResources?.covered ?? 0) || 0,
        uncovered: Number(criticalResources?.uncovered ?? 0) || 0,
        total: Number(criticalResources?.total ?? 0) || 0,
      },
    },
  };
}

function formatRelativeTime(value: string) {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "Unknown";
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
  return `${Math.floor(diff / 86_400_000)} days ago`;
}

function csvEscape(value: unknown) {
  const raw = value === null || value === undefined ? "" : String(value);
  return `"${raw.replace(/"/g, '""')}"`;
}

type HealthGaugeProps = {
  value: number;
};

function HealthGauge({ value }: HealthGaugeProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const stroke = circumference * (1 - clamped / 100);

  const ringColor = clamped >= 80 ? "#10b981" : clamped >= 60 ? "#f59e0b" : "#ef4444";

  return (
    <div className="relative mx-auto h-36 w-36">
      <svg className="h-full w-full -rotate-90" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="8" />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke={ringColor}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={stroke}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <p className="text-3xl font-bold text-slate-900">{clamped}</p>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Score</p>
      </div>
    </div>
  );
}

function RaciDonut({ distribution }: { distribution: Array<{ type: "R" | "A" | "C" | "I"; count: number }> }) {
  const total = distribution.reduce((sum, item) => sum + item.count, 0);
  const stops = distribution.map((item) => ({
    ...item,
    pct: total > 0 ? (item.count / total) * 100 : 0,
  }));

  let current = 0;
  const gradientStops = stops.map((item) => {
    const start = current;
    current += item.pct;
    const color = item.type === "R" ? "#7c3aed" : item.type === "A" ? "#f59e0b" : item.type === "C" ? "#2563eb" : "#64748b";
    return `${color} ${start.toFixed(2)}% ${current.toFixed(2)}%`;
  });

  return (
    <div className="flex items-center gap-4">
      <div className="relative h-28 w-28 rounded-full" style={{ background: `conic-gradient(${gradientStops.join(", ")})` }}>
        <div className="absolute inset-3 rounded-full bg-white" />
        <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-slate-700">{total}</div>
      </div>

      <div className="space-y-1.5 text-xs">
        {stops.map((item) => (
          <p key={item.type} className="flex items-center gap-2 text-slate-700">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{
                backgroundColor:
                  item.type === "R" ? "#7c3aed" : item.type === "A" ? "#f59e0b" : item.type === "C" ? "#2563eb" : "#64748b",
              }}
            />
            <span className="font-semibold">{item.type}</span>
            <span>{item.count}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

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

export default function AdminConsole() {
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [tenantId, setTenantId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<AdminOverviewPayload>(EMPTY_PAYLOAD);
  const [exportingAudit, setExportingAudit] = useState(false);

  useEffect(() => {
    if (!user) {
      setTenantId(null);
      setPayload(EMPTY_PAYLOAD);
      setLoading(false);
      return;
    }

    let cancelled = false;

    const bootstrap = async () => {
      try {
        const workspace = await ensureUserWorkspace(user);
        if (!cancelled) setTenantId(workspace.tenantId);
      } catch (error) {
        if (cancelled) return;
        setLoading(false);
        toast({
          title: "Could not load workspace",
          description: error instanceof Error ? error.message : "Please refresh and try again.",
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

      try {
        const { data, error } = await invokeEdge("admin-console", {
          body: {
            operation: "get_payload",
          },
        });

        if (error) {
          const parsed = sanitizeConnectionErrorMessage(
            await formatEdgeFunctionError(error, { functionName: "admin-console" }),
          );
          throw new Error(parsed);
        }
        setPayload(normalizePayload((data as { payload?: unknown } | null)?.payload ?? null));
      } catch (error) {
        toast({
          title: "Could not load admin console",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        });
      } finally {
        if (withLoading) setLoading(false);
      }
    },
    [tenantId, toast],
  );

  useEffect(() => {
    if (!tenantId) return;
    void loadPayload(true);
  }, [tenantId, loadPayload]);

  useEffect(() => {
    if (!tenantId) return;

    const tables = [
      "api_connections",
      "raci_matrix",
      "ai_agents",
      "profiles",
      "team_invitations",
      "subscriptions",
      "approval_requests",
      "audit_logs",
    ];

    const channel = supabase.channel(`admin-console-${tenantId}`);

    tables.forEach((tableName) => {
      channel.on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: tableName,
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

  const quickActions = [
    {
      title: "Add Connection",
      description: "Create a new data source",
      icon: Link2,
      onClick: () => navigate("/connections/new"),
    },
    {
      title: "Configure RACI",
      description: "Define role responsibilities",
      icon: ShieldCheck,
      onClick: () => navigate("/raci"),
    },
    {
      title: "Invite User",
      description: "Add teammates",
      icon: UserPlus,
      onClick: () => navigate("/team"),
    },
    {
      title: "View Billing",
      description: "Check usage and plans",
      icon: BadgeCheck,
      onClick: () => navigate("/billing"),
    },
    {
      title: "Download Audit Log",
      description: "Export CSV snapshot",
      icon: Download,
      onClick: async () => {
        setExportingAudit(true);
        try {
          const dateFrom = format(subDays(new Date(), 6), "yyyy-MM-dd");
          const dateTo = format(new Date(), "yyyy-MM-dd");

          const { data, error } = await invokeEdge("audit-log", {
            body: {
              operation: "get_payload",
              dateFrom,
              dateTo,
              limit: 500,
              offset: 0,
            },
          });

          if (error) {
            const parsed = sanitizeConnectionErrorMessage(
              await formatEdgeFunctionError(error, { functionName: "audit-log" }),
            );
            throw new Error(parsed);
          }

          const rows = (asRecord(data)?.payload && asRecord(asRecord(data)?.payload)?.rows)
            ? (asRecord(asRecord(data)?.payload)?.rows as unknown[])
            : [];

          const csvRows = Array.isArray(rows) ? rows : [];

          const headers = ["Time", "User", "Agent", "Action", "Resource", "Risk", "Status", "Details"];
          const lines = csvRows.map((rowValue) => {
            const row = asRecord(rowValue) ?? {};
            return [
              row.createdAt ?? "",
              row.userName ?? "",
              row.agent ?? "",
              row.action ?? "",
              row.resource ?? "",
              row.riskLevel ?? "",
              row.status ?? "",
              JSON.stringify(row.details ?? {}),
            ]
              .map(csvEscape)
              .join(",");
          });

          const csv = [headers.map(csvEscape).join(","), ...lines].join("\n");
          const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `admin-audit-log-${format(new Date(), "yyyyMMdd-HHmmss")}.csv`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);
        } catch (error) {
          toast({
            title: "Audit export failed",
            description: error instanceof Error ? error.message : "Please try again.",
            variant: "destructive",
          });
        } finally {
          setExportingAudit(false);
        }
      },
      busy: exportingAudit,
    },
    {
      title: "Configure Guardrails",
      description: "Tune safety policies",
      icon: Settings,
      onClick: () => navigate("/guardrails"),
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

      <section className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Workspace Health Score</h2>
          {loading ? (
            <div className="mt-4"><Skeleton className="mx-auto h-36 w-36 rounded-full" /></div>
          ) : (
            <>
              <div className="mt-3"><HealthGauge value={payload.workspaceHealthScore} /></div>
              <div className="mt-4 space-y-2 text-xs">
                <p className="flex items-center justify-between"><span className="text-slate-600">Connection health</span><span className="font-semibold text-slate-900">{payload.healthBreakdown.connectionHealth}</span></p>
                <p className="flex items-center justify-between"><span className="text-slate-600">RACI coverage</span><span className="font-semibold text-slate-900">{payload.healthBreakdown.raciCoverage}</span></p>
                <p className="flex items-center justify-between"><span className="text-slate-600">Audit log clean</span><span className="font-semibold text-slate-900">{payload.healthBreakdown.auditLogClean}</span></p>
                <p className="flex items-center justify-between"><span className="text-slate-600">Billing current</span><span className="font-semibold text-slate-900">{payload.healthBreakdown.billingCurrent}</span></p>
              </div>
            </>
          )}
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Quick Actions</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {quickActions.map((action) => (
              <button
                key={action.title}
                type="button"
                onClick={() => void action.onClick()}
                disabled={Boolean(action.busy)}
                className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-left transition hover:border-violet-200 hover:bg-violet-50 disabled:cursor-wait"
              >
                <div className="flex items-center justify-between">
                  <action.icon className="h-4 w-4 text-violet-700" />
                  {action.busy ? <Loader2 className="h-4 w-4 animate-spin text-violet-700" /> : <ArrowRight className="h-4 w-4 text-slate-400" />}
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-900">{action.title}</p>
                <p className="mt-1 text-xs text-slate-600">{action.description}</p>
              </button>
            ))}
          </div>
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">Workspace Stats</h2>

            {loading ? (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={`admin-stat-skeleton-${index}`} className="h-20 w-full" />
                ))}
              </div>
            ) : (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Connected Sources</p>
                  <p className="mt-2 text-xl font-bold text-slate-900">{payload.stats.connections.total}</p>
                  <p className="mt-1 text-xs text-slate-600">{payload.stats.connections.healthy} healthy, {payload.stats.connections.errors} errors</p>
                </div>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Team Members</p>
                  <p className="mt-2 text-xl font-bold text-slate-900">{payload.stats.teamMembers.active}</p>
                  <p className="mt-1 text-xs text-slate-600">{payload.stats.teamMembers.pending} pending invites</p>
                </div>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">RACI Rules</p>
                  <p className="mt-2 text-xl font-bold text-slate-900">{payload.stats.raciRules.defined}</p>
                  <p className="mt-1 text-xs text-slate-600">Coverage score {payload.stats.raciRules.coverageScore}%</p>
                </div>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Pending Approvals</p>
                  <p className="mt-2 text-xl font-bold text-slate-900">{payload.stats.pendingApprovals}</p>
                  <Link to="/dashboard/approvals" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-violet-700 hover:text-violet-800">
                    Review approvals
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 md:col-span-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">AI Agents Active</p>
                  <p className="mt-2 text-xl font-bold text-slate-900">{payload.stats.agents.active} of {payload.stats.agents.total}</p>
                </div>
              </div>
            )}
          </article>

          <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">Recent Admin Events</h2>
            <div className="mt-4 space-y-3">
              {loading ? (
                Array.from({ length: 4 }).map((_, index) => <Skeleton key={`admin-event-skeleton-${index}`} className="h-14 w-full" />)
              ) : payload.recentAdminEvents.length === 0 ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                  No admin-level events yet.
                </div>
              ) : (
                payload.recentAdminEvents.slice(0, 10).map((event) => (
                  <article key={event.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                    <p className="text-sm font-medium text-slate-900">{event.message}</p>
                    <p className="mt-1 text-xs text-slate-600">{formatRelativeTime(event.createdAt)}</p>
                  </article>
                ))
              )}
            </div>
          </article>
        </div>

        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Risk Overview</h2>
          <p className="mt-1 text-xs text-slate-600">Distribution of RACI rules by type.</p>

          {loading ? (
            <div className="mt-4 space-y-3">
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            <>
              <div className="mt-4">
                <RaciDonut distribution={payload.riskOverview.raciDistribution} />
              </div>

              <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Critical resources</p>
                <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-xl font-bold text-emerald-700">{payload.riskOverview.criticalResources.covered}</p>
                    <p className="text-[11px] text-slate-600">Covered</p>
                  </div>
                  <div>
                    <p className="text-xl font-bold text-red-700">{payload.riskOverview.criticalResources.uncovered}</p>
                    <p className="text-[11px] text-slate-600">Uncovered</p>
                  </div>
                  <div>
                    <p className="text-xl font-bold text-slate-900">{payload.riskOverview.criticalResources.total}</p>
                    <p className="text-[11px] text-slate-600">Total</p>
                  </div>
                </div>
              </div>
            </>
          )}

          {!payload.isAdmin ? (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              Your role is {payload.profileRole}. Admin role is required for this console.
            </div>
          ) : null}
        </article>
      </section>
    </div>
  );
}
