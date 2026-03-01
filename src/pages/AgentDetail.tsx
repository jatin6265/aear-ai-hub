import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
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
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdge } from "@/lib/edge-invoke";

type Operation =
  | "get"
  | "rename"
  | "toggle_agent"
  | "toggle_tool"
  | "update_raci_role"
  | "clear_memory";

type AgentStatusBucket = "active" | "inactive" | "training";
type ToolRisk = "low" | "medium" | "high" | "critical";

type AgentHeader = {
  id: string;
  name: string;
  slug: string;
  domain: string;
  description: string | null;
  status: string;
  avatarEmoji: string | null;
  sourceConnectionId: string | null;
  sourceConnectionName: string | null;
  updatedAt: string;
};

type AgentTool = {
  id: string;
  name: string;
  method: string;
  endpoint: string;
  riskLevel: ToolRisk;
  raciRequired: "R" | "A" | "C" | "I";
  version: string;
  enabled: boolean;
  updatedAt: string;
};

type MemoryPreview = {
  id: string;
  memoryType: "session" | "user" | "organization";
  key: string;
  value: unknown;
  updatedAt: string;
};

type AgentDetailPayload = {
  agent: AgentHeader;
  tools: AgentTool[];
  memory: {
    session: { activeSessions: number };
    user: { entriesCount: number; lastUpdated: string | null };
    organization: {
      entriesCount: number;
      lastUpdated: string | null;
      vectorCount: number;
      storageBytes: number;
    };
    preview: MemoryPreview[];
  };
  performance: {
    queriesPerDay: Array<{ day: string; queries: number }>;
    successFailure: { success: number; failure: number };
    avgResponseTrend: Array<{ day: string; avgMs: number }>;
    mostUsedTools: Array<{ tool: string; count: number }>;
  };
  raciBindings: Array<{
    id: string;
    resource: string;
    action: string;
    roleName: string;
    raciType: "R" | "A" | "C" | "I";
    updatedAt: string;
  }>;
  recentExecutions: Array<{
    id: string;
    toolName: string;
    status: string;
    riskLevel: string | null;
    latencyMs: number | null;
    error: string | null;
    createdAt: string;
  }>;
};

type AgentDetailResponse = {
  ok: boolean;
  detail?: AgentDetailPayload;
  error?: string | null;
};

function formatBytes(bytes: number) {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Please try again.";
}

function statusBucket(status: string): AgentStatusBucket {
  const normalized = status.toLowerCase();
  if (normalized === "ready") return "active";
  if (normalized === "syncing" || normalized === "draft") return "training";
  return "inactive";
}

function statusLabel(bucket: AgentStatusBucket) {
  if (bucket === "active") return "Active";
  if (bucket === "training") return "Training";
  return "Inactive";
}

function statusClass(bucket: AgentStatusBucket) {
  if (bucket === "active") return "border-0 bg-emerald-100 text-emerald-700";
  if (bucket === "training") return "border-0 bg-blue-100 text-blue-700";
  return "border-0 bg-slate-200 text-slate-700";
}

function statusDotClass(bucket: AgentStatusBucket) {
  if (bucket === "active") return "bg-emerald-500";
  if (bucket === "training") return "animate-pulse bg-blue-500";
  return "bg-slate-400";
}

function riskBadgeClass(risk: string) {
  const normalized = risk.toLowerCase();
  if (normalized === "low") return "border-0 bg-emerald-100 text-emerald-700";
  if (normalized === "medium") return "border-0 bg-amber-100 text-amber-700";
  if (normalized === "high") return "border-0 bg-rose-100 text-rose-700";
  return "border-0 bg-red-950 text-red-100";
}

function executionStatusClass(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "success" || normalized === "blocked") return "border-0 bg-emerald-100 text-emerald-700";
  if (normalized === "running" || normalized === "queued") return "border-0 bg-blue-100 text-blue-700";
  if (normalized === "error" || normalized === "failed") return "border-0 bg-rose-100 text-rose-700";
  return "border-0 bg-slate-200 text-slate-700";
}

function formatRelativeTime(value: string) {
  const now = Date.now();
  const then = new Date(value).getTime();
  const diff = now - then;
  if (!Number.isFinite(then)) return "-";
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
  return `${Math.floor(diff / 86_400_000)} d ago`;
}

function xAxisDay(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { weekday: "short" });
}

export default function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [detail, setDetail] = useState<AgentDetailPayload | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [raciDrafts, setRaciDrafts] = useState<Record<string, string>>({});
  const [savingRaciId, setSavingRaciId] = useState<string | null>(null);
  const [togglingToolId, setTogglingToolId] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const runOperation = useCallback(
    async (operation: Operation, extraBody: Record<string, unknown> = {}, silent = false) => {
      if (!id) return null;
      const { data, error } = await invokeEdge("agent-detail", {
        body: {
          operation,
          agentId: id,
          ...extraBody,
        },
      });
      if (error) throw error;
      const payload = (data ?? null) as AgentDetailResponse | null;
      if (!payload?.ok || !payload.detail) throw new Error(payload?.error ?? "Agent detail request failed.");
      setDetail(payload.detail);
      setNameDraft(payload.detail.agent.name);
      if (!silent) {
        setRaciDrafts((prev) => {
          const next = { ...prev };
          payload.detail?.raciBindings.forEach((binding) => {
            next[binding.id] = binding.roleName;
          });
          return next;
        });
      }
      return payload.detail;
    },
    [id],
  );

  // Fallback: load basic agent info directly from the DB when edge fn is unavailable
  const loadFromDb = useCallback(async (): Promise<boolean> => {
    if (!id) return false;
    const { data, error } = await supabase
      .from("agents")
      .select("id, name, slug, domain, description, status, avatar_emoji, source_connection_id, updated_at")
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return false;
    setDetail({
      agent: {
        id: data.id as string,
        name: (data.name as string) ?? "Unnamed Agent",
        slug: (data.slug as string) ?? "",
        domain: (data.domain as string) ?? "general",
        description: (data.description as string | null) ?? null,
        status: (data.status as string) ?? "inactive",
        avatarEmoji: (data.avatar_emoji as string | null) ?? null,
        sourceConnectionId: (data.source_connection_id as string | null) ?? null,
        sourceConnectionName: null,
        updatedAt: (data.updated_at as string) ?? new Date().toISOString(),
      },
      tools: [],
      memory: {
        session: { activeSessions: 0 },
        user: { entriesCount: 0, lastUpdated: null },
        organization: { entriesCount: 0, lastUpdated: null, vectorCount: 0, storageBytes: 0 },
        preview: [],
      },
      performance: {
        queriesPerDay: [],
        successFailure: { success: 0, failure: 0 },
        avgResponseTrend: [],
        mostUsedTools: [],
      },
      raciBindings: [],
      recentExecutions: [],
    });
    return true;
  }, [id]);

  const load = useCallback(async () => {
    if (!id || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      const payload = await runOperation("get", {}, true);
      if (payload) {
        setRaciDrafts(
          payload.raciBindings.reduce<Record<string, string>>((acc, binding) => {
            acc[binding.id] = binding.roleName;
            return acc;
          }, {}),
        );
      }
    } catch {
      // Edge function unavailable — try direct DB fallback
      const loaded = await loadFromDb();
      if (loaded) {
        toast({
          title: "Live analytics unavailable",
          description: "Showing basic agent info from the database. Deploy edge functions to enable full detail.",
        });
      } else {
        setLoadError("Could not load agent details. The backend service may not be available.");
        toast({
          title: "Could not load agent detail",
          description: "Both the edge function and the database fallback failed.",
          variant: "destructive",
        });
      }
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, [id, runOperation, toast, loadFromDb]);

  useEffect(() => {
    void load();
  }, [load]);

  const agentBucket = detail ? statusBucket(detail.agent.status) : "inactive";
  const successFailureData = useMemo(
    () =>
      detail
        ? [
            { name: "Success", value: detail.performance.successFailure.success, color: "#22c55e" },
            { name: "Failure", value: detail.performance.successFailure.failure, color: "#ef4444" },
          ]
        : [],
    [detail],
  );

  const handleSaveName = async () => {
    if (!detail) return;
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      toast({ title: "Agent name required", description: "Please enter a valid name.", variant: "destructive" });
      return;
    }

    setUpdating(true);
    try {
      await runOperation("rename", { name: trimmed });
      setEditingName(false);
      toast({ title: "Agent name updated", description: "Agent name saved successfully." });
    } catch (error) {
      toast({
        title: "Could not rename agent",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setUpdating(false);
    }
  };

  const handleToggleAgent = async (enabled: boolean) => {
    if (!detail) return;
    if (!enabled && statusBucket(detail.agent.status) === "active") {
      const confirmed = window.confirm(`Disable ${detail.agent.name}? This will stop action execution for this agent.`);
      if (!confirmed) return;
    }

    setUpdating(true);
    try {
      await runOperation("toggle_agent", { enabled });
      toast({
        title: enabled ? "Agent enabled" : "Agent disabled",
        description: `${detail.agent.name} is now ${enabled ? "enabled" : "disabled"}.`,
      });
    } catch (error) {
      toast({
        title: "Could not update agent status",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setUpdating(false);
    }
  };

  const handleToggleTool = async (tool: AgentTool, enabled: boolean) => {
    setTogglingToolId(tool.id);
    try {
      await runOperation("toggle_tool", { toolId: tool.id, enabled }, true);
      toast({
        title: enabled ? "Tool enabled" : "Tool disabled",
        description: `${tool.name} is now ${enabled ? "enabled" : "disabled"}.`,
      });
    } catch (error) {
      toast({
        title: "Could not update tool",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setTogglingToolId(null);
    }
  };

  const handleClearMemory = async (memoryType: "session" | "all") => {
    if (!detail) return;
    const confirmed = window.confirm(
      memoryType === "all"
        ? "Purge all memory for this agent? This action cannot be undone."
        : "Clear all session memory entries for this agent?",
    );
    if (!confirmed) return;

    setUpdating(true);
    try {
      await runOperation("clear_memory", { memoryType }, true);
      toast({
        title: memoryType === "all" ? "Memory purged" : "Session memory cleared",
        description: memoryType === "all" ? "All memory entries were removed." : "Session memory entries were removed.",
      });
    } catch (error) {
      toast({
        title: "Could not clear memory",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setUpdating(false);
    }
  };

  const handleSaveRaciRole = async (bindingId: string) => {
    const roleName = (raciDrafts[bindingId] ?? "").trim();
    if (!roleName) {
      toast({
        title: "Role name required",
        description: "Please enter a valid role name.",
        variant: "destructive",
      });
      return;
    }

    setSavingRaciId(bindingId);
    try {
      await runOperation("update_raci_role", { bindingId, roleName }, true);
      toast({ title: "RACI binding updated", description: "Role assignment saved." });
    } catch (error) {
      toast({
        title: "Could not update RACI binding",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setSavingRaciId(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Button type="button" variant="ghost" size="sm" onClick={() => navigate("/dashboard/agents")}>
            <ChevronLeft className="h-4 w-4" />
            Back to Agents
          </Button>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-10 shadow-sm text-center">
          <AlertTriangle className="mx-auto h-10 w-10 text-amber-500" />
          <h2 className="mt-4 text-lg font-semibold text-slate-900">Agent details unavailable</h2>
          <p className="mt-2 text-sm text-slate-600 max-w-sm mx-auto">
            {loadError ?? "The agent detail service is not reachable. This usually means the backend edge function hasn't been deployed yet."}
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <Button onClick={() => void load()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry
            </Button>
            <Button variant="outline" onClick={() => navigate("/dashboard/agents")}>
              Back to Agents
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Button type="button" variant="ghost" size="sm" onClick={() => navigate("/dashboard/agents")}>
          <ChevronLeft className="h-4 w-4" />
          Back
        </Button>
        <span>/</span>
        <Link to="/dashboard/agents" className="hover:text-slate-700">
          Agents
        </Link>
        <span>/</span>
        <span className="text-slate-700">{detail.agent.name}</span>
      </div>

      <header className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-violet-100 text-3xl">
              {detail.agent.avatarEmoji || "🤖"}
            </span>
            <div>
              {editingName ? (
                <div className="flex items-center gap-2">
                  <Input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} className="h-9 w-64" />
                  <Button type="button" size="sm" onClick={() => void handleSaveName()} disabled={updating}>
                    {updating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setEditingName(false)} disabled={updating}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-bold tracking-tight text-slate-900">{detail.agent.name}</h1>
                  <Button type="button" size="sm" variant="outline" onClick={() => setEditingName(true)}>
                    <Pencil className="h-3.5 w-3.5" />
                    Edit name
                  </Button>
                </div>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Badge className={statusClass(agentBucket)}>
                  <span className={cn("mr-1.5 inline-block h-2 w-2 rounded-full", statusDotClass(agentBucket))} />
                  {statusLabel(agentBucket)}
                </Badge>
                <Badge className="border-0 bg-slate-100 text-slate-700">
                  Source: {detail.agent.sourceConnectionName || "Auto-discovered"}
                </Badge>
              </div>
              <p className="mt-2 text-sm text-slate-600">{detail.agent.description || "Domain-specific enterprise agent"}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={agentBucket !== "inactive"}
              onCheckedChange={(next) => void handleToggleAgent(next)}
              disabled={updating}
            />
            <span className="text-sm text-slate-600">{agentBucket !== "inactive" ? "Enabled" : "Disabled"}</span>
          </div>
        </div>
      </header>

      <Tabs defaultValue="tools" className="space-y-4">
        <TabsList>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="memory">Memory</TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
          <TabsTrigger value="raci">RACI Bindings</TabsTrigger>
        </TabsList>

        <TabsContent value="tools" className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Tools</h2>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                toast({
                  title: "Add Tool",
                  description: "Custom tool creation will be available in a future release.",
                })
              }
            >
              Add Tool
            </Button>
          </div>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>Risk Level</TableHead>
                  <TableHead>RACI Required</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead className="text-right">Enabled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.tools.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-sm text-slate-500">
                      No tools configured for this agent yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  detail.tools.map((tool) => (
                    <TableRow key={tool.id}>
                      <TableCell className="font-medium text-slate-900">{tool.name}</TableCell>
                      <TableCell>{tool.method}</TableCell>
                      <TableCell className="font-mono text-xs text-slate-600">{tool.endpoint}</TableCell>
                      <TableCell>
                        <Badge className={riskBadgeClass(tool.riskLevel)}>{tool.riskLevel.toUpperCase()}</Badge>
                      </TableCell>
                      <TableCell>{tool.raciRequired}</TableCell>
                      <TableCell>{tool.version}</TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-2">
                          {togglingToolId === tool.id ? <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-600" /> : null}
                          <Switch
                            checked={tool.enabled}
                            disabled={togglingToolId === tool.id}
                            onCheckedChange={(next) => void handleToggleTool(tool, next)}
                            aria-label={`Toggle ${tool.name}`}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="memory" className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-slate-500">Session Memory</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{detail.memory.session.activeSessions}</p>
              <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void handleClearMemory("session")} disabled={updating}>
                Clear all
              </Button>
            </article>
            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-slate-500">User Memory</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{detail.memory.user.entriesCount}</p>
              <p className="mt-2 text-xs text-slate-500">
                Last updated: {detail.memory.user.lastUpdated ? formatRelativeTime(detail.memory.user.lastUpdated) : "-"}
              </p>
            </article>
            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-slate-500">Organizational Memory</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{detail.memory.organization.vectorCount}</p>
              <p className="mt-2 text-xs text-slate-500">Storage: {formatBytes(detail.memory.organization.storageBytes)}</p>
            </article>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-900">Latest Memory Entries</h3>
            <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.memory.preview.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-sm text-slate-500">
                        No memory entries available.
                      </TableCell>
                    </TableRow>
                  ) : (
                    detail.memory.preview.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="capitalize">{entry.memoryType}</TableCell>
                        <TableCell className="font-mono text-xs">{entry.key}</TableCell>
                        <TableCell className="max-w-[340px] truncate text-xs">
                          {typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value)}
                        </TableCell>
                        <TableCell>{formatRelativeTime(entry.updatedAt)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            <Button
              type="button"
              size="sm"
              className="mt-4 border-0 bg-rose-600 text-white hover:bg-rose-500"
              onClick={() => void handleClearMemory("all")}
              disabled={updating}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Purge Memory
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="performance" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-900">Queries per day (last 7 days)</h3>
              <div className="mt-3 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={detail.performance.queriesPerDay}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="day" tickFormatter={xAxisDay} tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip labelFormatter={(value) => xAxisDay(String(value))} />
                    <Bar dataKey="queries" fill="#7c3aed" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-900">Success vs failure rate</h3>
              <div className="mt-3 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Tooltip />
                    <Pie
                      data={successFailureData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={54}
                      outerRadius={84}
                    >
                      {successFailureData.map((item) => (
                        <Cell key={item.name} fill={item.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </article>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-900">Avg response time trend</h3>
              <div className="mt-3 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={detail.performance.avgResponseTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="day" tickFormatter={xAxisDay} tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip labelFormatter={(value) => xAxisDay(String(value))} />
                    <Line type="monotone" dataKey="avgMs" stroke="#0ea5e9" strokeWidth={2.5} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-900">Most used tools</h3>
              <div className="mt-3 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={detail.performance.mostUsedTools} layout="vertical" margin={{ left: 14 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" tick={{ fontSize: 11 }} />
                    <YAxis dataKey="tool" type="category" width={120} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="count" fill="#14b8a6" radius={[0, 6, 6, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>
          </div>
        </TabsContent>

        <TabsContent value="raci" className="space-y-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-900">RACI rules applied to this agent</h3>
            <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Resource</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>RACI</TableHead>
                    <TableHead>Role Assignment</TableHead>
                    <TableHead className="text-right">Save</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.raciBindings.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-sm text-slate-500">
                        No RACI bindings available.
                      </TableCell>
                    </TableRow>
                  ) : (
                    detail.raciBindings.map((binding) => (
                      <TableRow key={binding.id}>
                        <TableCell>{binding.resource}</TableCell>
                        <TableCell>{binding.action}</TableCell>
                        <TableCell>
                          <Badge className="border-0 bg-violet-100 text-violet-700">{binding.raciType}</Badge>
                        </TableCell>
                        <TableCell>
                          <Input
                            value={raciDrafts[binding.id] ?? ""}
                            onChange={(event) =>
                              setRaciDrafts((prev) => ({
                                ...prev,
                                [binding.id]: event.target.value,
                              }))
                            }
                            className="h-8 max-w-[220px]"
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void handleSaveRaciRole(binding.id)}
                            disabled={savingRaciId === binding.id}
                          >
                            {savingRaciId === binding.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                            Save
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-900">Recent Executions Log</h3>
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tool</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Risk</TableHead>
                <TableHead>Latency</TableHead>
                <TableHead>Timestamp</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.recentExecutions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-slate-500">
                    No recent executions yet.
                  </TableCell>
                </TableRow>
              ) : (
                detail.recentExecutions.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.toolName}</TableCell>
                    <TableCell>
                      <Badge className={executionStatusClass(row.status)}>{row.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {row.riskLevel ? <Badge className={riskBadgeClass(row.riskLevel)}>{row.riskLevel.toUpperCase()}</Badge> : "-"}
                    </TableCell>
                    <TableCell>{row.latencyMs ? `${row.latencyMs}ms` : "-"}</TableCell>
                    <TableCell>{formatRelativeTime(row.createdAt)}</TableCell>
                    <TableCell className="max-w-[280px] truncate text-xs text-slate-600">{row.error || "-"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          Add Tool is intentionally placeholder for now. Backend supports tool enable/disable and governance updates.
          <CheckCircle2 className="h-4 w-4" />
        </div>
      </div>
    </div>
  );
}
