import { type ComponentType, useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bell,
  Brain,
  CheckCircle2,
  CircleDot,
  Cpu,
  CreditCard,
  Loader2,
  RefreshCw,
  Scale,
  Search,
  Server,
  Shield,
  XCircle,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
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

type ServiceStatus = "healthy" | "degraded" | "down";

type InfraService = {
  key: string;
  name: string;
  status: ServiceStatus;
  uptimePct: number;
  latency: {
    p50: number;
    p95: number;
    p99: number;
  };
  errorRatePct: number;
};

type LatencyTrendPoint = {
  bucket: string;
  label: string;
  p50: number;
  p95: number;
  p99: number;
};

type ErrorRatePoint = {
  bucket: string;
  label: string;
  apiGateway: number;
  intentParser: number;
  ragService: number;
  embeddingWorker: number;
  governanceEngine: number;
  executionSandbox: number;
  syncEngine: number;
  billingService: number;
  notificationService: number;
};

type QueueHealthRow = {
  queueName: string;
  depth: number;
  consumerLagSec: number;
  status: ServiceStatus;
};

type IncidentRow = {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  durationMinutes: number | null;
  affectedServices: string[];
  resolution: string | null;
  status: "active" | "investigating" | "resolved";
  startedAt: string;
  resolvedAt: string | null;
};

type ServiceCostRow = {
  serviceKey: string;
  serviceName: string;
  costUsd: number;
};

type ProviderCostRow = {
  provider: string;
  costUsd: number;
};

type InfraPayload = {
  generatedAt: string;
  windowHours: number;
  systemStatus: {
    status: "healthy" | "degraded";
    label: string;
    lastCheckedSecondsAgo: number;
    autoRefreshSeconds: number;
  };
  services: InfraService[];
  latencyTrends: LatencyTrendPoint[];
  errorRateByService: ErrorRatePoint[];
  queueHealth: QueueHealthRow[];
  recentIncidents: IncidentRow[];
  costAnalytics: {
    costByService: ServiceCostRow[];
    avgCostPerTenantUsd: number;
    llmSpendByProvider: ProviderCostRow[];
  };
};

const EMPTY_PAYLOAD: InfraPayload = {
  generatedAt: new Date().toISOString(),
  windowHours: 24,
  systemStatus: {
    status: "healthy",
    label: "All Systems Operational",
    lastCheckedSecondsAgo: 30,
    autoRefreshSeconds: 30,
  },
  services: [],
  latencyTrends: [],
  errorRateByService: [],
  queueHealth: [],
  recentIncidents: [],
  costAnalytics: {
    costByService: [],
    avgCostPerTenantUsd: 0,
    llmSpendByProvider: [],
  },
};

const SUB_NAV = [
  { label: "Tenants", to: "/platform-admin/tenants" },
  { label: "Revenue", to: "/platform-admin/revenue" },
  { label: "Infrastructure", to: "/platform-admin/infrastructure" },
] as const;

const ERROR_KEYS: Array<{ key: keyof ErrorRatePoint; label: string; color: string }> = [
  { key: "apiGateway", label: "API Gateway", color: "#4f46e5" },
  { key: "intentParser", label: "Intent Parser", color: "#7c3aed" },
  { key: "ragService", label: "RAG Service", color: "#0891b2" },
  { key: "embeddingWorker", label: "Embedding Worker", color: "#0284c7" },
  { key: "governanceEngine", label: "Governance Engine", color: "#16a34a" },
  { key: "executionSandbox", label: "Execution Sandbox", color: "#ea580c" },
  { key: "syncEngine", label: "Sync Engine", color: "#2563eb" },
  { key: "billingService", label: "Billing Service", color: "#ca8a04" },
  { key: "notificationService", label: "Notification Service", color: "#db2777" },
];

const SERVICE_ICON_MAP: Record<string, ComponentType<{ className?: string }>> = {
  api_gateway: Server,
  intent_parser: Brain,
  rag_service: Search,
  embedding_worker: Cpu,
  governance_engine: Scale,
  execution_sandbox: Shield,
  sync_engine: RefreshCw,
  billing_service: CreditCard,
  notification_service: Bell,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray<T>(value: unknown) {
  return Array.isArray(value) ? (value as T[]) : [];
}

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Please try again.";
}

function normalizePayload(value: unknown): InfraPayload {
  const raw = asRecord(value);
  if (!raw) return EMPTY_PAYLOAD;

  const systemStatus = asRecord(raw.systemStatus);
  const costAnalytics = asRecord(raw.costAnalytics);

  const services = asArray<unknown>(raw.services)
    .map((item) => {
      const row = asRecord(item);
      if (!row) return null;
      const key = String(row.key ?? "").trim();
      const name = String(row.name ?? "").trim();
      if (!key || !name) return null;
      const status = String(row.status ?? "healthy").toLowerCase();
      const latency = asRecord(row.latency);
      return {
        key,
        name,
        status: (["healthy", "degraded", "down"].includes(status) ? status : "healthy") as ServiceStatus,
        uptimePct: toNumber(row.uptimePct),
        latency: {
          p50: toNumber(latency?.p50),
          p95: toNumber(latency?.p95),
          p99: toNumber(latency?.p99),
        },
        errorRatePct: toNumber(row.errorRatePct),
      } satisfies InfraService;
    })
    .filter((item): item is InfraService => Boolean(item));

  const latencyTrends = asArray<unknown>(raw.latencyTrends)
    .map((item) => {
      const row = asRecord(item);
      if (!row) return null;
      const bucket = String(row.bucket ?? "").trim();
      if (!bucket) return null;
      return {
        bucket,
        label: String(row.label ?? ""),
        p50: toNumber(row.p50),
        p95: toNumber(row.p95),
        p99: toNumber(row.p99),
      } satisfies LatencyTrendPoint;
    })
    .filter((item): item is LatencyTrendPoint => Boolean(item));

  const errorRateByService = asArray<unknown>(raw.errorRateByService)
    .map((item) => {
      const row = asRecord(item);
      if (!row) return null;
      const bucket = String(row.bucket ?? "").trim();
      if (!bucket) return null;
      return {
        bucket,
        label: String(row.label ?? ""),
        apiGateway: toNumber(row.apiGateway),
        intentParser: toNumber(row.intentParser),
        ragService: toNumber(row.ragService),
        embeddingWorker: toNumber(row.embeddingWorker),
        governanceEngine: toNumber(row.governanceEngine),
        executionSandbox: toNumber(row.executionSandbox),
        syncEngine: toNumber(row.syncEngine),
        billingService: toNumber(row.billingService),
        notificationService: toNumber(row.notificationService),
      } satisfies ErrorRatePoint;
    })
    .filter((item): item is ErrorRatePoint => Boolean(item));

  const queueHealth = asArray<unknown>(raw.queueHealth)
    .map((item) => {
      const row = asRecord(item);
      if (!row) return null;
      const queueName = String(row.queueName ?? "").trim();
      if (!queueName) return null;
      const status = String(row.status ?? "healthy").toLowerCase();
      return {
        queueName,
        depth: Math.max(0, Math.floor(toNumber(row.depth))),
        consumerLagSec: Math.max(0, Math.floor(toNumber(row.consumerLagSec))),
        status: (["healthy", "degraded", "down"].includes(status) ? status : "healthy") as ServiceStatus,
      } satisfies QueueHealthRow;
    })
    .filter((item): item is QueueHealthRow => Boolean(item));

  const recentIncidents = asArray<unknown>(raw.recentIncidents)
    .map((item) => {
      const row = asRecord(item);
      if (!row) return null;
      const id = String(row.id ?? "").trim();
      const description = String(row.description ?? "").trim();
      if (!id || !description) return null;
      const severity = String(row.severity ?? "medium").toLowerCase();
      const status = String(row.status ?? "investigating").toLowerCase();
      return {
        id,
        severity: (["low", "medium", "high", "critical"].includes(severity) ? severity : "medium") as IncidentRow["severity"],
        description,
        durationMinutes:
          row.durationMinutes === null || row.durationMinutes === undefined
            ? null
            : Math.max(0, Math.floor(toNumber(row.durationMinutes))),
        affectedServices: asArray<unknown>(row.affectedServices).map((entry) => String(entry)).filter(Boolean),
        resolution: row.resolution ? String(row.resolution) : null,
        status: (["active", "investigating", "resolved"].includes(status) ? status : "investigating") as IncidentRow["status"],
        startedAt: String(row.startedAt ?? new Date().toISOString()),
        resolvedAt: row.resolvedAt ? String(row.resolvedAt) : null,
      } satisfies IncidentRow;
    })
    .filter((item): item is IncidentRow => Boolean(item));

  const costByService = asArray<unknown>(costAnalytics?.costByService)
    .map((item) => {
      const row = asRecord(item);
      if (!row) return null;
      const serviceKey = String(row.serviceKey ?? "").trim();
      const serviceName = String(row.serviceName ?? "").trim();
      if (!serviceKey || !serviceName) return null;
      return {
        serviceKey,
        serviceName,
        costUsd: toNumber(row.costUsd),
      } satisfies ServiceCostRow;
    })
    .filter((item): item is ServiceCostRow => Boolean(item));

  const llmSpendByProvider = asArray<unknown>(costAnalytics?.llmSpendByProvider)
    .map((item) => {
      const row = asRecord(item);
      if (!row) return null;
      const provider = String(row.provider ?? "").trim();
      if (!provider) return null;
      return {
        provider,
        costUsd: toNumber(row.costUsd),
      } satisfies ProviderCostRow;
    })
    .filter((item): item is ProviderCostRow => Boolean(item));

  return {
    generatedAt: String(raw.generatedAt ?? new Date().toISOString()),
    windowHours: Math.max(6, Math.min(168, Math.floor(toNumber(raw.windowHours, 24)))),
    systemStatus: {
      status: systemStatus?.status === "degraded" ? "degraded" : "healthy",
      label:
        typeof systemStatus?.label === "string" && systemStatus.label.trim()
          ? systemStatus.label
          : "All Systems Operational",
      lastCheckedSecondsAgo: Math.max(0, Math.floor(toNumber(systemStatus?.lastCheckedSecondsAgo, 30))),
      autoRefreshSeconds: Math.max(10, Math.floor(toNumber(systemStatus?.autoRefreshSeconds, 30))),
    },
    services,
    latencyTrends,
    errorRateByService,
    queueHealth,
    recentIncidents,
    costAnalytics: {
      costByService,
      avgCostPerTenantUsd: toNumber(costAnalytics?.avgCostPerTenantUsd),
      llmSpendByProvider,
    },
  };
}

function formatPct(value: number, digits = 2) {
  return `${value.toFixed(digits)}%`;
}

function formatMs(value: number) {
  return `${Math.round(value)}ms`;
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatLag(seconds: number) {
  if (seconds <= 0) return "-";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function serviceStatusClass(status: ServiceStatus) {
  if (status === "healthy") return "text-emerald-700 bg-emerald-50 border-emerald-200";
  if (status === "degraded") return "text-amber-700 bg-amber-50 border-amber-200";
  return "text-rose-700 bg-rose-50 border-rose-200";
}

function incidentSeverityClass(severity: IncidentRow["severity"]) {
  if (severity === "critical") return "bg-rose-100 text-rose-800";
  if (severity === "high") return "bg-orange-100 text-orange-800";
  if (severity === "medium") return "bg-amber-100 text-amber-800";
  return "bg-emerald-100 text-emerald-800";
}

function queueStatusIcon(status: ServiceStatus) {
  if (status === "healthy") return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
  if (status === "degraded") return <CircleDot className="h-4 w-4 text-amber-600" />;
  return <XCircle className="h-4 w-4 text-rose-600" />;
}

export default function PlatformAdminInfrastructure() {
  const { toast } = useToast();
  const [hours, setHours] = useState("24");
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<InfraPayload>(EMPTY_PAYLOAD);
  const [nowTick, setNowTick] = useState(Date.now());

  const loadPayload = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await invokeEdge("platform-admin-infrastructure", {
        body: {
          operation: "get_payload",
          hours: Number(hours),
        },
      });

      if (error) throw error;
      const response = asRecord(data);
      setPayload(normalizePayload(response?.payload));
      setNowTick(Date.now());
    } catch (error) {
      toast({
        title: "Could not load infrastructure health",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [hours, toast]);

  useEffect(() => {
    void loadPayload();
  }, [loadPayload]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadPayload();
    }, payload.systemStatus.autoRefreshSeconds * 1000);

    return () => window.clearInterval(timer);
  }, [loadPayload, payload.systemStatus.autoRefreshSeconds]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const generatedAt = useMemo(() => new Date(payload.generatedAt).getTime(), [payload.generatedAt]);
  const secondsSince = Math.max(0, Math.floor((nowTick - generatedAt) / 1000));

  const statusClasses = payload.systemStatus.status === "healthy"
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : "border-amber-200 bg-amber-50 text-amber-800";

  return (
    <div className="space-y-6 animate-fade-in">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-600">Platform Super Admin</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Infrastructure Health</h1>
        <p className="text-sm text-muted-foreground">Platform service status, queue telemetry, incidents, and infrastructure spend.</p>
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
        <div className={cn("rounded-xl border px-4 py-3", statusClasses)}>
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            <p className="text-sm font-semibold">{payload.systemStatus.label}</p>
          </div>
          <p className="mt-1 text-xs">Last checked {secondsSince}s ago</p>
        </div>

        <div className="flex items-center gap-2">
          <Select value={hours} onValueChange={setHours}>
            <SelectTrigger className="w-[170px]">
              <SelectValue placeholder="Time window" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="12">Last 12 hours</SelectItem>
              <SelectItem value="24">Last 24 hours</SelectItem>
              <SelectItem value="48">Last 48 hours</SelectItem>
              <SelectItem value="72">Last 72 hours</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => void loadPayload()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
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
          <section className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {payload.services.map((service) => {
              const Icon = SERVICE_ICON_MAP[service.key] ?? Server;
              return (
                <div key={service.key} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <Icon className="h-4 w-4 text-slate-500" />
                        <p className="text-sm font-semibold text-slate-900">{service.name}</p>
                      </div>
                      <Badge className={cn("mt-2 capitalize border", serviceStatusClass(service.status))}>{service.status}</Badge>
                    </div>
                    <p className="text-xs text-slate-500">Uptime {formatPct(service.uptimePct)}</p>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <div className="rounded-md bg-slate-50 p-2">
                      <p className="text-slate-500">P50</p>
                      <p className="font-semibold text-slate-900">{formatMs(service.latency.p50)}</p>
                    </div>
                    <div className="rounded-md bg-slate-50 p-2">
                      <p className="text-slate-500">P95</p>
                      <p className="font-semibold text-slate-900">{formatMs(service.latency.p95)}</p>
                    </div>
                    <div className="rounded-md bg-slate-50 p-2">
                      <p className="text-slate-500">P99</p>
                      <p className="font-semibold text-slate-900">{formatMs(service.latency.p99)}</p>
                    </div>
                  </div>

                  <p className="mt-3 text-xs text-slate-600">Error rate: <span className="font-semibold">{formatPct(service.errorRatePct)}</span></p>
                </div>
              );
            })}
          </section>

          <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">Latency Trends</h2>
              <p className="text-xs text-slate-500">P50 / P95 / P99 over the selected window.</p>
              <div className="mt-3 h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={payload.latencyTrends}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
                    <YAxis tickLine={false} axisLine={false} fontSize={11} tickFormatter={(v) => `${Math.round(v)}ms`} />
                    <Tooltip formatter={(value: number) => formatMs(value)} />
                    <Legend />
                    <Line type="monotone" dataKey="p50" stroke="#10b981" strokeWidth={2} dot={false} name="P50" />
                    <Line type="monotone" dataKey="p95" stroke="#f59e0b" strokeWidth={2} dot={false} name="P95" />
                    <Line type="monotone" dataKey="p99" stroke="#ef4444" strokeWidth={2} dot={false} name="P99" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">Error Rate by Service</h2>
              <p className="text-xs text-slate-500">Stacked service error distribution over time.</p>
              <div className="mt-3 h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={payload.errorRateByService}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
                    <YAxis tickLine={false} axisLine={false} fontSize={11} tickFormatter={(v) => `${v}%`} />
                    <Tooltip formatter={(value: number) => formatPct(value)} />
                    <Legend />
                    {ERROR_KEYS.map((entry) => (
                      <Area
                        key={entry.key}
                        type="monotone"
                        dataKey={entry.key}
                        stackId="errors"
                        stroke={entry.color}
                        fill={entry.color}
                        fillOpacity={0.2}
                        name={entry.label}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">Queue Health</h2>
            <div className="mt-3 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Queue Name</TableHead>
                    <TableHead className="text-right">Depth</TableHead>
                    <TableHead className="text-right">Consumer Lag</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payload.queueHealth.map((row) => (
                    <TableRow key={row.queueName}>
                      <TableCell className="font-medium text-slate-900">{row.queueName}</TableCell>
                      <TableCell className="text-right">{row.depth}</TableCell>
                      <TableCell className="text-right">{formatLag(row.consumerLagSec)}</TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-2 capitalize">
                          {queueStatusIcon(row.status)} {row.status}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>

          <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">Recent Incidents</h2>
              <p className="text-xs text-slate-500">Infrastructure events from the last 7 days.</p>
              <div className="mt-3 space-y-2">
                {payload.recentIncidents.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
                    No incidents in the selected period.
                  </div>
                ) : (
                  payload.recentIncidents.map((incident) => (
                    <div key={incident.id} className="rounded-lg border border-slate-200 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <Badge className={incidentSeverityClass(incident.severity)}>{incident.severity.toUpperCase()}</Badge>
                        <span className="text-xs text-slate-500 capitalize">{incident.status}</span>
                      </div>
                      <p className="mt-2 text-sm font-medium text-slate-900">{incident.description}</p>
                      <p className="mt-1 text-xs text-slate-600">
                        {new Date(incident.startedAt).toLocaleString()} {incident.durationMinutes !== null ? `· Duration ${incident.durationMinutes}m` : ""}
                      </p>
                      {incident.affectedServices.length > 0 ? (
                        <p className="mt-1 text-xs text-slate-600">Affected: {incident.affectedServices.join(", ")}</p>
                      ) : null}
                      {incident.resolution ? <p className="mt-1 text-xs text-slate-600">Resolution: {incident.resolution}</p> : null}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">Cost Analytics</h2>
              <p className="text-xs text-slate-500">Infrastructure cost allocation and LLM spend.</p>
              <div className="mt-3 h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={payload.costAnalytics.costByService}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="serviceName" tickLine={false} axisLine={false} fontSize={10} interval={0} angle={-25} textAnchor="end" height={80} />
                    <YAxis tickLine={false} axisLine={false} fontSize={11} tickFormatter={(v) => `$${v}`} />
                    <Tooltip formatter={(value: number) => formatCurrency(value)} />
                    <Bar dataKey="costUsd" fill="#7c3aed" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-2 rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-500">Average cost per tenant</p>
                <p className="text-lg font-semibold text-slate-900">{formatCurrency(payload.costAnalytics.avgCostPerTenantUsd)}</p>
              </div>

              <div className="mt-3 space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">LLM API Spend</p>
                {payload.costAnalytics.llmSpendByProvider.length === 0 ? (
                  <p className="text-xs text-slate-500">No LLM spend recorded yet.</p>
                ) : (
                  payload.costAnalytics.llmSpendByProvider.map((row) => (
                    <div key={row.provider} className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-sm">
                      <span className="font-medium capitalize text-slate-900">{row.provider}</span>
                      <span className="text-slate-700">{formatCurrency(row.costUsd)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
