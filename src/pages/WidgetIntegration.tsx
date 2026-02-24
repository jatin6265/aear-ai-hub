import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Code2, Copy, ExternalLink, Loader2, Lock, Palette, Settings2 } from "lucide-react";
import { NavLink } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { WidgetPreviewMock, type WidgetBubbleSize, type WidgetPosition } from "@/components/widget/WidgetPreviewMock";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdge } from "@/lib/edge-invoke";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { cn } from "@/lib/utils";

type AccessMode = "public" | "authenticated" | "jwt";
type CodeTab = "script" | "react" | "iframe";

type WidgetAgent = {
  id: string;
  name: string;
  domain: string;
  status: string;
};

type WidgetPayload = {
  tenantId: string;
  tenantName: string;
  widget: {
    id: string;
    name: string;
    slug: string;
    status: string;
    appearance: {
      position: WidgetPosition;
      primaryColor: string;
      buttonSize: WidgetBubbleSize;
    };
    behavior: {
      initialMessage: string;
      accessMode: AccessMode;
      enabledAgentIds: string[];
      features: {
        chat: boolean;
        executeActions: boolean;
        viewReports: boolean;
        requestApprovals: boolean;
      };
    };
    allowedOrigins: string[];
    jwtSecretConfigured: boolean;
    updatedAt: string | null;
  };
  agents: WidgetAgent[];
  jwtInstructions: string[];
};

type WidgetForm = {
  name: string;
  position: WidgetPosition;
  primaryColor: string;
  buttonSize: WidgetBubbleSize;
  initialMessage: string;
  accessMode: AccessMode;
  allowedOriginsText: string;
  enabledAgentIds: string[];
  features: {
    executeActions: boolean;
    viewReports: boolean;
    requestApprovals: boolean;
  };
};

const SETTINGS_SUB_NAV = [
  { label: "General", to: "/dashboard/settings", end: true },
  { label: "Notifications", to: "/dashboard/settings/notifications" },
  { label: "Widget", to: "/dashboard/settings/widget" },
] as const;

const POSITION_OPTIONS: Array<{ value: WidgetPosition; label: string }> = [
  { value: "top-left", label: "Top Left" },
  { value: "top-right", label: "Top Right" },
  { value: "bottom-left", label: "Bottom Left" },
  { value: "bottom-right", label: "Bottom Right" },
];

const SIZE_OPTIONS: Array<{ value: WidgetBubbleSize; label: string }> = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

const ACCESS_MODE_OPTIONS: Array<{ value: AccessMode; label: string; description: string }> = [
  { value: "public", label: "Public", description: "Anyone can use the widget." },
  {
    value: "authenticated",
    label: "Authenticated",
    description: "Only logged-in users in your app can access the widget.",
  },
  {
    value: "jwt",
    label: "Embed with JWT",
    description: "Sign short-lived tokens server-side and pass them to the widget.",
  },
];

const DEFAULT_PAYLOAD: WidgetPayload = {
  tenantId: "",
  tenantName: "AEAR Workspace",
  widget: {
    id: "",
    name: "AEAR Assistant Widget",
    slug: "assistant",
    status: "active",
    appearance: {
      position: "bottom-right",
      primaryColor: "#7c3aed",
      buttonSize: "medium",
    },
    behavior: {
      initialMessage: "How can I help you today?",
      accessMode: "public",
      enabledAgentIds: [],
      features: {
        chat: true,
        executeActions: false,
        viewReports: false,
        requestApprovals: false,
      },
    },
    allowedOrigins: [],
    jwtSecretConfigured: false,
    updatedAt: null,
  },
  agents: [],
  jwtInstructions: [],
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizePosition(value: unknown): WidgetPosition {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "top-left" || normalized === "top-right" || normalized === "bottom-left") return normalized;
  return "bottom-right";
}

function normalizeSize(value: unknown): WidgetBubbleSize {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "small" || normalized === "large") return normalized;
  return "medium";
}

function normalizeMode(value: unknown): AccessMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "authenticated" || normalized === "jwt") return normalized;
  return "public";
}

function normalizeColor(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized : "#7c3aed";
}

function normalizePayload(rawValue: unknown): WidgetPayload {
  const raw = asRecord(rawValue);
  if (!raw) return DEFAULT_PAYLOAD;

  const widget = asRecord(raw.widget);
  const appearance = asRecord(widget?.appearance);
  const behavior = asRecord(widget?.behavior);
  const features = asRecord(behavior?.features);

  const allowedOrigins = Array.isArray(widget?.allowedOrigins)
    ? widget.allowedOrigins.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];

  const enabledAgentIds = Array.isArray(behavior?.enabledAgentIds)
    ? behavior.enabledAgentIds.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];

  const agents = Array.isArray(raw.agents)
    ? raw.agents
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const id = String(row.id ?? "").trim();
          const name = String(row.name ?? "").trim();
          if (!id || !name) return null;
          return {
            id,
            name,
            domain: String(row.domain ?? "general"),
            status: String(row.status ?? "active"),
          } satisfies WidgetAgent;
        })
        .filter((row): row is WidgetAgent => Boolean(row))
    : [];

  const jwtInstructions = Array.isArray(raw.jwtInstructions)
    ? raw.jwtInstructions.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];

  return {
    tenantId: String(raw.tenantId ?? "").trim(),
    tenantName: String(raw.tenantName ?? "AEAR Workspace").trim() || "AEAR Workspace",
    widget: {
      id: String(widget?.id ?? ""),
      name: String(widget?.name ?? "AEAR Assistant Widget").trim() || "AEAR Assistant Widget",
      slug: String(widget?.slug ?? "assistant").trim() || "assistant",
      status: String(widget?.status ?? "active").trim() || "active",
      appearance: {
        position: normalizePosition(appearance?.position),
        primaryColor: normalizeColor(appearance?.primaryColor),
        buttonSize: normalizeSize(appearance?.buttonSize),
      },
      behavior: {
        initialMessage:
          String(behavior?.initialMessage ?? "How can I help you today?").trim() || "How can I help you today?",
        accessMode: normalizeMode(behavior?.accessMode),
        enabledAgentIds,
        features: {
          chat: features?.chat !== false,
          executeActions: features?.executeActions === true,
          viewReports: features?.viewReports === true,
          requestApprovals: features?.requestApprovals === true,
        },
      },
      allowedOrigins,
      jwtSecretConfigured: widget?.jwtSecretConfigured === true,
      updatedAt: widget?.updatedAt ? String(widget.updatedAt) : null,
    },
    agents,
    jwtInstructions,
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

function parseAllowedOrigins(input: string) {
  return input
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatIso(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

export default function WidgetIntegration() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeSnippet, setActiveSnippet] = useState<CodeTab>("script");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [payload, setPayload] = useState<WidgetPayload>(DEFAULT_PAYLOAD);
  const [form, setForm] = useState<WidgetForm>({
    name: DEFAULT_PAYLOAD.widget.name,
    position: DEFAULT_PAYLOAD.widget.appearance.position,
    primaryColor: DEFAULT_PAYLOAD.widget.appearance.primaryColor,
    buttonSize: DEFAULT_PAYLOAD.widget.appearance.buttonSize,
    initialMessage: DEFAULT_PAYLOAD.widget.behavior.initialMessage,
    accessMode: DEFAULT_PAYLOAD.widget.behavior.accessMode,
    allowedOriginsText: "",
    enabledAgentIds: [],
    features: {
      executeActions: false,
      viewReports: false,
      requestApprovals: false,
    },
  });

  const applyPayload = useCallback((nextPayload: WidgetPayload) => {
    setPayload(nextPayload);
    setForm({
      name: nextPayload.widget.name,
      position: nextPayload.widget.appearance.position,
      primaryColor: nextPayload.widget.appearance.primaryColor,
      buttonSize: nextPayload.widget.appearance.buttonSize,
      initialMessage: nextPayload.widget.behavior.initialMessage,
      accessMode: nextPayload.widget.behavior.accessMode,
      allowedOriginsText: nextPayload.widget.allowedOrigins.join("\n"),
      enabledAgentIds: nextPayload.widget.behavior.enabledAgentIds,
      features: {
        executeActions: nextPayload.widget.behavior.features.executeActions,
        viewReports: nextPayload.widget.behavior.features.viewReports,
        requestApprovals: nextPayload.widget.behavior.features.requestApprovals,
      },
    });
  }, []);

  const loadPayload = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    try {
      await ensureUserWorkspace(user);
      const { data, error } = await invokeEdge("widget-integration", {
        body: { operation: "get_payload" },
      });
      if (error) throw error;
      const response = asRecord(data);
      const normalized = normalizePayload(response?.payload);
      applyPayload(normalized);
    } catch (error) {
      toast({
        title: "Could not load widget integration",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [applyPayload, toast, user]);

  useEffect(() => {
    void loadPayload();
  }, [loadPayload]);

  const selectedAgentNames = useMemo(() => {
    if (form.enabledAgentIds.length === 0) return [] as string[];
    const names = payload.agents
      .filter((agent) => form.enabledAgentIds.includes(agent.id))
      .map((agent) => agent.name);
    return names;
  }, [form.enabledAgentIds, payload.agents]);

  const previewConfig = useMemo(
    () => ({
      position: form.position,
      primaryColor: form.primaryColor,
      buttonSize: form.buttonSize,
      initialMessage: form.initialMessage,
      tenantName: payload.tenantName,
      enabledAgentNames: selectedAgentNames,
      accessMode: form.accessMode,
      features: {
        chat: true,
        executeActions: form.features.executeActions,
        viewReports: form.features.viewReports,
        requestApprovals: form.features.requestApprovals,
      },
    }),
    [form.accessMode, form.buttonSize, form.features.executeActions, form.features.requestApprovals, form.features.viewReports, form.initialMessage, form.position, form.primaryColor, payload.tenantName, selectedAgentNames],
  );

  const embedInitConfig = useMemo(() => {
    const base = {
      tenant_id: payload.tenantId || "tenant_id",
      widget_slug: payload.widget.slug || "assistant",
      mode: form.accessMode,
      token: form.accessMode === "jwt" ? "<SIGNED_SHORT_LIVED_JWT>" : undefined,
      theme: {
        position: form.position,
        primary_color: form.primaryColor,
        button_size: form.buttonSize,
      },
      initial_message: form.initialMessage,
      enabled_agent_ids: form.enabledAgentIds,
      features: {
        chat: true,
        execute_actions: form.features.executeActions,
        view_reports: form.features.viewReports,
        request_approvals: form.features.requestApprovals,
      },
    };

    return Object.fromEntries(Object.entries(base).filter((entry) => entry[1] !== undefined));
  }, [form.accessMode, form.buttonSize, form.enabledAgentIds, form.features.executeActions, form.features.requestApprovals, form.features.viewReports, form.initialMessage, form.position, form.primaryColor, payload.tenantId, payload.widget.slug]);

  const scriptSnippet = useMemo(
    () =>
      `<script src="https://cdn.aear.io/widget.js"></script>\n<script>\n  window.AEAR.init(${JSON.stringify(embedInitConfig, null, 2)});\n</script>`,
    [embedInitConfig],
  );

  const reactSnippet = useMemo(
    () =>
      `import { useEffect } from "react";\n\nexport function AearWidgetEmbed() {\n  useEffect(() => {\n    const script = document.createElement("script");\n    script.src = "https://cdn.aear.io/widget.js";\n    script.async = true;\n    script.onload = () => window.AEAR?.init(${JSON.stringify(embedInitConfig, null, 4)});\n    document.body.appendChild(script);\n\n    return () => {\n      document.body.removeChild(script);\n    };\n  }, []);\n\n  return null;\n}`,
    [embedInitConfig],
  );

  const iframeSnippet = useMemo(() => {
    const tenant = payload.tenantId || "tenant_id";
    const slug = payload.widget.slug || "assistant";
    return `<iframe src="https://app.aear.io/embed/${tenant}/${slug}?mode=${form.accessMode}" title="AEAR Assistant" width="380" height="640" style="border:0;border-radius:16px;"></iframe>`;
  }, [form.accessMode, payload.tenantId, payload.widget.slug]);

  const activeSnippetText = activeSnippet === "react" ? reactSnippet : activeSnippet === "iframe" ? iframeSnippet : scriptSnippet;

  const handleCopy = useCallback(
    async (value: string, successTitle: string) => {
      try {
        await navigator.clipboard.writeText(value);
        toast({ title: successTitle });
      } catch {
        toast({
          title: "Copy failed",
          description: "Clipboard access is not available in this browser.",
          variant: "destructive",
        });
      }
    },
    [toast],
  );

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);

    try {
      const { data, error } = await invokeEdge("widget-integration", {
        body: {
          operation: "save_config",
          config: {
            name: form.name,
            position: form.position,
            primaryColor: form.primaryColor,
            buttonSize: form.buttonSize,
            initialMessage: form.initialMessage,
            accessMode: form.accessMode,
            allowedOrigins: parseAllowedOrigins(form.allowedOriginsText),
            enabledAgentIds: form.enabledAgentIds,
            features: {
              executeActions: form.features.executeActions,
              viewReports: form.features.viewReports,
              requestApprovals: form.features.requestApprovals,
            },
          },
        },
      });

      if (error) throw error;
      const response = asRecord(data);
      const normalized = normalizePayload(asRecord(response)?.payload);
      applyPayload(normalized);
      toast({ title: "Widget configuration saved" });
    } catch (error) {
      toast({
        title: "Could not save widget config",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const toggleAgent = (agentId: string, enabled: boolean) => {
    setForm((current) => {
      const nextEnabled = enabled
        ? Array.from(new Set([...current.enabledAgentIds, agentId]))
        : current.enabledAgentIds.filter((id) => id !== agentId);
      return { ...current, enabledAgentIds: nextEnabled };
    });
  };

  const updateFeature = (feature: keyof WidgetForm["features"], enabled: boolean) => {
    setForm((current) => ({
      ...current,
      features: {
        ...current.features,
        [feature]: enabled,
      },
    }));
  };

  const openTestWidget = () => {
    const testConfig = {
      ...previewConfig,
      tenantId: payload.tenantId,
      widgetSlug: payload.widget.slug,
      allowedOrigins: parseAllowedOrigins(form.allowedOriginsText),
      jwtSecretConfigured: payload.widget.jwtSecretConfigured,
    };

    const encoded = encodeURIComponent(JSON.stringify(testConfig));
    window.open(`/dashboard/settings/widget/test?config=${encoded}`, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <nav className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
        <div className="flex flex-wrap gap-1">
          {SETTINGS_SUB_NAV.map((item) => (
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

      <header className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Embed AEAR in Your Website or App</h1>
        <p className="text-sm text-muted-foreground">Add the AEAR AI assistant to any website with a single script tag.</p>
      </header>

      {loading ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_440px]">
          <Skeleton className="h-[560px] w-full rounded-2xl" />
          <Skeleton className="h-[560px] w-full rounded-2xl" />
        </div>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_440px]">
          <section className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Widget Preview</h2>
                  <p className="text-xs text-slate-500">Click the bubble to expand the chat widget interface.</p>
                </div>
                <Badge variant="secondary" className="bg-slate-100 text-slate-700">
                  Live Preview
                </Badge>
              </div>

              <WidgetPreviewMock config={previewConfig} open={previewOpen} onToggle={() => setPreviewOpen((current) => !current)} />
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Code2 className="h-4 w-4 text-violet-600" />
                  <h2 className="text-base font-semibold text-slate-900">Code Snippet</h2>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => void handleCopy(activeSnippetText, "Snippet copied")}> 
                    <Copy className="h-4 w-4" />
                    Copy
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void handleCopy(
                        `Script:\n${scriptSnippet}\n\nReact:\n${reactSnippet}\n\niframe:\n${iframeSnippet}`,
                        "All snippets copied",
                      )
                    }
                  >
                    Copy all
                  </Button>
                </div>
              </div>

              <Tabs value={activeSnippet} onValueChange={(value) => setActiveSnippet(value as CodeTab)}>
                <TabsList>
                  <TabsTrigger value="script">Script Tag</TabsTrigger>
                  <TabsTrigger value="react">React</TabsTrigger>
                  <TabsTrigger value="iframe">iframe</TabsTrigger>
                </TabsList>
              </Tabs>

              <pre className="mt-3 max-h-[320px] overflow-auto rounded-xl border border-slate-200 bg-slate-950 p-4 text-xs text-slate-100">
                <code>{activeSnippetText}</code>
              </pre>
            </div>
          </section>

          <section className="space-y-4">
            <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Configuration</h2>
                  <p className="text-xs text-slate-500">Configure visual style, access mode, and enabled features.</p>
                </div>
                <Badge className="bg-violet-100 text-violet-700">{payload.widget.status}</Badge>
              </div>

              <div className="space-y-2">
                <Label htmlFor="widget-name">Widget Name</Label>
                <Input
                  id="widget-name"
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="AEAR Assistant Widget"
                />
              </div>

              <div className="space-y-2">
                <Label>Position</Label>
                <div className="grid grid-cols-2 gap-2">
                  {POSITION_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setForm((current) => ({ ...current, position: option.value }))}
                      className={cn(
                        "rounded-lg border px-3 py-2 text-left text-sm transition",
                        form.position === option.value
                          ? "border-violet-400 bg-violet-50 text-violet-700"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="widget-color" className="flex items-center gap-2">
                    <Palette className="h-3.5 w-3.5 text-slate-500" />
                    Primary Color
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="widget-color"
                      type="color"
                      value={form.primaryColor}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, primaryColor: normalizeColor(event.target.value) }))
                      }
                      className="h-10 w-14 cursor-pointer p-1"
                    />
                    <Input
                      value={form.primaryColor}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, primaryColor: normalizeColor(event.target.value) }))
                      }
                      className="h-10"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Button Size</Label>
                  <Select
                    value={form.buttonSize}
                    onValueChange={(value) => setForm((current) => ({ ...current, buttonSize: normalizeSize(value) }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SIZE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="widget-message">Initial Message</Label>
                <Input
                  id="widget-message"
                  value={form.initialMessage}
                  onChange={(event) => setForm((current) => ({ ...current, initialMessage: event.target.value }))}
                  placeholder="How can I help you today?"
                />
              </div>
            </div>

            <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Agent Restriction</h3>
                <p className="text-xs text-slate-500">Choose which agents are available in the embedded widget.</p>
              </div>

              {payload.agents.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                  No active agents found. Complete data sync to auto-generate agents.
                </p>
              ) : (
                <div className="max-h-40 space-y-2 overflow-auto rounded-lg border border-slate-200 p-2">
                  {payload.agents.map((agent) => {
                    const enabled = form.enabledAgentIds.includes(agent.id);
                    return (
                      <label
                        key={agent.id}
                        className="flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-slate-50"
                      >
                        <span className="min-w-0 pr-3">
                          <span className="block truncate font-medium text-slate-800">{agent.name}</span>
                          <span className="block truncate text-xs text-slate-500">{agent.domain}</span>
                        </span>
                        <Switch checked={enabled} onCheckedChange={(checked) => toggleAgent(agent.id, checked)} />
                      </label>
                    );
                  })}
                </div>
              )}

              <p className="text-xs text-slate-500">
                {form.enabledAgentIds.length > 0
                  ? `${form.enabledAgentIds.length} agent(s) enabled`
                  : "No specific restriction set. All available agents can respond."}
              </p>
            </div>

            <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-slate-500" />
                <h3 className="text-sm font-semibold text-slate-900">Access Control</h3>
              </div>

              <div className="space-y-2">
                {ACCESS_MODE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setForm((current) => ({ ...current, accessMode: option.value }))}
                    className={cn(
                      "w-full rounded-lg border px-3 py-2 text-left transition",
                      form.accessMode === option.value
                        ? "border-violet-400 bg-violet-50"
                        : "border-slate-200 bg-white hover:border-slate-300",
                    )}
                  >
                    <p className="text-sm font-medium text-slate-900">{option.label}</p>
                    <p className="text-xs text-slate-500">{option.description}</p>
                  </button>
                ))}
              </div>

              <div className="space-y-2">
                <Label htmlFor="widget-origins">Allowed Origins (one per line)</Label>
                <Textarea
                  id="widget-origins"
                  value={form.allowedOriginsText}
                  onChange={(event) => setForm((current) => ({ ...current, allowedOriginsText: event.target.value }))}
                  rows={3}
                  placeholder="https://app.example.com"
                />
              </div>

              {form.accessMode === "jwt" ? (
                <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-xs text-violet-800">
                  <div className="mb-2 flex items-center gap-2 font-medium">
                    <Settings2 className="h-3.5 w-3.5" />
                    JWT embedding instructions
                    {payload.widget.jwtSecretConfigured ? (
                      <Badge className="bg-emerald-100 text-emerald-700">Configured</Badge>
                    ) : (
                      <Badge className="bg-amber-100 text-amber-700">Generated on save</Badge>
                    )}
                  </div>
                  <ul className="space-y-1 text-[11px] leading-relaxed">
                    {(payload.jwtInstructions.length > 0
                      ? payload.jwtInstructions
                      : [
                          "Generate a short-lived JWT in your backend.",
                          "Never expose your signing secret in client-side code.",
                          "Pass token in window.AEAR.init when mode is jwt.",
                        ]
                    ).map((line) => (
                      <li key={line} className="flex gap-2">
                        <Check className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-900">Allowed Features</h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">Chat</p>
                    <p className="text-xs text-slate-500">Always enabled for embedded widgets.</p>
                  </div>
                  <Switch checked disabled aria-label="Chat always enabled" />
                </div>

                <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">Execute actions</p>
                    <p className="text-xs text-slate-500">Allow governed action execution from widget.</p>
                  </div>
                  <Switch
                    checked={form.features.executeActions}
                    onCheckedChange={(checked) => updateFeature("executeActions", checked)}
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">View reports</p>
                    <p className="text-xs text-slate-500">Expose insight and report cards in conversation.</p>
                  </div>
                  <Switch checked={form.features.viewReports} onCheckedChange={(checked) => updateFeature("viewReports", checked)} />
                </div>

                <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">Request approvals</p>
                    <p className="text-xs text-slate-500">Let users initiate approval requests from widget actions.</p>
                  </div>
                  <Switch
                    checked={form.features.requestApprovals}
                    onCheckedChange={(checked) => updateFeature("requestApprovals", checked)}
                  />
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                Last updated: {formatIso(payload.widget.updatedAt)}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => void handleSave()} disabled={saving} className="bg-violet-600 text-white hover:bg-violet-700">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Save Changes
                </Button>
                <Button variant="outline" onClick={openTestWidget}>
                  <ExternalLink className="h-4 w-4" />
                  Test Widget
                </Button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
