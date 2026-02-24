import { useCallback, useEffect, useMemo, useState } from "react";
import { format, subDays } from "date-fns";
import { AlertCircle, Download, ScrollText } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { invokeEdge } from "@/lib/edge-invoke";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

type RiskLevel = "low" | "medium" | "high" | "critical";
type ActionType = "query" | "update" | "delete" | "blocked";
type AuditStatus = "success" | "failed" | "blocked" | "pending_approval";

type AuditUserOption = {
  id: string;
  name: string;
  avatarUrl: string | null;
};

type AuditTrendPoint = {
  date: string;
  total: number;
  blocked: number;
  approved: number;
};

type AuditLogRow = {
  id: string;
  createdAt: string;
  userId: string | null;
  userName: string;
  userAvatar: string | null;
  agent: string;
  action: string;
  actionType: ActionType;
  resource: string;
  riskLevel: RiskLevel;
  status: AuditStatus;
  details: Record<string, unknown>;
};

type AuditLogPayload = {
  rows: AuditLogRow[];
  total: number;
  stats: {
    todayActions: number;
    todayBlocked: number;
    todayApproved: number;
  };
  weekTrend: AuditTrendPoint[];
  filterOptions: {
    users: AuditUserOption[];
    agents: string[];
  };
  page: {
    limit: number;
    offset: number;
  };
  dateRange: {
    from: string | null;
    to: string | null;
  };
};

const DEFAULT_FROM = format(subDays(new Date(), 6), "yyyy-MM-dd");
const DEFAULT_TO = format(new Date(), "yyyy-MM-dd");

const EMPTY_PAYLOAD: AuditLogPayload = {
  rows: [],
  total: 0,
  stats: {
    todayActions: 0,
    todayBlocked: 0,
    todayApproved: 0,
  },
  weekTrend: [],
  filterOptions: {
    users: [],
    agents: [],
  },
  page: {
    limit: 100,
    offset: 0,
  },
  dateRange: {
    from: null,
    to: null,
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizePayload(value: unknown): AuditLogPayload {
  const payload = asRecord(value);
  if (!payload) return EMPTY_PAYLOAD;

  const rows = Array.isArray(payload.rows)
    ? payload.rows
        .map((row) => {
          const item = asRecord(row);
          if (!item) return null;

          const details = asRecord(item.details) ?? {};

          return {
            id: String(item.id ?? ""),
            createdAt: String(item.createdAt ?? ""),
            userId: item.userId ? String(item.userId) : null,
            userName: String(item.userName ?? "System"),
            userAvatar: item.userAvatar ? String(item.userAvatar) : null,
            agent: String(item.agent ?? "Direct"),
            action: String(item.action ?? "Unknown action"),
            actionType: (["query", "update", "delete", "blocked"].includes(String(item.actionType))
              ? String(item.actionType)
              : "query") as ActionType,
            resource: String(item.resource ?? "Unknown"),
            riskLevel: (["low", "medium", "high", "critical"].includes(String(item.riskLevel))
              ? String(item.riskLevel)
              : "low") as RiskLevel,
            status: (["success", "failed", "blocked", "pending_approval"].includes(String(item.status))
              ? String(item.status)
              : "success") as AuditStatus,
            details,
          } satisfies AuditLogRow;
        })
        .filter((row): row is AuditLogRow => Boolean(row) && row.id.length > 0)
    : [];

  const stats = asRecord(payload.stats);
  const filterOptions = asRecord(payload.filterOptions);
  const page = asRecord(payload.page);
  const dateRange = asRecord(payload.dateRange);

  const weekTrend = Array.isArray(payload.weekTrend)
    ? payload.weekTrend
        .map((point) => {
          const item = asRecord(point);
          if (!item) return null;
          return {
            date: String(item.date ?? ""),
            total: Number(item.total ?? 0) || 0,
            blocked: Number(item.blocked ?? 0) || 0,
            approved: Number(item.approved ?? 0) || 0,
          } satisfies AuditTrendPoint;
        })
        .filter((point): point is AuditTrendPoint => Boolean(point) && point.date.length > 0)
    : [];

  const users = Array.isArray(filterOptions?.users)
    ? filterOptions.users
        .map((user) => {
          const item = asRecord(user);
          if (!item) return null;
          const id = String(item.id ?? "").trim();
          if (!id) return null;

          return {
            id,
            name: String(item.name ?? `User ${id.slice(0, 8)}`),
            avatarUrl: item.avatarUrl ? String(item.avatarUrl) : null,
          } satisfies AuditUserOption;
        })
        .filter((user): user is AuditUserOption => Boolean(user))
    : [];

  const agents = Array.isArray(filterOptions?.agents)
    ? filterOptions.agents
        .map((value) => String(value ?? "").trim())
        .filter((value) => value.length > 0)
    : [];

  return {
    rows,
    total: Number(payload.total ?? 0) || 0,
    stats: {
      todayActions: Number(stats?.todayActions ?? 0) || 0,
      todayBlocked: Number(stats?.todayBlocked ?? 0) || 0,
      todayApproved: Number(stats?.todayApproved ?? 0) || 0,
    },
    weekTrend,
    filterOptions: {
      users,
      agents,
    },
    page: {
      limit: Number(page?.limit ?? 100) || 100,
      offset: Number(page?.offset ?? 0) || 0,
    },
    dateRange: {
      from: dateRange?.from ? String(dateRange.from) : null,
      to: dateRange?.to ? String(dateRange.to) : null,
    },
  };
}

function formatRelativeTime(value: string) {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "Unknown";

  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function actionPillClass(actionType: ActionType) {
  if (actionType === "delete") return "border-red-200 bg-red-100 text-red-800";
  if (actionType === "update") return "border-amber-200 bg-amber-100 text-amber-800";
  if (actionType === "blocked") return "border-slate-900 bg-slate-900 text-white";
  return "border-blue-200 bg-blue-100 text-blue-800";
}

function actionLabel(actionType: ActionType) {
  if (actionType === "delete") return "Delete";
  if (actionType === "update") return "Update";
  if (actionType === "blocked") return "Blocked";
  return "Query";
}

function riskBadgeClass(riskLevel: RiskLevel) {
  if (riskLevel === "critical") return "border-slate-900 bg-slate-900 text-white";
  if (riskLevel === "high") return "border-red-200 bg-red-100 text-red-800";
  if (riskLevel === "medium") return "border-amber-200 bg-amber-100 text-amber-800";
  return "border-emerald-200 bg-emerald-100 text-emerald-800";
}

function statusBadgeClass(status: AuditStatus) {
  if (status === "failed") return "border-red-200 bg-red-100 text-red-800";
  if (status === "blocked") return "border-slate-900 bg-slate-900 text-white";
  if (status === "pending_approval") return "border-amber-200 bg-amber-100 text-amber-800";
  return "border-emerald-200 bg-emerald-100 text-emerald-800";
}

function statusLabel(status: AuditStatus) {
  if (status === "pending_approval") return "Pending Approval";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") || "U"
  );
}

function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function csvEscape(value: unknown) {
  const raw = value === null || value === undefined ? "" : String(value);
  return `"${raw.replace(/"/g, '""')}"`;
}

function downloadCsv(rows: AuditLogRow[]) {
  const headers = ["Time", "User", "Agent", "Action", "Action Type", "Resource", "Risk", "Status", "Details"];
  const lines = rows.map((row) =>
    [
      row.createdAt,
      row.userName,
      row.agent,
      row.action,
      row.actionType,
      row.resource,
      row.riskLevel,
      row.status,
      JSON.stringify(row.details ?? {}),
    ]
      .map(csvEscape)
      .join(","),
  );

  const csv = [headers.map(csvEscape).join(","), ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `audit-log-${format(new Date(), "yyyyMMdd-HHmmss")}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function AuditLogs() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [tenantId, setTenantId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<AuditLogPayload>(EMPTY_PAYLOAD);

  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState<"all" | RiskLevel>("all");
  const [actionTypeFilter, setActionTypeFilter] = useState<"all" | ActionType>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | AuditStatus>("all");
  const [userFilter, setUserFilter] = useState<string>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState(DEFAULT_FROM);
  const [dateTo, setDateTo] = useState(DEFAULT_TO);

  const [selectedLog, setSelectedLog] = useState<AuditLogRow | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearchQuery(searchInput.trim());
    }, 260);

    return () => window.clearTimeout(timer);
  }, [searchInput]);

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
        const { data, error } = await invokeEdge("audit-log", {
          body: {
            operation: "get_payload",
            search: searchQuery || null,
            riskFilter,
            actionTypeFilter,
            statusFilter,
            userFilter: userFilter === "all" ? null : userFilter,
            agentFilter,
            dateFrom,
            dateTo,
            limit: 200,
            offset: 0,
          },
        });

        if (error) throw error;

        setPayload(normalizePayload((data as { payload?: unknown } | null)?.payload ?? null));
      } catch (error) {
        toast({
          title: "Could not load audit logs",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        });
      } finally {
        if (withLoading) setLoading(false);
      }
    },
    [tenantId, searchQuery, riskFilter, actionTypeFilter, statusFilter, userFilter, agentFilter, dateFrom, dateTo, toast],
  );

  useEffect(() => {
    if (!tenantId) return;
    void loadPayload(true);
  }, [tenantId, loadPayload]);

  useEffect(() => {
    if (!tenantId) return;

    const channel = supabase
      .channel(`audit-log-${tenantId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "audit_logs",
          filter: `tenant_id=eq.${tenantId}`,
        },
        () => {
          void loadPayload(false);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [tenantId, loadPayload]);

  const clearFilters = () => {
    setSearchInput("");
    setSearchQuery("");
    setRiskFilter("all");
    setActionTypeFilter("all");
    setStatusFilter("all");
    setUserFilter("all");
    setAgentFilter("all");
    setDateFrom(DEFAULT_FROM);
    setDateTo(DEFAULT_TO);
  };

  const trendMax = useMemo(() => {
    const values = payload.weekTrend.map((point) => point.total);
    const max = Math.max(...values, 1);
    return max;
  }, [payload.weekTrend]);

  const detailInput = asRecord(selectedLog?.details?.inputParams)
    ?? asRecord(selectedLog?.details?.params)
    ?? asRecord(selectedLog?.details?.input)
    ?? null;
  const detailOutput = selectedLog?.details?.output ?? selectedLog?.details?.result ?? selectedLog?.details?.response ?? null;
  const detailError = selectedLog?.details?.error ?? selectedLog?.details?.errorMessage ?? selectedLog?.details?.message ?? null;
  const detailExecutionMs = selectedLog?.details?.executionMs
    ?? selectedLog?.details?.latencyMs
    ?? selectedLog?.details?.durationMs
    ?? selectedLog?.details?.elapsedMs
    ?? null;
  const detailApprovalRef = selectedLog?.details?.approvalRef
    ?? selectedLog?.details?.approval_request_id
    ?? selectedLog?.details?.approvalId
    ?? selectedLog?.details?.requestId
    ?? null;
  const detailCallPreview = selectedLog?.details?.sql
    ?? selectedLog?.details?.query
    ?? selectedLog?.details?.apiCall
    ?? selectedLog?.details?.endpoint
    ?? null;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
          <p className="mt-1 text-sm text-muted-foreground">Immutable execution history across users, agents, and governed actions.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className="w-[160px]" />
          <Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className="w-[160px]" />
          <Button type="button" variant="outline" onClick={() => downloadCsv(payload.rows)}>
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </div>

      <section className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr_2fr]">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Today actions</p>
          <p className="mt-2 text-2xl font-bold text-slate-900">{payload.stats.todayActions}</p>
        </div>
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-red-700">Blocked</p>
          <p className="mt-2 text-2xl font-bold text-red-800">{payload.stats.todayBlocked}</p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Approved</p>
          <p className="mt-2 text-2xl font-bold text-emerald-800">{payload.stats.todayApproved}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">This week trend</p>
          <div className="mt-2 flex h-14 items-end gap-1">
            {payload.weekTrend.length === 0 ? (
              <span className="text-xs text-slate-500">No trend data yet.</span>
            ) : (
              payload.weekTrend.map((point) => {
                const heightPct = Math.max(12, Math.round((point.total / trendMax) * 100));
                return (
                  <div
                    key={point.date}
                    title={`${point.date}: ${point.total} actions`}
                    className="w-full rounded-sm bg-violet-500/80"
                    style={{ height: `${heightPct}%` }}
                  />
                );
              })
            )}
          </div>
        </div>
      </section>

      <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        Audit logs are immutable and cannot be edited or deleted.
      </div>

      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-[1.4fr_1fr_1fr_1fr_1fr_1fr]">
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search by user, action, or resource"
          />

          <Select value={riskFilter} onValueChange={(value) => setRiskFilter(value as "all" | RiskLevel)}>
            <SelectTrigger>
              <SelectValue placeholder="Risk" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All risk levels</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>

          <Select value={actionTypeFilter} onValueChange={(value) => setActionTypeFilter(value as "all" | ActionType)}>
            <SelectTrigger>
              <SelectValue placeholder="Action Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All action types</SelectItem>
              <SelectItem value="query">Query</SelectItem>
              <SelectItem value="update">Update</SelectItem>
              <SelectItem value="delete">Delete</SelectItem>
              <SelectItem value="blocked">Blocked</SelectItem>
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as "all" | AuditStatus)}>
            <SelectTrigger>
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="blocked">Blocked</SelectItem>
              <SelectItem value="pending_approval">Pending Approval</SelectItem>
            </SelectContent>
          </Select>

          <Select value={userFilter} onValueChange={setUserFilter}>
            <SelectTrigger>
              <SelectValue placeholder="User" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All users</SelectItem>
              {payload.filterOptions.users.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger>
              <SelectValue placeholder="Agent" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All agents</SelectItem>
              {payload.filterOptions.agents.map((agent) => (
                <SelectItem key={agent} value={agent}>
                  {agent}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={clearFilters}
            className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
          >
            Clear filters
          </button>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[140px]">Time</TableHead>
              <TableHead>User</TableHead>
              <TableHead className="hidden md:table-cell">Agent</TableHead>
              <TableHead>Action</TableHead>
              <TableHead className="hidden md:table-cell">Resource</TableHead>
              <TableHead className="hidden md:table-cell">Risk</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 10 }).map((_, index) => (
                <TableRow key={`audit-skeleton-${index}`}>
                  <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-36" /></TableCell>
                  <TableCell className="hidden md:table-cell"><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-24" /></TableCell>
                  <TableCell className="hidden md:table-cell"><Skeleton className="h-4 w-28" /></TableCell>
                  <TableCell className="hidden md:table-cell"><Skeleton className="h-6 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-24" /></TableCell>
                  <TableCell><div className="ml-auto w-fit"><Skeleton className="h-8 w-14" /></div></TableCell>
                </TableRow>
              ))
            ) : payload.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="px-4 py-14 text-center">
                  <div className="mx-auto flex max-w-md flex-col items-center gap-2 text-slate-500">
                    <ScrollText className="h-8 w-8" />
                    <p className="text-sm font-medium text-slate-700">No audit logs found</p>
                    <p className="text-xs">Try adjusting filters or date range.</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              payload.rows.map((row) => (
                <TableRow key={row.id} className="hover:bg-slate-50">
                  <TableCell className="text-xs text-slate-600">
                    <span title={new Date(row.createdAt).toLocaleString()}>{formatRelativeTime(row.createdAt)}</span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Avatar className="h-7 w-7">
                        <AvatarImage src={row.userAvatar ?? undefined} alt={row.userName} />
                        <AvatarFallback className="text-[10px]">{initials(row.userName)}</AvatarFallback>
                      </Avatar>
                      <span className="text-sm text-slate-800">{row.userName}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-slate-700">{row.agent || "Direct"}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("border px-2 py-0.5 text-xs", actionPillClass(row.actionType))}>
                      {actionLabel(row.actionType)}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden max-w-[280px] truncate text-sm text-slate-700 md:table-cell" title={row.resource}>{row.resource}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Badge variant="outline" className={cn("border px-2 py-0.5 text-xs uppercase", riskBadgeClass(row.riskLevel))}>
                      {row.riskLevel}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("border px-2 py-0.5 text-xs", statusBadgeClass(row.status))}>
                      {statusLabel(row.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => setSelectedLog(row)}>
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>

      <Sheet open={Boolean(selectedLog)} onOpenChange={(open) => (!open ? setSelectedLog(null) : undefined)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
          {selectedLog ? (
            <div className="space-y-4 pr-2">
              <SheetHeader>
                <SheetTitle>Audit Entry Details</SheetTitle>
                <SheetDescription>
                  {selectedLog.action} · {new Date(selectedLog.createdAt).toLocaleString()}
                </SheetDescription>
              </SheetHeader>

              <section className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                <p><span className="font-semibold">User:</span> {selectedLog.userName}</p>
                <p><span className="font-semibold">Agent:</span> {selectedLog.agent || "Direct"}</p>
                <p><span className="font-semibold">Resource:</span> {selectedLog.resource}</p>
                <p><span className="font-semibold">Risk:</span> {selectedLog.riskLevel}</p>
                <p><span className="font-semibold">Status:</span> {statusLabel(selectedLog.status)}</p>
                <p><span className="font-semibold">Approval reference:</span> {detailApprovalRef ? String(detailApprovalRef) : "N/A"}</p>
                <p><span className="font-semibold">Execution time:</span> {detailExecutionMs ? `${String(detailExecutionMs)} ms` : "N/A"}</p>
              </section>

              <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Input parameters</h3>
                <pre className="max-h-48 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-700">
                  {prettyJson(detailInput ?? {})}
                </pre>
              </section>

              <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Output / error</h3>
                <pre className="max-h-48 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-700">
                  {prettyJson(detailError ?? detailOutput ?? "No output provided")}
                </pre>
              </section>

              <details className="rounded-lg border border-slate-200 bg-white p-3">
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-600">
                  SQL / API call preview
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-700">
                  {prettyJson(detailCallPreview ?? "No SQL/API preview provided")}
                </pre>
              </details>

              <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Raw details JSON</h3>
                <pre className="max-h-64 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-700">
                  {prettyJson(selectedLog.details ?? {})}
                </pre>
              </section>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
