import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Braces,
  CalendarDays,
  Clock3,
  Database,
  MessageSquare,
  Network,
  NotebookPen,
  Plug,
  Plus,
  Sheet,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Workflow,
} from "lucide-react";
import { invokeEdge } from "@/lib/edge-invoke";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { format } from "date-fns";
import { useAuth } from "@/hooks/useAuth";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { supabase } from "@/integrations/supabase/client";
import type { Database as SupabaseDatabase } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type ApiConnectionRow = SupabaseDatabase["public"]["Tables"]["api_connections"]["Row"];
type AuditLogRow = Pick<
  SupabaseDatabase["public"]["Tables"]["audit_logs"]["Row"],
  "id" | "action" | "resource" | "status" | "risk_level" | "created_at"
>;

type SparkPoint = {
  day: string;
  value: number;
};

type ActivityItem = {
  id: string;
  title: string;
  subtitle: string;
  timestamp: string;
  route: string;
  icon: ComponentType<{ className?: string }>;
  tone: "neutral" | "warning" | "danger" | "positive";
};

type InsightItem = {
  id: string;
  title: string;
  description: string;
  viewRoute: string;
  actionRoute: string;
};

type DashboardState = {
  loading: boolean;
  error: string | null;
  activeConnections: number;
  totalConnections: number;
  connectionsTrend: SparkPoint[];
  messagesToday: number;
  messagesYesterday: number;
  pendingApprovals: number;
  aiActionsThisWeek: number;
  recentActivity: ActivityItem[];
  sourceStatuses: ApiConnectionRow[];
  insights: InsightItem[];
};

const INITIAL_STATE: DashboardState = {
  loading: true,
  error: null,
  activeConnections: 0,
  totalConnections: 0,
  connectionsTrend: [],
  messagesToday: 0,
  messagesYesterday: 0,
  pendingApprovals: 0,
  aiActionsThisWeek: 0,
  recentActivity: [],
  sourceStatuses: [],
  insights: [],
};

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function startOfWeek(date: Date) {
  const copy = startOfDay(date);
  const dayIndex = copy.getDay();
  const daysSinceMonday = (dayIndex + 6) % 7;
  copy.setDate(copy.getDate() - daysSinceMonday);
  return copy;
}

function getGreeting(currentDate: Date) {
  const hour = currentDate.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function getTypeIcon(type: string) {
  const value = type.toLowerCase();
  if (value.includes("postgres") || value.includes("mysql") || value.includes("mongo")) return Database;
  if (value.includes("sheet")) return Sheet;
  if (value.includes("notion")) return NotebookPen;
  if (value.includes("rest") || value.includes("openapi")) return Braces;
  return Plug;
}

function formatStatus(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "active") return "Active";
  if (normalized === "syncing" || normalized === "pending") return "Syncing";
  if (normalized === "error") return "Error";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusClasses(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "active") return "bg-emerald-100 text-emerald-700";
  if (normalized === "syncing" || normalized === "pending") return "bg-amber-100 text-amber-700";
  if (normalized === "error") return "bg-rose-100 text-rose-700";
  return "bg-slate-200 text-slate-700";
}

function formatRelativeTime(value: string | null) {
  if (!value) return "Never synced";
  const now = Date.now();
  const then = new Date(value).getTime();
  const diffMs = now - then;

  if (diffMs < 60_000) return "Just now";
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)}h ago`;
  return `${Math.round(diffMs / 86_400_000)}d ago`;
}

function mapActivity(log: AuditLogRow): ActivityItem {
  const lowerAction = log.action.toLowerCase();
  const lowerResource = log.resource.toLowerCase();

  let route = "/dashboard/audit";
  let icon: ComponentType<{ className?: string }> = Clock3;
  let tone: ActivityItem["tone"] = "neutral";

  if (lowerAction.includes("approval")) {
    route = "/dashboard/approvals";
    icon = Workflow;
  } else if (lowerAction.includes("chat") || lowerAction.includes("agent")) {
    route = "/dashboard/chat";
    icon = Bot;
  } else if (lowerAction.includes("sync") || lowerAction.includes("connection") || lowerResource.includes("api")) {
    route = "/dashboard/connections";
    icon = Plug;
  } else if (lowerAction.includes("anomaly") || lowerAction.includes("insight")) {
    route = "/dashboard/insights";
    icon = Sparkles;
  }

  if (log.risk_level?.toLowerCase() === "high" || log.status?.toLowerCase() === "error") {
    tone = "danger";
    if (!lowerAction.includes("approval")) icon = AlertTriangle;
  } else if (log.risk_level?.toLowerCase() === "medium" || log.status?.toLowerCase() === "pending") {
    tone = "warning";
  } else if (log.status?.toLowerCase() === "success" || log.status?.toLowerCase() === "approved") {
    tone = "positive";
  }

  return {
    id: log.id,
    title: log.action.replaceAll("_", " "),
    subtitle: log.resource,
    timestamp: formatRelativeTime(log.created_at),
    route,
    icon,
    tone,
  };
}

function buildConnectionTrend(connections: ApiConnectionRow[]) {
  const today = startOfDay(new Date());
  const days = Array.from({ length: 7 }).map((_, index) => {
    const current = new Date(today);
    current.setDate(today.getDate() - (6 - index));
    return current;
  });

  return days.map((day) => {
    const dayStart = startOfDay(day).getTime();
    const dayEnd = endOfDay(day).getTime();
    const count = connections.filter((connection) => {
      const createdTime = new Date(connection.created_at).getTime();
      return createdTime >= dayStart && createdTime <= dayEnd;
    }).length;
    return {
      day: format(day, "EEE"),
      value: count,
    };
  });
}

function buildInsights(input: {
  activeConnections: number;
  totalConnections: number;
  pendingApprovals: number;
  messagesToday: number;
  messagesYesterday: number;
  aiActionsThisWeek: number;
}): InsightItem[] {
  const syncHealth =
    input.totalConnections === 0
      ? "No connected sources yet."
      : `${Math.round((input.activeConnections / input.totalConnections) * 100)}% of sources are currently active.`;
  const messageDelta = input.messagesToday - input.messagesYesterday;
  const messageLine =
    messageDelta >= 0
      ? `Conversation volume is up by ${messageDelta} vs yesterday.`
      : `Conversation volume is down by ${Math.abs(messageDelta)} vs yesterday.`;

  return [
    {
      id: "health",
      title: "Source sync health snapshot",
      description: syncHealth,
      viewRoute: "/dashboard/connections",
      actionRoute: "/dashboard/connections",
    },
    {
      id: "approval",
      title: "Approval bottleneck risk",
      description:
        input.pendingApprovals > 0
          ? `${input.pendingApprovals} request(s) are waiting for decision and may delay automations.`
          : "No pending approval bottlenecks detected right now.",
      viewRoute: "/dashboard/approvals",
      actionRoute: "/dashboard/approvals",
    },
    {
      id: "ai-usage",
      title: "AI assistant utilization signal",
      description: `${messageLine} ${input.aiActionsThisWeek} AI action(s) executed so far this week.`,
      viewRoute: "/dashboard/insights",
      actionRoute: "/dashboard/chat",
    },
  ];
}

function messageDeltaText(today: number, yesterday: number) {
  const delta = today - yesterday;
  if (delta === 0) return "No change vs yesterday";
  if (delta > 0) return `+${delta} vs yesterday`;
  return `${delta} vs yesterday`;
}

type CrossRiskDomain = { name: string; riskCount: number; maxSeverity: string };
type CrossRiskItem   = { title: string; severity: string; domain: string; detectedAt: string };
type CrossRiskData   = {
  correlationScore: number;
  affectedDomains:  number;
  riskLevel:        string;
  isCompound:       boolean;
  domains:          CrossRiskDomain[];
  topRisks:         CrossRiskItem[];
};

function riskLevelClass(level: string) {
  if (level === "critical") return "bg-red-100 text-red-700 border-red-200";
  if (level === "high")     return "bg-orange-100 text-orange-700 border-orange-200";
  if (level === "medium")   return "bg-amber-100 text-amber-700 border-amber-200";
  return "bg-emerald-100 text-emerald-700 border-emerald-200";
}

export default function Dashboard() {
  const { user } = useAuth();
  const [state, setState] = useState<DashboardState>(INITIAL_STATE);
  const [crossRisk, setCrossRisk] = useState<CrossRiskData | null>(null);
  const [crossRiskLoading, setCrossRiskLoading] = useState(false);

  useEffect(() => {
    if (!user) return;
    let active = true;

    const load = async () => {
      setState((prev) => ({ ...prev, loading: true, error: null }));

      try {
        const workspace = await ensureUserWorkspace(user);
        const tenantId = workspace.tenantId;
        const now = new Date();
        const todayStart = startOfDay(now);
        const tomorrowStart = new Date(todayStart);
        tomorrowStart.setDate(tomorrowStart.getDate() + 1);
        const yesterdayStart = new Date(todayStart);
        yesterdayStart.setDate(yesterdayStart.getDate() - 1);
        const weekStart = startOfWeek(now);

        const [
          connectionsResponse,
          approvalsCountResponse,
          chatSessionsResponse,
          usageEventsResponse,
          auditLogsResponse,
        ] = await Promise.all([
          supabase
            .from("api_connections")
            .select("id, name, type, status, last_synced_at, created_at, base_url, schema_detected, tenant_id")
            .eq("tenant_id", tenantId)
            .order("created_at", { ascending: false }),
          supabase
            .from("approval_requests")
            .select("id", { count: "exact", head: true })
            .eq("tenant_id", tenantId)
            .eq("status", "pending"),
          supabase.from("chat_sessions").select("id").eq("tenant_id", tenantId),
          supabase
            .from("usage_events")
            .select("quantity, metric_type")
            .eq("tenant_id", tenantId)
            .gte("recorded_at", weekStart.toISOString()),
          supabase
            .from("audit_logs")
            .select("id, action, resource, status, risk_level, created_at")
            .eq("tenant_id", tenantId)
            .order("created_at", { ascending: false })
            .limit(8),
        ]);

        if (connectionsResponse.error) throw connectionsResponse.error;
        if (approvalsCountResponse.error) throw approvalsCountResponse.error;
        if (chatSessionsResponse.error) throw chatSessionsResponse.error;
        if (usageEventsResponse.error) throw usageEventsResponse.error;
        if (auditLogsResponse.error) throw auditLogsResponse.error;

        const sessionIds = (chatSessionsResponse.data ?? []).map((session) => session.id);

        let messagesToday = 0;
        let messagesYesterday = 0;
        if (sessionIds.length > 0) {
          const [todayMessagesResponse, yesterdayMessagesResponse] = await Promise.all([
            supabase
              .from("chat_messages")
              .select("id", { count: "exact", head: true })
              .in("session_id", sessionIds)
              .gte("created_at", todayStart.toISOString())
              .lt("created_at", tomorrowStart.toISOString()),
            supabase
              .from("chat_messages")
              .select("id", { count: "exact", head: true })
              .in("session_id", sessionIds)
              .gte("created_at", yesterdayStart.toISOString())
              .lt("created_at", todayStart.toISOString()),
          ]);

          if (todayMessagesResponse.error) throw todayMessagesResponse.error;
          if (yesterdayMessagesResponse.error) throw yesterdayMessagesResponse.error;
          messagesToday = todayMessagesResponse.count ?? 0;
          messagesYesterday = yesterdayMessagesResponse.count ?? 0;
        }

        const sourceStatuses = (connectionsResponse.data ?? []) as ApiConnectionRow[];
        const activeConnections = sourceStatuses.filter((connection) => connection.status.toLowerCase() === "active").length;
        const pendingApprovals = approvalsCountResponse.count ?? 0;

        let aiActionsThisWeek = (usageEventsResponse.data ?? [])
          .filter((event) => event.metric_type === "ai_action_executed")
          .reduce((sum, event) => sum + Number(event.quantity ?? 0), 0);

        if (aiActionsThisWeek === 0) {
          aiActionsThisWeek = (auditLogsResponse.data ?? []).filter((log) => {
            const action = log.action.toLowerCase();
            return action.includes("execute") || action.includes("run") || action.includes("approve");
          }).length;
        }

        const trendData = buildConnectionTrend(sourceStatuses);
        const recentActivity = (auditLogsResponse.data ?? []).map((log) => mapActivity(log));
        const insights = buildInsights({
          activeConnections,
          totalConnections: sourceStatuses.length,
          pendingApprovals,
          messagesToday,
          messagesYesterday,
          aiActionsThisWeek,
        });

        if (!active) return;

        setState({
          loading: false,
          error: null,
          activeConnections,
          totalConnections: sourceStatuses.length,
          connectionsTrend: trendData,
          messagesToday,
          messagesYesterday,
          pendingApprovals,
          aiActionsThisWeek,
          recentActivity,
          sourceStatuses,
          insights,
        });
      } catch (error) {
        if (!active) return;
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "object" && error && "message" in error
              ? String((error as { message?: unknown }).message ?? "Could not load dashboard data.")
              : "Could not load dashboard data.";
        setState((prev) => ({
          ...prev,
          loading: false,
          error: message,
        }));
      }
    };

    void load();

    return () => {
      active = false;
    };
  // Only re-run when the authenticated user changes (not on same-user reference changes from TOKEN_REFRESHED).
  // The `user` object is stable within the closure; its `.id` is sufficient to detect login/logout.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Cross-domain risk correlation — loaded independently so it doesn't block main dashboard
  useEffect(() => {
    if (!user) return;
    let active = true;
    setCrossRiskLoading(true);
    void invokeEdge("risk-correlations", { body: {} }).then(({ data, error }) => {
      if (!active) return;
      if (!error && data && typeof data === "object" && "correlations" in data) {
        setCrossRisk(data.correlations as CrossRiskData);
      }
      setCrossRiskLoading(false);
    }).catch(() => {
      if (active) setCrossRiskLoading(false);
    });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const displayName = useMemo(() => {
    const fullName =
      typeof user?.user_metadata?.full_name === "string" && user.user_metadata.full_name.trim()
        ? user.user_metadata.full_name.trim()
        : "";
    if (fullName) return fullName.split(" ")[0];
    return user?.email?.split("@")[0] ?? "there";
  }, [user?.email, user?.user_metadata]);

  const now = new Date();
  const greetingText = getGreeting(now);
  const dateText = format(now, "EEEE, MMMM d");
  const messageDelta = state.messagesToday - state.messagesYesterday;
  const trendSeries = state.connectionsTrend.length > 0 ? state.connectionsTrend : [{ day: "Mon", value: 0 }];

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              {greetingText}, {displayName}
            </h1>
            <p className="mt-1 inline-flex items-center gap-2 text-sm text-slate-500">
              <CalendarDays className="h-4 w-4" />
              {dateText}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button asChild className="gap-2 bg-violet-600 text-white hover:bg-violet-700">
              <Link to="/dashboard/chat">
                <MessageSquare className="h-4 w-4" />
                Ask AI
              </Link>
            </Button>
            <Button asChild variant="outline" className="gap-2">
              <Link to="/dashboard/connections">
                <Plus className="h-4 w-4" />
                New Connection
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          {state.loading ? (
            <>
              <Skeleton className="h-4 w-28" />
              <Skeleton className="mt-3 h-8 w-24" />
              <Skeleton className="mt-4 h-14 w-full" />
            </>
          ) : (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Active Connections</p>
              <p className="mt-2 text-3xl font-semibold text-slate-900">{state.activeConnections}</p>
              <p className="mt-1 text-xs text-slate-500">of {state.totalConnections} connected sources</p>
              <div className="mt-3 h-14">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trendSeries}>
                    <defs>
                      <linearGradient id="connectionsTrend" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#7C3AED" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#7C3AED" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <Area type="monotone" dataKey="value" stroke="#7C3AED" strokeWidth={2} fill="url(#connectionsTrend)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          {state.loading ? (
            <>
              <Skeleton className="h-4 w-28" />
              <Skeleton className="mt-3 h-8 w-24" />
              <Skeleton className="mt-4 h-4 w-32" />
            </>
          ) : (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Messages Today</p>
              <p className="mt-2 text-3xl font-semibold text-slate-900">{state.messagesToday}</p>
              <p
                className={cn(
                  "mt-2 inline-flex items-center gap-1 text-xs font-medium",
                  messageDelta >= 0 ? "text-emerald-600" : "text-rose-600",
                )}
              >
                {messageDelta >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                {messageDeltaText(state.messagesToday, state.messagesYesterday)}
              </p>
            </>
          )}
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          {state.loading ? (
            <>
              <Skeleton className="h-4 w-28" />
              <Skeleton className="mt-3 h-8 w-24" />
              <Skeleton className="mt-4 h-4 w-24" />
            </>
          ) : (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Pending Approvals</p>
              <p
                className={cn(
                  "mt-2 text-3xl font-semibold",
                  state.pendingApprovals > 0 ? "text-amber-600" : "text-slate-900",
                )}
              >
                {state.pendingApprovals}
              </p>
              <Link to="/dashboard/approvals" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-violet-700 hover:text-violet-800">
                Go to approvals
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </>
          )}
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          {state.loading ? (
            <>
              <Skeleton className="h-4 w-36" />
              <Skeleton className="mt-3 h-8 w-24" />
              <Skeleton className="mt-4 h-4 w-28" />
            </>
          ) : (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">AI Actions Executed</p>
              <p className="mt-2 text-3xl font-semibold text-slate-900">{state.aiActionsThisWeek}</p>
              <p className="mt-2 text-xs text-slate-500">Tracked since Monday</p>
            </>
          )}
        </article>
      </section>

      <section className="grid gap-6 xl:grid-cols-5">
        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm xl:col-span-3">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Recent Activity</h2>
          </div>

          {state.loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="flex items-start gap-3 rounded-lg border border-slate-100 p-3">
                  <Skeleton className="h-9 w-9 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : state.recentActivity.length === 0 ? (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
              No recent events yet. Activity will appear after your first queries and syncs.
            </p>
          ) : (
            <div className="space-y-3">
              {state.recentActivity.map((item) => (
                <Link
                  key={item.id}
                  to={item.route}
                  className="flex items-start gap-3 rounded-lg border border-slate-200 px-3 py-3 transition-colors hover:bg-slate-50"
                >
                  <span
                    className={cn(
                      "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                      item.tone === "danger" && "bg-rose-100 text-rose-700",
                      item.tone === "warning" && "bg-amber-100 text-amber-700",
                      item.tone === "positive" && "bg-emerald-100 text-emerald-700",
                      item.tone === "neutral" && "bg-slate-100 text-slate-700",
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900">{item.title}</p>
                    <p className="truncate text-xs text-slate-500">{item.subtitle}</p>
                  </div>
                  <p className="shrink-0 text-xs text-slate-500">{item.timestamp}</p>
                </Link>
              ))}
            </div>
          )}

          <div className="mt-4">
            <Link to="/dashboard/audit" className="inline-flex items-center gap-1 text-sm font-medium text-violet-700 hover:text-violet-800">
              View all activity
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm xl:col-span-2">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">Connected Sources Status</h2>

          {state.loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="space-y-2 rounded-lg border border-slate-100 p-3">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="h-8 w-16" />
                </div>
              ))}
            </div>
          ) : state.sourceStatuses.length === 0 ? (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
              No connections found. Add your first source to begin sync and RAG indexing.
            </p>
          ) : (
            <div className="space-y-3">
              {state.sourceStatuses.slice(0, 6).map((source) => {
                const Icon = getTypeIcon(source.type);
                return (
                  <div key={source.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">{source.name}</p>
                        <p className="mt-0.5 text-xs text-slate-500">{source.type}</p>
                      </div>
                      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-700">
                        <Icon className="h-4 w-4" />
                      </span>
                    </div>
                    <div className="mt-3 flex items-center justify-between">
                      <Badge className={cn("border-0", statusClasses(source.status))}>{formatStatus(source.status)}</Badge>
                      <p className="text-xs text-slate-500">{formatRelativeTime(source.last_synced_at)}</p>
                    </div>
                    <Button asChild variant="outline" size="sm" className="mt-3">
                      <Link to="/dashboard/connections">View</Link>
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </article>
      </section>

      {/* Cross-Domain Risk Correlation */}
      {(crossRiskLoading || (crossRisk && (crossRisk.affectedDomains > 0 || crossRisk.correlationScore > 0))) && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <Network className="h-4 w-4 text-violet-600" />
            <h2 className="text-lg font-semibold text-slate-900">Cross-Domain Risk Correlation</h2>
            {crossRisk && !crossRiskLoading && (
              <span className={`ml-auto rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${riskLevelClass(crossRisk.riskLevel)}`}>
                {crossRisk.riskLevel} risk
              </span>
            )}
          </div>
          {crossRiskLoading ? (
            <div className="flex gap-4">
              <Skeleton className="h-16 w-1/3 rounded-lg" />
              <Skeleton className="h-16 w-1/3 rounded-lg" />
              <Skeleton className="h-16 w-1/3 rounded-lg" />
            </div>
          ) : crossRisk ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                  <p className="text-2xl font-semibold text-slate-900">{crossRisk.correlationScore}</p>
                  <p className="mt-0.5 text-xs text-slate-500">Compound Score</p>
                </div>
                <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                  <p className="text-2xl font-semibold text-slate-900">{crossRisk.affectedDomains}</p>
                  <p className="mt-0.5 text-xs text-slate-500">Affected Domains</p>
                </div>
                <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                  <p className="text-2xl font-semibold text-slate-900">{crossRisk.topRisks.length}</p>
                  <p className="mt-0.5 text-xs text-slate-500">Active Anomalies</p>
                </div>
              </div>
              {crossRisk.isCompound && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" />
                  Compound risk detected across {crossRisk.affectedDomains} domains simultaneously — stronger signal than any single alert.
                </div>
              )}
              {crossRisk.domains.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {crossRisk.domains.map((d) => (
                    <span key={d.name} className={`rounded-full border px-2.5 py-1 text-xs font-medium ${riskLevelClass(d.maxSeverity)}`}>
                      {d.name} · {d.riskCount} alert{d.riskCount !== 1 ? "s" : ""}
                    </span>
                  ))}
                </div>
              )}
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link to="/dashboard/insights">View full anomaly feed <ArrowRight className="ml-1.5 h-3.5 w-3.5" /></Link>
              </Button>
            </div>
          ) : null}
        </section>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet-600" />
          <h2 className="text-lg font-semibold text-slate-900">AI Insights Preview</h2>
        </div>

        {state.loading ? (
          <div className="flex gap-4 overflow-x-auto pb-2">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="min-w-[280px] flex-1 rounded-lg border border-slate-200 p-4">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="mt-3 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-5/6" />
                <div className="mt-4 flex gap-2">
                  <Skeleton className="h-8 w-24" />
                  <Skeleton className="h-8 w-24" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex gap-4 overflow-x-auto pb-2">
            {state.insights.map((insight) => (
              <article key={insight.id} className="min-w-[300px] flex-1 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <h3 className="text-sm font-semibold text-slate-900">{insight.title}</h3>
                <p className="mt-2 text-sm text-slate-600">{insight.description}</p>
                <div className="mt-4 flex gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link to={insight.viewRoute}>View details</Link>
                  </Button>
                  <Button asChild size="sm" className="bg-violet-600 text-white hover:bg-violet-700">
                    <Link to={insight.actionRoute}>Take action</Link>
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {state.error && (
        <section className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          Could not load full dashboard data: {state.error}
        </section>
      )}
    </div>
  );
}
