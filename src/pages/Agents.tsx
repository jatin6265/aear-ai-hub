import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, Info, Loader2, PlusCircle, RefreshCw, Settings2, Trash2, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { formatEdgeFunctionError } from "@/lib/edge-function-error";
import { invokeEdge } from "@/lib/edge-invoke";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

type AgentStatusBucket = "active" | "inactive" | "training";

const DOMAIN_OPTIONS = ["operations", "finance", "analytics", "hr", "risk", "support"] as const;
const VECTOR_OPTIONS = ["hybrid", "vector", "lexical"] as const;
const SYNC_OPTIONS = ["realtime", "5m", "hourly", "daily"] as const;
const EMOJI_OPTIONS = ["🤖", "⚙️", "💰", "📊", "📦", "🛡️", "🔍", "🧠", "📋", "🧾", "🛰️", "🧩"];

type AgentCardRow = {
  id: string;
  name: string;
  slug: string;
  domain: string;
  description: string | null;
  status: string;
  status_bucket: AgentStatusBucket;
  avatar_emoji: string | null;
  source_connection_id: string | null;
  source_connection_name: string | null;
  capabilities: string[] | null;
  raci_scope: string | null;
  queries_today: number | null;
  success_rate: number | null;
  avg_response_ms: number | null;
  lifecycle_reason: string | null;
  is_custom: boolean | null;
  updated_at: string;
};

type AgentsDashboardResponse = {
  ok: boolean;
  summary?: {
    active: number;
    inactive: number;
    training: number;
  };
  agents?: AgentCardRow[];
  error?: string | null;
};

type StudioConnection = {
  id: string;
  name: string;
  type: string;
  status: string;
  schemaDetected: boolean;
};

type StudioTemplate = {
  key: string;
  name: string;
  domain: string;
  icon: string;
  description: string;
  capabilities: string[];
};

type StudioSelectedAgent = {
  id: string;
  name: string;
  domain: string;
  description: string | null;
  avatarEmoji: string | null;
  capabilities: string[];
  raciScope: string | null;
  studio?: {
    prompt?: string | null;
    objective?: string | null;
    systemPrompt?: string | null;
    vectorStrategy?: string | null;
    ragEnabled?: boolean;
    autoSync?: boolean;
    autoDeploy?: boolean;
    syncFrequency?: string | null;
    sourceConnectionIds?: string[];
  } | null;
};

type StudioPayload = {
  templates: StudioTemplate[];
  connections: StudioConnection[];
  selectedAgent: StudioSelectedAgent | null;
};

type AgentStudioInvokeResponse = {
  ok?: boolean;
  payload?: unknown;
  blueprint?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  error?: string;
};

type StudioMode = "create" | "configure";

type StudioForm = {
  agentId: string | null;
  name: string;
  description: string;
  domain: (typeof DOMAIN_OPTIONS)[number];
  prompt: string;
  objective: string;
  systemPrompt: string;
  avatarEmoji: string;
  capabilitiesText: string;
  connectionIds: string[];
  syncFrequency: (typeof SYNC_OPTIONS)[number];
  vectorStrategy: (typeof VECTOR_OPTIONS)[number];
  ragEnabled: boolean;
  autoSync: boolean;
  autoDeploy: boolean;
  deployNow: boolean;
  raciScope: string;
};

function normalizeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Please try again.";
}

function badgeClass(bucket: AgentStatusBucket) {
  if (bucket === "active") return "border-0 bg-emerald-100 text-emerald-700";
  if (bucket === "training") return "border-0 bg-blue-100 text-blue-700";
  return "border-0 bg-slate-200 text-slate-700";
}

function dotClass(bucket: AgentStatusBucket) {
  if (bucket === "active") return "bg-emerald-500";
  if (bucket === "training") return "animate-pulse bg-blue-500";
  return "bg-slate-400";
}

function statusLabel(bucket: AgentStatusBucket) {
  if (bucket === "active") return "Active";
  if (bucket === "training") return "Training";
  return "Inactive";
}

function avatarBackground(domain: string) {
  const value = domain.toLowerCase();
  if (value.includes("finance")) return "bg-emerald-100 text-emerald-700";
  if (value.includes("ops") || value.includes("operations")) return "bg-blue-100 text-blue-700";
  if (value.includes("hr")) return "bg-orange-100 text-orange-700";
  if (value.includes("inventory")) return "bg-amber-100 text-amber-700";
  if (value.includes("analytics")) return "bg-violet-100 text-violet-700";
  if (value.includes("risk") || value.includes("admin")) return "bg-rose-100 text-rose-700";
  return "bg-slate-100 text-slate-700";
}

function domainFallbackEmoji(domain: string) {
  const value = domain.toLowerCase();
  if (value.includes("finance")) return "💰";
  if (value.includes("ops") || value.includes("operations")) return "⚙️";
  if (value.includes("hr")) return "📦";
  if (value.includes("inventory")) return "📋";
  if (value.includes("analytics")) return "📊";
  if (value.includes("risk") || value.includes("admin")) return "🛡️";
  return "🤖";
}

function formatPercent(value: number | null) {
  if (value === null || Number.isNaN(value)) return "0%";
  return `${Math.max(0, Math.min(100, Number(value))).toFixed(1)}%`;
}

function formatLatency(value: number | null) {
  if (value === null || Number.isNaN(value) || value <= 0) return "-";
  return `${Math.round(value)}ms`;
}

function toString(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => toString(item))
    .filter((item) => item.length > 0);
}

function normalizeStudioPayload(raw: unknown): StudioPayload {
  const payload = (raw ?? {}) as Record<string, unknown>;

  const connections = Array.isArray(payload.connections)
    ? payload.connections
        .map((row) => {
          const item = row as Record<string, unknown>;
          const id = toString(item.id);
          if (!id) return null;
          return {
            id,
            name: toString(item.name, "Connection"),
            type: toString(item.type, "custom"),
            status: toString(item.status, "pending"),
            schemaDetected: Boolean(item.schemaDetected),
          } satisfies StudioConnection;
        })
        .filter((item): item is StudioConnection => item !== null)
    : [];

  const templates = Array.isArray(payload.templates)
    ? payload.templates
        .map((row) => {
          const item = row as Record<string, unknown>;
          const key = toString(item.key).toLowerCase();
          if (!key) return null;
          return {
            key,
            name: toString(item.name, key),
            domain: toString(item.domain, "operations"),
            icon: toString(item.icon, "🤖"),
            description: toString(item.description, ""),
            capabilities: toStringArray(item.capabilities),
          } satisfies StudioTemplate;
        })
        .filter((item): item is StudioTemplate => item !== null)
    : [];

  const selectedRaw = payload.selectedAgent as Record<string, unknown> | null | undefined;
  const selectedAgent: StudioSelectedAgent | null = selectedRaw
    ? {
        id: toString(selectedRaw.id),
        name: toString(selectedRaw.name, "Custom Copilot"),
        domain: toString(selectedRaw.domain, "operations"),
        description: toString(selectedRaw.description, "") || null,
        avatarEmoji: toString(selectedRaw.avatarEmoji, "") || null,
        capabilities: toStringArray(selectedRaw.capabilities),
        raciScope: toString(selectedRaw.raciScope, "") || null,
        studio: selectedRaw.studio && typeof selectedRaw.studio === "object"
          ? {
              prompt: toString((selectedRaw.studio as Record<string, unknown>).prompt, "") || null,
              objective: toString((selectedRaw.studio as Record<string, unknown>).objective, "") || null,
              systemPrompt: toString((selectedRaw.studio as Record<string, unknown>).systemPrompt, "") || null,
              vectorStrategy: toString((selectedRaw.studio as Record<string, unknown>).vectorStrategy, "") || null,
              ragEnabled: Boolean((selectedRaw.studio as Record<string, unknown>).ragEnabled),
              autoSync: Boolean((selectedRaw.studio as Record<string, unknown>).autoSync),
              autoDeploy: Boolean((selectedRaw.studio as Record<string, unknown>).autoDeploy),
              syncFrequency: toString((selectedRaw.studio as Record<string, unknown>).syncFrequency, "") || null,
              sourceConnectionIds: toStringArray((selectedRaw.studio as Record<string, unknown>).sourceConnectionIds),
            }
          : null,
      }
    : null;

  return {
    templates,
    connections,
    selectedAgent,
  };
}

function createDefaultForm(): StudioForm {
  return {
    agentId: null,
    name: "",
    description: "",
    domain: "operations",
    prompt: "",
    objective: "",
    systemPrompt: "You are an enterprise AI agent. Enforce RACI and guardrails before any write action.",
    avatarEmoji: "🤖",
    capabilitiesText: "",
    connectionIds: [],
    syncFrequency: "hourly",
    vectorStrategy: "hybrid",
    ragEnabled: true,
    autoSync: true,
    autoDeploy: true,
    deployNow: true,
    raciScope: "",
  };
}

function formFromSelected(agent: StudioSelectedAgent): StudioForm {
  const form = createDefaultForm();
  return {
    ...form,
    agentId: agent.id,
    name: agent.name,
    description: agent.description ?? "",
    domain: DOMAIN_OPTIONS.includes(agent.domain as (typeof DOMAIN_OPTIONS)[number])
      ? (agent.domain as (typeof DOMAIN_OPTIONS)[number])
      : "operations",
    prompt: agent.studio?.prompt ?? "",
    objective: agent.studio?.objective ?? "",
    systemPrompt: agent.studio?.systemPrompt ?? form.systemPrompt,
    avatarEmoji: agent.avatarEmoji || domainFallbackEmoji(agent.domain),
    capabilitiesText: (agent.capabilities ?? []).join(", "),
    connectionIds: agent.studio?.sourceConnectionIds ?? [],
    syncFrequency: SYNC_OPTIONS.includes((agent.studio?.syncFrequency ?? "") as (typeof SYNC_OPTIONS)[number])
      ? (agent.studio?.syncFrequency as (typeof SYNC_OPTIONS)[number])
      : "hourly",
    vectorStrategy: VECTOR_OPTIONS.includes((agent.studio?.vectorStrategy ?? "") as (typeof VECTOR_OPTIONS)[number])
      ? (agent.studio?.vectorStrategy as (typeof VECTOR_OPTIONS)[number])
      : "hybrid",
    ragEnabled: agent.studio?.ragEnabled ?? true,
    autoSync: agent.studio?.autoSync ?? true,
    autoDeploy: agent.studio?.autoDeploy ?? true,
    deployNow: true,
    raciScope: agent.raciScope ?? "",
  };
}

export default function Agents() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentCardRow[]>([]);
  const [summary, setSummary] = useState({ active: 0, inactive: 0, training: 0 });
  const [toggleLoadingById, setToggleLoadingById] = useState<Record<string, boolean>>({});

  const [studioOpen, setStudioOpen] = useState(false);
  const [studioMode, setStudioMode] = useState<StudioMode>("create");
  const [studioLoading, setStudioLoading] = useState(false);
  const [studioSaving, setStudioSaving] = useState(false);
  const [studioPayload, setStudioPayload] = useState<StudioPayload>({ templates: [], connections: [], selectedAgent: null });
  const [studioForm, setStudioForm] = useState<StudioForm>(createDefaultForm);
  const [promptGenerating, setPromptGenerating] = useState(false);

  const sortedAgents = useMemo(
    () =>
      [...agents].sort((left, right) => {
        const order = { active: 0, training: 1, inactive: 2 };
        const statusGap = order[left.status_bucket] - order[right.status_bucket];
        if (statusGap !== 0) return statusGap;
        return left.name.localeCompare(right.name);
      }),
    [agents],
  );

  const loadAgents = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    try {
      const workspace = await ensureUserWorkspace(user);
      setTenantId(workspace.tenantId);

      const { data, error } = await invokeEdge("agents-dashboard", {
        body: {
          status: "all",
          search: "",
        },
      });

      if (error) throw error;
      const payload = (data ?? null) as AgentsDashboardResponse | null;
      if (!payload?.ok) throw new Error(payload?.error ?? "Could not load agents dashboard.");

      const nextAgents = payload.agents ?? [];
      const nextSummary = payload.summary ?? {
        active: nextAgents.filter((agent) => agent.status_bucket === "active").length,
        inactive: nextAgents.filter((agent) => agent.status_bucket === "inactive").length,
        training: nextAgents.filter((agent) => agent.status_bucket === "training").length,
      };

      setAgents(nextAgents);
      setSummary(nextSummary);
    } catch (error) {
      const parsed = await formatEdgeFunctionError(error, { functionName: "agents-dashboard" });
      toast({
        title: "Could not load agents",
        description: parsed || normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast, user]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    if (!tenantId) return;

    const channel = supabase
      .channel(`agents-dashboard-${tenantId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ai_agents", filter: `tenant_id=eq.${tenantId}` },
        () => void loadAgents(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_tool_runs", filter: `tenant_id=eq.${tenantId}` },
        () => void loadAgents(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "custom_agent_specs", filter: `tenant_id=eq.${tenantId}` },
        () => void loadAgents(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [loadAgents, tenantId]);

  const invokeStudio = useCallback(async (body: Record<string, unknown>) => {
    const { data, error } = await invokeEdge("agent-studio", { body });
    if (error) throw error;

    const payload = (data ?? null) as AgentStudioInvokeResponse | null;
    if (payload && payload.ok === false) {
      throw new Error(payload.error || "Agent studio request failed.");
    }

    return payload;
  }, []);

  const loadStudioPayload = useCallback(
    async (agentId?: string | null) => {
      setStudioLoading(true);
      try {
        const response = await invokeStudio({ operation: "get_payload", agentId: agentId ?? null });
        setStudioPayload(normalizeStudioPayload(response?.payload));
      } catch (error) {
        toast({
          title: "Could not load agent studio",
          description: normalizeError(error),
          variant: "destructive",
        });
      } finally {
        setStudioLoading(false);
      }
    },
    [invokeStudio, toast],
  );

  const openCreateStudio = () => {
    setStudioMode("create");
    setStudioForm(createDefaultForm());
    setStudioOpen(true);
    void loadStudioPayload(null);
  };

  const openConfigureStudio = (agent: AgentCardRow) => {
    setStudioMode("configure");
    setStudioForm((prev) => ({ ...prev, agentId: agent.id }));
    setStudioOpen(true);

    void (async () => {
      setStudioLoading(true);
      try {
        const response = await invokeStudio({ operation: "get_payload", agentId: agent.id });
        const normalized = normalizeStudioPayload(response?.payload);
        setStudioPayload(normalized);
        if (normalized.selectedAgent) {
          setStudioForm(formFromSelected(normalized.selectedAgent));
        }
      } catch (error) {
        toast({
          title: "Could not load agent studio",
          description: normalizeError(error),
          variant: "destructive",
        });
      } finally {
        setStudioLoading(false);
      }
    })();
  };

  const applyTemplate = (template: StudioTemplate) => {
    setStudioForm((prev) => ({
      ...prev,
      name: template.name,
      domain: DOMAIN_OPTIONS.includes(template.domain as (typeof DOMAIN_OPTIONS)[number])
        ? (template.domain as (typeof DOMAIN_OPTIONS)[number])
        : prev.domain,
      avatarEmoji: template.icon,
      description: template.description,
      capabilitiesText: template.capabilities.join(", "),
    }));
  };

  const handleGenerateFromPrompt = async () => {
    const prompt = studioForm.prompt.trim();
    if (!prompt) {
      toast({
        title: "Prompt required",
        description: "Describe what you want the agent to do.",
        variant: "destructive",
      });
      return;
    }

    setPromptGenerating(true);
    try {
      const response = await invokeStudio({ operation: "suggest_from_prompt", prompt });
      const blueprint = (response?.blueprint ?? null) as Record<string, unknown> | null;
      if (!blueprint) throw new Error("No blueprint generated");

      const domainCandidate = toString(blueprint.domain, studioForm.domain);
      const mappedDomain = DOMAIN_OPTIONS.includes(domainCandidate as (typeof DOMAIN_OPTIONS)[number])
        ? (domainCandidate as (typeof DOMAIN_OPTIONS)[number])
        : studioForm.domain;
      const vectorCandidate = toString(blueprint.vectorStrategy, studioForm.vectorStrategy);
      const mappedVector = VECTOR_OPTIONS.includes(vectorCandidate as (typeof VECTOR_OPTIONS)[number])
        ? (vectorCandidate as (typeof VECTOR_OPTIONS)[number])
        : studioForm.vectorStrategy;
      const syncCandidate = toString(blueprint.syncFrequency, studioForm.syncFrequency);
      const mappedSync = SYNC_OPTIONS.includes(syncCandidate as (typeof SYNC_OPTIONS)[number])
        ? (syncCandidate as (typeof SYNC_OPTIONS)[number])
        : studioForm.syncFrequency;

      setStudioForm((prev) => ({
        ...prev,
        name: toString(blueprint.name, prev.name),
        domain: mappedDomain,
        avatarEmoji: toString(blueprint.icon, prev.avatarEmoji),
        description: toString(blueprint.description, prev.description),
        capabilitiesText: toStringArray(blueprint.capabilities).join(", ") || prev.capabilitiesText,
        connectionIds: toStringArray(blueprint.recommendedConnectionIds),
        vectorStrategy: mappedVector,
        syncFrequency: mappedSync,
      }));

      const questions = toStringArray(blueprint.questions);
      toast({
        title: "Blueprint generated",
        description:
          questions.length > 0
            ? `Next: ${questions[0]}`
            : "Agent plan generated from your prompt and connected systems.",
      });
    } catch (error) {
      toast({
        title: "Could not generate blueprint",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setPromptGenerating(false);
    }
  };

  const handleSaveStudio = async () => {
    const name = studioForm.name.trim();
    if (!name) {
      toast({
        title: "Agent name required",
        description: "Enter a name before saving.",
        variant: "destructive",
      });
      return;
    }

    const capabilities = studioForm.capabilitiesText
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    setStudioSaving(true);
    try {
      const response = await invokeStudio({
        operation: "save_agent",
        agentId: studioForm.agentId,
        name,
        description: studioForm.description.trim() || null,
        domain: studioForm.domain,
        prompt: studioForm.prompt.trim() || null,
        objective: studioForm.objective.trim() || null,
        systemPrompt: studioForm.systemPrompt.trim() || null,
        avatarEmoji: studioForm.avatarEmoji,
        capabilities,
        sourceConnectionIds: studioForm.connectionIds,
        syncFrequency: studioForm.syncFrequency,
        vectorStrategy: studioForm.vectorStrategy,
        ragEnabled: studioForm.ragEnabled,
        autoSync: studioForm.autoSync,
        autoDeploy: studioForm.autoDeploy,
        deployNow: studioForm.deployNow,
        raciScope: studioForm.raciScope.trim() || null,
      });

      const result = (response?.result ?? null) as Record<string, unknown> | null;
      const syncJobs = Number(result?.syncJobsQueued ?? 0);
      const embeddingJobs = Number(result?.embeddingJobsQueued ?? 0);

      toast({
        title: studioMode === "create" ? "Custom agent created" : "Agent configuration updated",
        description:
          syncJobs > 0 || embeddingJobs > 0
            ? `Deployment queued (${syncJobs} sync jobs, ${embeddingJobs} embedding jobs).`
            : "Agent is ready and active.",
      });

      setStudioOpen(false);
      await loadAgents();
    } catch (error) {
      toast({
        title: "Could not save custom agent",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setStudioSaving(false);
    }
  };

  const handleStudioSync = async () => {
    if (!studioForm.agentId) return;

    setStudioSaving(true);
    try {
      const response = await invokeStudio({
        operation: "sync_agent",
        agentId: studioForm.agentId,
      });
      const result = (response?.result ?? null) as Record<string, unknown> | null;
      const syncJobs = Number(result?.syncJobsQueued ?? 0);

      toast({
        title: "Sync queued",
        description: `${syncJobs} connector sync job${syncJobs === 1 ? "" : "s"} queued.`,
      });
      await loadAgents();
    } catch (error) {
      toast({
        title: "Could not sync agent",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setStudioSaving(false);
    }
  };

  const handleDeleteCustomAgent = async (agent: AgentCardRow) => {
    if (!agent.is_custom) return;

    const confirmed = window.confirm(`Delete custom agent ${agent.name}? This cannot be undone.`);
    if (!confirmed) return;

    setToggleLoadingById((prev) => ({ ...prev, [agent.id]: true }));
    try {
      await invokeStudio({ operation: "delete_agent", agentId: agent.id });
      toast({ title: "Custom agent deleted" });
      await loadAgents();
    } catch (error) {
      toast({
        title: "Could not delete custom agent",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setToggleLoadingById((prev) => ({ ...prev, [agent.id]: false }));
    }
  };

  const handleSetEnabled = async (agent: AgentCardRow, enabled: boolean) => {
    if (!enabled && agent.status_bucket === "active") {
      const confirmed = window.confirm(
        `Disable ${agent.name}? This agent is currently active and will stop handling requests.`,
      );
      if (!confirmed) return;
    }

    setToggleLoadingById((prev) => ({ ...prev, [agent.id]: true }));
    try {
      const { data, error } = await invokeEdge("agent-set-enabled", {
        body: {
          agentId: agent.id,
          enabled,
        },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Agent update failed.");

      toast({
        title: enabled ? "Agent enabled" : "Agent disabled",
        description: `${agent.name} is now ${enabled ? "enabled" : "disabled"}.`,
      });
      await loadAgents();
    } catch (error) {
      toast({
        title: "Could not update agent",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setToggleLoadingById((prev) => ({ ...prev, [agent.id]: false }));
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">AI Agents</h1>
          <p className="mt-1 text-sm text-slate-500">
            {summary.active} Active / {summary.inactive} Inactive / {summary.training} Training
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => {
              const target = sortedAgents[0];
              if (!target) {
                toast({
                  title: "No agents available",
                  description: "Create or connect a source first.",
                });
                return;
              }
              openConfigureStudio(target);
            }}
          >
            <Settings2 className="h-4 w-4" />
            Configure Agent
          </Button>
          <Button
            onClick={openCreateStudio}
            className="border-0 bg-gradient-to-r from-violet-600 to-purple-600 text-white hover:from-violet-500 hover:to-purple-500"
          >
            <PlusCircle className="h-4 w-4" />
            Create Custom Agent
          </Button>
        </div>
      </header>

      <div className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-violet-700" />
          <p>
            Agents can now be generated from prompts, configured with RAG/vector strategy, connected to your real
            data sources, and auto-synced through connector jobs.
          </p>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-3">
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-slate-500">Active</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-600">{summary.active}</p>
        </article>
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-slate-500">Inactive</p>
          <p className="mt-1 text-2xl font-semibold text-slate-700">{summary.inactive}</p>
        </article>
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-slate-500">Training</p>
          <p className="mt-1 text-2xl font-semibold text-blue-600">{summary.training}</p>
        </article>
      </section>

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading agents...
          </span>
        </div>
      ) : sortedAgents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center shadow-sm">
          <p className="text-base font-semibold text-slate-900">Connect a data source to auto-generate agents</p>
          <p className="mt-1 text-sm text-slate-500">
            You can also create custom agents directly from prompt-driven configuration.
          </p>
        </div>
      ) : (
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sortedAgents.map((agent) => {
            const isEnabled = agent.status_bucket !== "inactive";
            const capabilities = (agent.capabilities ?? []).slice(0, 3);
            const toggleBusy = Boolean(toggleLoadingById[agent.id]);
            const emoji = agent.avatar_emoji || domainFallbackEmoji(agent.domain);

            return (
              <article key={agent.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span
                      className={cn(
                        "inline-flex h-11 w-11 items-center justify-center rounded-full text-xl",
                        avatarBackground(agent.domain),
                      )}
                    >
                      {emoji}
                    </span>
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-semibold text-slate-900">{agent.name}</h2>
                      <p className="truncate text-xs text-slate-500">{agent.description || `${agent.domain} specialist`}</p>
                    </div>
                  </div>
                  <Badge className={badgeClass(agent.status_bucket)}>
                    <span className={cn("mr-1.5 inline-block h-2 w-2 rounded-full", dotClass(agent.status_bucket))} />
                    {statusLabel(agent.status_bucket)}
                  </Badge>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Badge className="border-0 bg-slate-100 text-slate-700">
                    Source: {agent.source_connection_name || "Auto-discovered"}
                  </Badge>
                  {agent.is_custom ? <Badge className="border-0 bg-violet-100 text-violet-700">Custom</Badge> : null}
                </div>

                <div className="mt-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Capabilities</p>
                  <ul className="mt-2 space-y-1">
                    {capabilities.map((capability) => (
                      <li key={`${agent.id}-${capability}`} className="text-sm text-slate-700">
                        • {capability}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <span className="font-semibold text-slate-700">RACI scope:</span>{" "}
                  {agent.raci_scope || "Restricted by tenant RACI policy"}
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2 rounded-lg border border-slate-200 bg-white p-3 text-center">
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">Queries today</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{Number(agent.queries_today ?? 0)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">Success rate</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{formatPercent(agent.success_rate ?? 0)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">Avg response</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{formatLatency(agent.avg_response_ms)}</p>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={isEnabled}
                      disabled={toggleBusy}
                      onCheckedChange={(next) => void handleSetEnabled(agent, next)}
                      aria-label={`Toggle ${agent.name}`}
                    />
                    <span className="text-xs text-slate-600">{isEnabled ? "Enabled" : "Disabled"}</span>
                    {toggleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-600" /> : null}
                  </div>

                  <div className="flex items-center gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => openConfigureStudio(agent)}>
                      <Settings2 className="h-3.5 w-3.5" />
                      Configure
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => navigate(`/dashboard/agents/${agent.id}`)}>
                      View Details
                    </Button>
                  </div>
                </div>

                {agent.is_custom ? (
                  <div className="mt-2 flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                      onClick={() => void handleDeleteCustomAgent(agent)}
                      disabled={toggleBusy}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </Button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </section>
      )}

      <Dialog open={studioOpen} onOpenChange={setStudioOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{studioMode === "create" ? "Create Custom Agent" : "Configure Agent"}</DialogTitle>
            <DialogDescription>
              Build production-ready agents with governed actions, RAG strategy, and auto-sync against your SaaS data.
            </DialogDescription>
          </DialogHeader>

          {studioLoading ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
              <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-violet-600" />
              Loading agent studio...
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border border-violet-200 bg-violet-50 p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-violet-700">Generate From Prompt</p>
                <Textarea
                  value={studioForm.prompt}
                  onChange={(event) =>
                    setStudioForm((prev) => ({
                      ...prev,
                      prompt: event.target.value,
                    }))
                  }
                  rows={3}
                  placeholder="Example: Create an operations agent that monitors sync failures, suggests remediation, and can trigger governed retries."
                />
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-2">
                    {studioPayload.templates.map((template) => (
                      <button
                        key={template.key}
                        type="button"
                        onClick={() => applyTemplate(template)}
                        className="inline-flex items-center gap-1 rounded-md border border-violet-200 bg-white px-2 py-1 text-xs text-violet-700 hover:bg-violet-100"
                      >
                        <span>{template.icon}</span>
                        <span>{template.name}</span>
                      </button>
                    ))}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void handleGenerateFromPrompt()}
                    disabled={promptGenerating || studioSaving}
                  >
                    {promptGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                    Generate Blueprint
                  </Button>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-600">Agent Name</p>
                  <Input
                    value={studioForm.name}
                    onChange={(event) => setStudioForm((prev) => ({ ...prev, name: event.target.value }))}
                    placeholder="Ops Copilot"
                  />
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-600">Domain</p>
                  <select
                    value={studioForm.domain}
                    onChange={(event) =>
                      setStudioForm((prev) => ({
                        ...prev,
                        domain: event.target.value as StudioForm["domain"],
                      }))
                    }
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {DOMAIN_OPTIONS.map((domain) => (
                      <option key={domain} value={domain}>
                        {domain}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <p className="mb-1 text-xs font-medium text-slate-600">Description</p>
                <Textarea
                  value={studioForm.description}
                  onChange={(event) => setStudioForm((prev) => ({ ...prev, description: event.target.value }))}
                  rows={2}
                  placeholder="What this agent does and where it should be used."
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-600">Objective</p>
                  <Textarea
                    value={studioForm.objective}
                    onChange={(event) => setStudioForm((prev) => ({ ...prev, objective: event.target.value }))}
                    rows={2}
                    placeholder="Primary objective for this agent"
                  />
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-600">System Prompt</p>
                  <Textarea
                    value={studioForm.systemPrompt}
                    onChange={(event) => setStudioForm((prev) => ({ ...prev, systemPrompt: event.target.value }))}
                    rows={2}
                    placeholder="Core operating instruction"
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-600">Icon</p>
                  <div className="flex flex-wrap gap-2">
                    {EMOJI_OPTIONS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => setStudioForm((prev) => ({ ...prev, avatarEmoji: emoji }))}
                        className={cn(
                          "inline-flex h-9 w-9 items-center justify-center rounded-md border text-lg",
                          studioForm.avatarEmoji === emoji
                            ? "border-violet-500 bg-violet-100"
                            : "border-slate-200 hover:bg-slate-50",
                        )}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-600">Vector Strategy</p>
                  <select
                    value={studioForm.vectorStrategy}
                    onChange={(event) =>
                      setStudioForm((prev) => ({
                        ...prev,
                        vectorStrategy: event.target.value as StudioForm["vectorStrategy"],
                      }))
                    }
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {VECTOR_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-600">Sync Frequency</p>
                  <select
                    value={studioForm.syncFrequency}
                    onChange={(event) =>
                      setStudioForm((prev) => ({
                        ...prev,
                        syncFrequency: event.target.value as StudioForm["syncFrequency"],
                      }))
                    }
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {SYNC_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <p className="mb-1 text-xs font-medium text-slate-600">Capabilities (comma separated)</p>
                <Textarea
                  value={studioForm.capabilitiesText}
                  onChange={(event) => setStudioForm((prev) => ({ ...prev, capabilitiesText: event.target.value }))}
                  rows={2}
                  placeholder="workflow orchestration, anomaly detection, governed action planning"
                />
              </div>

              <div>
                <p className="mb-2 text-xs font-medium text-slate-600">Connected Data Sources</p>
                {studioPayload.connections.length === 0 ? (
                  <p className="rounded-md border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-500">
                    No data connections found. Add one in Connections to enable live sync.
                  </p>
                ) : (
                  <div className="grid gap-2 md:grid-cols-2">
                    {studioPayload.connections.map((connection) => {
                      const selected = studioForm.connectionIds.includes(connection.id);
                      return (
                        <button
                          key={connection.id}
                          type="button"
                          onClick={() =>
                            setStudioForm((prev) => ({
                              ...prev,
                              connectionIds: selected
                                ? prev.connectionIds.filter((id) => id !== connection.id)
                                : [...prev.connectionIds, connection.id],
                            }))
                          }
                          className={cn(
                            "rounded-md border px-3 py-2 text-left text-xs",
                            selected
                              ? "border-violet-400 bg-violet-50"
                              : "border-slate-200 hover:bg-slate-50",
                          )}
                        >
                          <p className="font-medium text-slate-800">{connection.name}</p>
                          <p className="mt-0.5 text-slate-500">
                            {connection.type} · {connection.status}
                            {connection.schemaDetected ? " · schema ready" : ""}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <p className="mb-1 text-xs font-medium text-slate-600">RACI Scope</p>
                <Input
                  value={studioForm.raciScope}
                  onChange={(event) => setStudioForm((prev) => ({ ...prev, raciScope: event.target.value }))}
                  placeholder="Restricted to Operations Manager role"
                />
              </div>

              <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
                <label className="flex items-center justify-between text-xs text-slate-700">
                  <span>RAG enabled</span>
                  <Switch
                    checked={studioForm.ragEnabled}
                    onCheckedChange={(checked) => setStudioForm((prev) => ({ ...prev, ragEnabled: checked }))}
                  />
                </label>
                <label className="flex items-center justify-between text-xs text-slate-700">
                  <span>Auto sync connectors</span>
                  <Switch
                    checked={studioForm.autoSync}
                    onCheckedChange={(checked) => setStudioForm((prev) => ({ ...prev, autoSync: checked }))}
                  />
                </label>
                <label className="flex items-center justify-between text-xs text-slate-700">
                  <span>Auto deploy on save</span>
                  <Switch
                    checked={studioForm.autoDeploy}
                    onCheckedChange={(checked) => setStudioForm((prev) => ({ ...prev, autoDeploy: checked }))}
                  />
                </label>
                <label className="flex items-center justify-between text-xs text-slate-700">
                  <span>Deploy now</span>
                  <Switch
                    checked={studioForm.deployNow}
                    onCheckedChange={(checked) => setStudioForm((prev) => ({ ...prev, deployNow: checked }))}
                  />
                </label>
              </div>
            </div>
          )}

          <DialogFooter className="flex-wrap gap-2">
            {studioMode === "configure" && studioForm.agentId ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleStudioSync()}
                disabled={studioSaving || studioLoading}
              >
                <RefreshCw className="h-4 w-4" />
                Sync Now
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => setStudioOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-violet-600 hover:bg-violet-700"
              onClick={() => void handleSaveStudio()}
              disabled={studioSaving || studioLoading}
            >
              {studioSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
              {studioMode === "create" ? "Create & Deploy Agent" : "Save Configuration"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
