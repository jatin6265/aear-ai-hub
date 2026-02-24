import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowUpRight, Ban, Building2, Loader2, Search, ShieldAlert, UserCheck } from "lucide-react";
import { Link, NavLink } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdge } from "@/lib/edge-invoke";

type PlanFilter = "all" | "starter" | "pro" | "business" | "enterprise";
type StatusFilter = "all" | "active" | "trial" | "suspended" | "cancelled";
type SortBy = "mrr" | "created" | "last_active" | "health_score";
type SortDir = "asc" | "desc";

type TenantRow = {
  id: string;
  company: string;
  slug: string;
  ownerEmail: string;
  ownerName: string;
  plan: PlanFilter;
  status: Exclude<StatusFilter, "all">;
  users: number;
  connections: number;
  mrr: number;
  tokensUsed: number;
  createdAt: string;
  lastActiveAt: string;
  healthScore: number;
  health: "green" | "amber" | "red";
};

type TenantListPayload = {
  stats: {
    totalTenants: number;
    active: number;
    trial: number;
    churnedLast30d: number;
    mrr: number;
    arr: number;
  };
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
  tenants: TenantRow[];
};

type QuickViewPayload = {
  tenant: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    status: string;
    billingCycle: string;
    mrr: number;
    createdAt: string;
    updatedAt: string;
    lastActiveAt: string;
    currentPeriodEnd: string;
  };
  stats: {
    users: { active: number; suspended: number; total: number };
    connections: { total: number; active: number; syncing: number; error: number };
    usage: { tokensThisMonth: number; apiCallsThisMonth: number; actionsThisMonth: number };
  };
  billingStatus: {
    plan: string;
    status: string;
    mrr: number;
    latestInvoice: {
      id: string;
      status: string;
      totalCents: number;
      amountDueCents: number;
      dueAt: string | null;
      paidAt: string | null;
      hostedInvoiceUrl: string | null;
    } | null;
  };
  connections: Array<{
    id: string;
    name: string;
    type: string;
    status: string;
    schemaDetected: boolean;
    lastSyncedAt: string | null;
    updatedAt: string;
  }>;
  recentAuditEvents: Array<{
    id: string;
    action: string;
    resource: string;
    status: string;
    riskLevel: string;
    createdAt: string;
    actorName: string;
  }>;
  links: {
    fullTenantDashboard: string;
  };
};

type FilterState = {
  search: string;
  plan: PlanFilter;
  status: StatusFilter;
  createdFrom: string;
  createdTo: string;
  sortBy: SortBy;
  sortDir: SortDir;
};

const EMPTY_LIST_PAYLOAD: TenantListPayload = {
  stats: {
    totalTenants: 0,
    active: 0,
    trial: 0,
    churnedLast30d: 0,
    mrr: 0,
    arr: 0,
  },
  pagination: {
    total: 0,
    limit: 100,
    offset: 0,
  },
  tenants: [],
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

function normalizeListPayload(value: unknown): TenantListPayload {
  const raw = asRecord(value);
  if (!raw) return EMPTY_LIST_PAYLOAD;

  const stats = asRecord(raw.stats);
  const pagination = asRecord(raw.pagination);

  const tenants = Array.isArray(raw.tenants)
    ? raw.tenants
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;

          const id = String(row.id ?? "").trim();
          const company = String(row.company ?? "").trim();
          if (!id || !company) return null;

          const plan = String(row.plan ?? "starter").toLowerCase();
          const status = String(row.status ?? "trial").toLowerCase();
          const health = String(row.health ?? "amber").toLowerCase();

          return {
            id,
            company,
            slug: String(row.slug ?? ""),
            ownerEmail: String(row.ownerEmail ?? ""),
            ownerName: String(row.ownerName ?? "Owner"),
            plan: (["starter", "pro", "business", "enterprise"].includes(plan) ? plan : "starter") as PlanFilter,
            status: (["active", "trial", "suspended", "cancelled"].includes(status)
              ? status
              : "trial") as Exclude<StatusFilter, "all">,
            users: Number(row.users ?? 0) || 0,
            connections: Number(row.connections ?? 0) || 0,
            mrr: Number(row.mrr ?? 0) || 0,
            tokensUsed: Number(row.tokensUsed ?? 0) || 0,
            createdAt: String(row.createdAt ?? ""),
            lastActiveAt: String(row.lastActiveAt ?? ""),
            healthScore: Number(row.healthScore ?? 0) || 0,
            health: (["green", "amber", "red"].includes(health) ? health : "amber") as "green" | "amber" | "red",
          } satisfies TenantRow;
        })
        .filter((row): row is TenantRow => Boolean(row))
    : [];

  return {
    stats: {
      totalTenants: Number(stats?.totalTenants ?? 0) || 0,
      active: Number(stats?.active ?? 0) || 0,
      trial: Number(stats?.trial ?? 0) || 0,
      churnedLast30d: Number(stats?.churnedLast30d ?? 0) || 0,
      mrr: Number(stats?.mrr ?? 0) || 0,
      arr: Number(stats?.arr ?? 0) || 0,
    },
    pagination: {
      total: Number(pagination?.total ?? 0) || 0,
      limit: Number(pagination?.limit ?? 100) || 100,
      offset: Number(pagination?.offset ?? 0) || 0,
    },
    tenants,
  };
}

function normalizeQuickView(value: unknown): QuickViewPayload | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const tenant = asRecord(raw.tenant);
  const stats = asRecord(raw.stats);
  const users = asRecord(stats?.users);
  const connections = asRecord(stats?.connections);
  const usage = asRecord(stats?.usage);
  const billingStatus = asRecord(raw.billingStatus);
  const latestInvoice = asRecord(billingStatus?.latestInvoice);
  const links = asRecord(raw.links);

  if (!tenant?.id || !tenant?.name) return null;

  return {
    tenant: {
      id: String(tenant.id),
      name: String(tenant.name),
      slug: String(tenant.slug ?? ""),
      plan: String(tenant.plan ?? "starter"),
      status: String(tenant.status ?? "trial"),
      billingCycle: String(tenant.billingCycle ?? "monthly"),
      mrr: Number(tenant.mrr ?? 0) || 0,
      createdAt: String(tenant.createdAt ?? ""),
      updatedAt: String(tenant.updatedAt ?? ""),
      lastActiveAt: String(tenant.lastActiveAt ?? ""),
      currentPeriodEnd: String(tenant.currentPeriodEnd ?? ""),
    },
    stats: {
      users: {
        active: Number(users?.active ?? 0) || 0,
        suspended: Number(users?.suspended ?? 0) || 0,
        total: Number(users?.total ?? 0) || 0,
      },
      connections: {
        total: Number(connections?.total ?? 0) || 0,
        active: Number(connections?.active ?? 0) || 0,
        syncing: Number(connections?.syncing ?? 0) || 0,
        error: Number(connections?.error ?? 0) || 0,
      },
      usage: {
        tokensThisMonth: Number(usage?.tokensThisMonth ?? 0) || 0,
        apiCallsThisMonth: Number(usage?.apiCallsThisMonth ?? 0) || 0,
        actionsThisMonth: Number(usage?.actionsThisMonth ?? 0) || 0,
      },
    },
    billingStatus: {
      plan: String(billingStatus?.plan ?? "starter"),
      status: String(billingStatus?.status ?? "trial"),
      mrr: Number(billingStatus?.mrr ?? 0) || 0,
      latestInvoice: latestInvoice
        ? {
            id: String(latestInvoice.id ?? ""),
            status: String(latestInvoice.status ?? "unknown"),
            totalCents: Number(latestInvoice.totalCents ?? 0) || 0,
            amountDueCents: Number(latestInvoice.amountDueCents ?? 0) || 0,
            dueAt: latestInvoice.dueAt ? String(latestInvoice.dueAt) : null,
            paidAt: latestInvoice.paidAt ? String(latestInvoice.paidAt) : null,
            hostedInvoiceUrl: latestInvoice.hostedInvoiceUrl ? String(latestInvoice.hostedInvoiceUrl) : null,
          }
        : null,
    },
    connections: Array.isArray(raw.connections)
      ? raw.connections
          .map((item) => {
            const row = asRecord(item);
            if (!row?.id || !row?.name) return null;
            return {
              id: String(row.id),
              name: String(row.name),
              type: String(row.type ?? "unknown"),
              status: String(row.status ?? "pending"),
              schemaDetected: row.schemaDetected === true,
              lastSyncedAt: row.lastSyncedAt ? String(row.lastSyncedAt) : null,
              updatedAt: String(row.updatedAt ?? ""),
            };
          })
          .filter((item): item is QuickViewPayload["connections"][number] => Boolean(item))
      : [],
    recentAuditEvents: Array.isArray(raw.recentAuditEvents)
      ? raw.recentAuditEvents
          .map((item) => {
            const row = asRecord(item);
            if (!row?.id || !row?.action) return null;
            return {
              id: String(row.id),
              action: String(row.action),
              resource: String(row.resource ?? "resource"),
              status: String(row.status ?? "success"),
              riskLevel: String(row.riskLevel ?? "low"),
              createdAt: String(row.createdAt ?? ""),
              actorName: String(row.actorName ?? "System"),
            };
          })
          .filter((item): item is QuickViewPayload["recentAuditEvents"][number] => Boolean(item))
      : [],
    links: {
      fullTenantDashboard: String(links?.fullTenantDashboard ?? "/dashboard/admin"),
    },
  };
}

function currency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function number(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function relativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "Unknown";
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function planBadgeClass(plan: string) {
  if (plan === "enterprise") return "bg-amber-100 text-amber-800";
  if (plan === "business") return "bg-blue-100 text-blue-800";
  if (plan === "pro") return "bg-violet-100 text-violet-800";
  return "bg-slate-200 text-slate-700";
}

function statusBadgeClass(status: string) {
  if (status === "active") return "bg-emerald-100 text-emerald-700";
  if (status === "trial") return "bg-sky-100 text-sky-700";
  if (status === "suspended") return "bg-rose-100 text-rose-700";
  return "bg-slate-200 text-slate-700";
}

function healthDotClass(health: string) {
  if (health === "green") return "bg-emerald-500";
  if (health === "red") return "bg-rose-500";
  return "bg-amber-500";
}

export default function PlatformAdminTenants() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<TenantListPayload>(EMPTY_LIST_PAYLOAD);
  const [filters, setFilters] = useState<FilterState>({
    search: "",
    plan: "all",
    status: "all",
    createdFrom: "",
    createdTo: "",
    sortBy: "mrr",
    sortDir: "desc",
  });

  const [selectedTenant, setSelectedTenant] = useState<TenantRow | null>(null);
  const [quickView, setQuickView] = useState<QuickViewPayload | null>(null);
  const [quickLoading, setQuickLoading] = useState(false);
  const [rowActionTenantId, setRowActionTenantId] = useState<string | null>(null);

  const loadPayload = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await invokeEdge("platform-admin-tenants", {
        body: {
          operation: "get_payload",
          filters: {
            search: filters.search,
            plan: filters.plan,
            status: filters.status,
            createdFrom: filters.createdFrom || null,
            createdTo: filters.createdTo || null,
            sortBy: filters.sortBy,
            sortDir: filters.sortDir,
            limit: 100,
            offset: 0,
          },
        },
      });

      if (error) throw error;
      const response = asRecord(data);
      setPayload(normalizeListPayload(response?.payload));
    } catch (error) {
      toast({
        title: "Could not load platform tenants",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [filters.createdFrom, filters.createdTo, filters.plan, filters.search, filters.sortBy, filters.sortDir, filters.status, toast]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPayload();
    }, 250);

    return () => window.clearTimeout(timer);
  }, [loadPayload]);

  const openTenantQuickView = useCallback(
    async (tenant: TenantRow) => {
      setSelectedTenant(tenant);
      setQuickLoading(true);
      try {
        const { data, error } = await invokeEdge("platform-admin-tenants", {
          body: {
            operation: "get_tenant_quick_view",
            tenantId: tenant.id,
          },
        });
        if (error) throw error;

        const response = asRecord(data);
        setQuickView(normalizeQuickView(response?.payload));
      } catch (error) {
        toast({
          title: "Could not load tenant quick view",
          description: normalizeError(error),
          variant: "destructive",
        });
      } finally {
        setQuickLoading(false);
      }
    },
    [toast],
  );

  const runRowAction = useCallback(
    async (tenant: TenantRow, operation: "suspend_tenant" | "change_plan" | "impersonate_tenant", plan?: string) => {
      setRowActionTenantId(tenant.id);
      try {
        const { data, error } = await invokeEdge("platform-admin-tenants", {
          body: {
            operation,
            tenantId: tenant.id,
            plan,
          },
        });

        if (error) throw error;

        if (operation === "impersonate_tenant") {
          const result = asRecord(asRecord(data)?.result);
          toast({
            title: `Impersonation prepared for ${tenant.company}`,
            description: String(result?.warning ?? "Use server-side token exchange before granting access."),
          });
        } else {
          toast({ title: "Tenant updated successfully" });
          await loadPayload();
          if (selectedTenant?.id === tenant.id) {
            await openTenantQuickView(tenant);
          }
        }
      } catch (error) {
        toast({
          title: "Action failed",
          description: normalizeError(error),
          variant: "destructive",
        });
      } finally {
        setRowActionTenantId(null);
      }
    },
    [loadPayload, openTenantQuickView, selectedTenant?.id, toast],
  );

  const summaryCards = useMemo(
    () => [
      { label: "Total Tenants", value: number(payload.stats.totalTenants), icon: Building2 },
      { label: "Active", value: number(payload.stats.active), icon: UserCheck },
      { label: "Trial", value: number(payload.stats.trial), icon: ShieldAlert },
      { label: "Churned (30d)", value: number(payload.stats.churnedLast30d), icon: Ban },
      { label: "MRR", value: currency(payload.stats.mrr), icon: ArrowUpRight },
      { label: "ARR", value: currency(payload.stats.arr), icon: AlertTriangle },
    ],
    [payload.stats.active, payload.stats.arr, payload.stats.churnedLast30d, payload.stats.mrr, payload.stats.totalTenants, payload.stats.trial],
  );

  return (
    <div className="space-y-6 animate-fade-in">
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-600">Platform Super Admin</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Tenant List</h1>
        <p className="text-sm text-muted-foreground">Global tenant operations across all customer workspaces.</p>
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

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {summaryCards.map((card) => (
          <div key={card.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{card.label}</span>
              <card.icon className="h-4 w-4 text-slate-400" />
            </div>
            <p className="text-2xl font-bold text-slate-900">{card.value}</p>
          </div>
        ))}
      </section>

      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-6">
          <div className="relative lg:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={filters.search}
              onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
              placeholder="Search company or email"
              className="pl-9"
            />
          </div>

          <Select value={filters.plan} onValueChange={(value) => setFilters((current) => ({ ...current, plan: value as PlanFilter }))}>
            <SelectTrigger>
              <SelectValue placeholder="Plan" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All plans</SelectItem>
              <SelectItem value="starter">Starter</SelectItem>
              <SelectItem value="pro">Pro</SelectItem>
              <SelectItem value="business">Business</SelectItem>
              <SelectItem value="enterprise">Enterprise</SelectItem>
            </SelectContent>
          </Select>

          <Select value={filters.status} onValueChange={(value) => setFilters((current) => ({ ...current, status: value as StatusFilter }))}>
            <SelectTrigger>
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="trial">Trial</SelectItem>
              <SelectItem value="suspended">Suspended</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>

          <Input
            type="date"
            value={filters.createdFrom}
            onChange={(event) => setFilters((current) => ({ ...current, createdFrom: event.target.value }))}
            aria-label="Created from"
          />

          <Input
            type="date"
            value={filters.createdTo}
            onChange={(event) => setFilters((current) => ({ ...current, createdTo: event.target.value }))}
            aria-label="Created to"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select value={filters.sortBy} onValueChange={(value) => setFilters((current) => ({ ...current, sortBy: value as SortBy }))}>
            <SelectTrigger>
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mrr">Sort by MRR</SelectItem>
              <SelectItem value="created">Sort by Created</SelectItem>
              <SelectItem value="last_active">Sort by Last Active</SelectItem>
              <SelectItem value="health_score">Sort by Health Score</SelectItem>
            </SelectContent>
          </Select>

          <Select value={filters.sortDir} onValueChange={(value) => setFilters((current) => ({ ...current, sortDir: value as SortDir }))}>
            <SelectTrigger>
              <SelectValue placeholder="Direction" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="desc">Descending</SelectItem>
              <SelectItem value="asc">Ascending</SelectItem>
            </SelectContent>
          </Select>

          <div className="sm:col-span-2 flex items-center justify-end text-xs text-slate-500">
            Showing {number(payload.tenants.length)} of {number(payload.pagination.total)} tenants
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Company</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Users</TableHead>
              <TableHead className="text-right">Connections</TableHead>
              <TableHead className="text-right">MRR</TableHead>
              <TableHead className="text-right">Tokens Used</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Health</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 8 }).map((_, idx) => (
                <TableRow key={`tenant-loading-${idx}`}>
                  <TableCell><Skeleton className="h-4 w-44" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-20" /></TableCell>
                  <TableCell><Skeleton className="ml-auto h-4 w-10" /></TableCell>
                  <TableCell><Skeleton className="ml-auto h-4 w-10" /></TableCell>
                  <TableCell><Skeleton className="ml-auto h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="ml-auto h-4 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="ml-auto h-8 w-44" /></TableCell>
                </TableRow>
              ))
            ) : payload.tenants.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="py-12 text-center text-sm text-slate-500">
                  No tenants match the current filters.
                </TableCell>
              </TableRow>
            ) : (
              payload.tenants.map((tenant) => {
                const rowBusy = rowActionTenantId === tenant.id;
                return (
                  <TableRow key={tenant.id} className="hover:bg-slate-50">
                    <TableCell>
                      <div>
                        <p className="font-medium text-slate-900">{tenant.company}</p>
                        <p className="text-xs text-slate-500">{tenant.ownerEmail || tenant.slug}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge className={cn("capitalize", planBadgeClass(tenant.plan))}>{tenant.plan}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={cn("capitalize", statusBadgeClass(tenant.status))}>{tenant.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">{number(tenant.users)}</TableCell>
                    <TableCell className="text-right">{number(tenant.connections)}</TableCell>
                    <TableCell className="text-right font-medium">{currency(tenant.mrr)}</TableCell>
                    <TableCell className="text-right">{number(tenant.tokensUsed)}</TableCell>
                    <TableCell>
                      <span title={new Date(tenant.createdAt).toLocaleString()}>{relativeTime(tenant.createdAt)}</span>
                    </TableCell>
                    <TableCell>
                      <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-2 py-1 text-xs text-slate-700">
                        <span className={cn("h-2.5 w-2.5 rounded-full", healthDotClass(tenant.health))} />
                        {tenant.healthScore}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button variant="outline" size="sm" onClick={() => void openTenantQuickView(tenant)} disabled={rowBusy}>
                          View
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void runRowAction(tenant, "impersonate_tenant")}
                          disabled={rowBusy}
                        >
                          {rowBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                          Impersonate
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-rose-700"
                          onClick={() => void runRowAction(tenant, "suspend_tenant")}
                          disabled={rowBusy || tenant.status === "suspended"}
                        >
                          Suspend
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const nextPlan = window.prompt(
                              `Change plan for ${tenant.company} to starter, pro, business, or enterprise`,
                              tenant.plan,
                            );
                            if (!nextPlan) return;
                            void runRowAction(tenant, "change_plan", nextPlan.toLowerCase());
                          }}
                          disabled={rowBusy}
                        >
                          Change Plan
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </section>

      <Sheet
        open={Boolean(selectedTenant)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedTenant(null);
            setQuickView(null);
          }
        }}
      >
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
          <div className="space-y-4 pr-2">
            <SheetHeader>
              <SheetTitle>{selectedTenant?.company ?? "Tenant"}</SheetTitle>
              <SheetDescription>Tenant Quick View</SheetDescription>
            </SheetHeader>

            {quickLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-32 w-full" />
                <Skeleton className="h-40 w-full" />
              </div>
            ) : quickView ? (
              <>
                <section className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                  <p><span className="font-semibold">Plan:</span> {quickView.tenant.plan}</p>
                  <p><span className="font-semibold">Status:</span> {quickView.tenant.status}</p>
                  <p><span className="font-semibold">MRR:</span> {currency(quickView.tenant.mrr)}</p>
                  <p><span className="font-semibold">Created:</span> {new Date(quickView.tenant.createdAt).toLocaleString()}</p>
                  <p><span className="font-semibold">Last Active:</span> {relativeTime(quickView.tenant.lastActiveAt)}</p>
                </section>

                <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Users</p>
                    <p className="mt-1 text-lg font-semibold text-slate-900">{number(quickView.stats.users.total)}</p>
                    <p className="text-xs text-slate-600">{quickView.stats.users.active} active · {quickView.stats.users.suspended} suspended</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Connections</p>
                    <p className="mt-1 text-lg font-semibold text-slate-900">{number(quickView.stats.connections.total)}</p>
                    <p className="text-xs text-slate-600">{quickView.stats.connections.active} active · {quickView.stats.connections.error} error</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Tokens This Month</p>
                    <p className="mt-1 text-lg font-semibold text-slate-900">{number(quickView.stats.usage.tokensThisMonth)}</p>
                    <p className="text-xs text-slate-600">API calls: {number(quickView.stats.usage.apiCallsThisMonth)}</p>
                  </div>
                </section>

                <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Connection List</h3>
                  {quickView.connections.length === 0 ? (
                    <p className="text-xs text-slate-500">No connections found.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {quickView.connections.map((connection) => (
                        <div key={connection.id} className="flex items-center justify-between rounded border border-slate-200 px-2 py-1.5 text-xs">
                          <div>
                            <p className="font-medium text-slate-800">{connection.name}</p>
                            <p className="text-slate-500">{connection.type}</p>
                          </div>
                          <Badge className={cn("capitalize", statusBadgeClass(connection.status))}>{connection.status}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Billing Status</h3>
                  <p className="text-sm text-slate-700">Plan: {quickView.billingStatus.plan} · {quickView.billingStatus.status}</p>
                  {quickView.billingStatus.latestInvoice ? (
                    <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
                      <p>Invoice: {quickView.billingStatus.latestInvoice.status}</p>
                      <p>Total: {currency((quickView.billingStatus.latestInvoice.totalCents || 0) / 100)}</p>
                      <p>Due: {quickView.billingStatus.latestInvoice.dueAt ? new Date(quickView.billingStatus.latestInvoice.dueAt).toLocaleString() : "N/A"}</p>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500">No invoices available.</p>
                  )}
                </section>

                <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Recent Audit Events</h3>
                  {quickView.recentAuditEvents.length === 0 ? (
                    <p className="text-xs text-slate-500">No recent events.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {quickView.recentAuditEvents.map((event) => (
                        <div key={event.id} className="rounded border border-slate-200 px-2 py-1.5 text-xs">
                          <p className="font-medium text-slate-800">{event.action}</p>
                          <p className="text-slate-500">
                            {event.actorName} · {event.resource} · {relativeTime(event.createdAt)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <div className="pt-2">
                  <Button asChild variant="outline" className="w-full">
                    <Link to={quickView.links.fullTenantDashboard}>
                      Go to full tenant dashboard
                      <ArrowUpRight className="h-4 w-4" />
                    </Link>
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-slate-500">No tenant data loaded.</p>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
