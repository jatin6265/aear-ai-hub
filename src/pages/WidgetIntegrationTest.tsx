import { useMemo, useState } from "react";
import { ArrowLeft, Beaker, Shield } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WidgetPreviewMock, type WidgetBubbleSize, type WidgetPosition } from "@/components/widget/WidgetPreviewMock";
import { cn } from "@/lib/utils";

type AccessMode = "public" | "authenticated" | "jwt";

type TestConfig = {
  position: WidgetPosition;
  primaryColor: string;
  buttonSize: WidgetBubbleSize;
  initialMessage: string;
  tenantName: string;
  enabledAgentNames: string[];
  accessMode: AccessMode;
  features: {
    chat: boolean;
    executeActions: boolean;
    viewReports: boolean;
    requestApprovals: boolean;
  };
  tenantId?: string;
  widgetSlug?: string;
  allowedOrigins?: string[];
  jwtSecretConfigured?: boolean;
};

const DEFAULT_CONFIG: TestConfig = {
  position: "bottom-right",
  primaryColor: "#7c3aed",
  buttonSize: "medium",
  initialMessage: "How can I help you today?",
  tenantName: "AEAR Workspace",
  enabledAgentNames: [],
  accessMode: "public",
  features: {
    chat: true,
    executeActions: false,
    viewReports: false,
    requestApprovals: false,
  },
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

function parseConfig(raw: string | null): TestConfig {
  if (!raw) return DEFAULT_CONFIG;

  try {
    const parsed = JSON.parse(raw) as unknown;
    const data = asRecord(parsed);
    if (!data) return DEFAULT_CONFIG;

    const features = asRecord(data.features);

    return {
      position: normalizePosition(data.position),
      primaryColor: normalizeColor(data.primaryColor),
      buttonSize: normalizeSize(data.buttonSize),
      initialMessage: String(data.initialMessage ?? "How can I help you today?"),
      tenantName: String(data.tenantName ?? "AEAR Workspace"),
      enabledAgentNames: Array.isArray(data.enabledAgentNames)
        ? data.enabledAgentNames.map((item) => String(item ?? "").trim()).filter(Boolean)
        : [],
      accessMode: normalizeMode(data.accessMode),
      features: {
        chat: features?.chat !== false,
        executeActions: features?.executeActions === true,
        viewReports: features?.viewReports === true,
        requestApprovals: features?.requestApprovals === true,
      },
      tenantId: String(data.tenantId ?? "").trim() || undefined,
      widgetSlug: String(data.widgetSlug ?? "").trim() || undefined,
      allowedOrigins: Array.isArray(data.allowedOrigins)
        ? data.allowedOrigins.map((item) => String(item ?? "").trim()).filter(Boolean)
        : [],
      jwtSecretConfigured: data.jwtSecretConfigured === true,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export default function WidgetIntegrationTest() {
  const [searchParams] = useSearchParams();
  const [previewOpen, setPreviewOpen] = useState(true);

  const config = useMemo(() => parseConfig(searchParams.get("config")), [searchParams]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Widget Test Preview</h1>
          <p className="text-sm text-muted-foreground">Preview your current widget configuration in an isolated page.</p>
        </div>
        <Button variant="outline" asChild>
          <Link to="/dashboard/settings/widget">
            <ArrowLeft className="h-4 w-4" />
            Back to Widget Settings
          </Link>
        </Button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <WidgetPreviewMock config={config} open={previewOpen} onToggle={() => setPreviewOpen((current) => !current)} />
        </div>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center gap-2">
              <Beaker className="h-4 w-4 text-violet-600" />
              <h2 className="text-base font-semibold text-slate-900">Configuration Snapshot</h2>
            </div>

            <div className="space-y-2 text-sm text-slate-700">
              <p>
                <span className="font-medium">Tenant:</span> {config.tenantName}
              </p>
              <p>
                <span className="font-medium">Mode:</span> {config.accessMode}
              </p>
              <p>
                <span className="font-medium">Position:</span> {config.position}
              </p>
              <p>
                <span className="font-medium">Button size:</span> {config.buttonSize}
              </p>
              <p>
                <span className="font-medium">Widget slug:</span> {config.widgetSlug ?? "assistant"}
              </p>
            </div>
          </div>

          <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-slate-600" />
              <h3 className="text-sm font-semibold text-slate-900">Feature Flags</h3>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge className={cn(config.features.chat ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-700")}>Chat</Badge>
              <Badge className={cn(config.features.executeActions ? "bg-violet-100 text-violet-700" : "bg-slate-200 text-slate-700")}>
                Execute actions
              </Badge>
              <Badge className={cn(config.features.viewReports ? "bg-blue-100 text-blue-700" : "bg-slate-200 text-slate-700")}>
                View reports
              </Badge>
              <Badge className={cn(config.features.requestApprovals ? "bg-amber-100 text-amber-700" : "bg-slate-200 text-slate-700")}>
                Request approvals
              </Badge>
            </div>

            <p className="text-xs text-slate-500">
              {config.enabledAgentNames.length > 0
                ? `Agents restricted to: ${config.enabledAgentNames.join(", ")}`
                : "No agent restriction. All active agents can respond."}
            </p>

            {config.accessMode === "jwt" ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                JWT mode enabled. Ensure your backend issues short-lived signed tokens before embedding.
              </p>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
