import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { formatEdgeFunctionError, sanitizeConnectionErrorMessage } from "@/lib/edge-function-error";
import { invokeEdge } from "@/lib/edge-invoke";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

type HardGuardrail = {
  code: string;
  title: string;
  description: string;
  enabled: boolean;
  badge: string;
};

type GuardrailsFormState = {
  bulkUpdateLimit: "10" | "100" | "500" | "1000" | "unlimited";
  simulationModeEnabled: boolean;
  businessHoursLockEnabled: boolean;
  businessStart: string;
  businessEnd: string;
  businessTimezone: string;
  financialMutationLimit: string;
  financialCurrency: string;
  newUserRestrictionDays: string;
};

type GuardrailsPayload = {
  profileRole: string;
  isAdmin: boolean;
  hardGuardrails: HardGuardrail[];
  configuration: {
    bulkUpdateLimit: {
      enabled: boolean;
      threshold: number;
      unlimited: boolean;
    };
    simulationMode: {
      enabled: boolean;
    };
    businessHoursLock: {
      enabled: boolean;
      start: string;
      end: string;
      timezone: string;
    };
    financialMutationLimit: {
      enabled: boolean;
      amount: number;
      currency: string;
    };
    newUserRestriction: {
      enabled: boolean;
      days: number;
    };
  };
  updatedAt: string | null;
};

const BULK_OPTIONS = ["10", "100", "500", "1000", "unlimited"] as const;

const TIMEZONE_OPTIONS = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
];

const DEFAULT_HARD_GUARDRAILS: HardGuardrail[] = [
  {
    code: "hard_mass_delete_without_where",
    title: "Mass DELETE without WHERE clause",
    description: "Always blocked",
    enabled: true,
    badge: "Cannot be disabled",
  },
  {
    code: "hard_drop_or_truncate",
    title: "DROP TABLE / TRUNCATE",
    description: "Always blocked",
    enabled: true,
    badge: "Cannot be disabled",
  },
  {
    code: "hard_financial_without_accountable",
    title: "Financial ledger manipulation without Accountable approval",
    description: "Always blocked",
    enabled: true,
    badge: "Cannot be disabled",
  },
  {
    code: "hard_prompt_injection_filter",
    title: "Prompt injection patterns",
    description: "Always filtered",
    enabled: true,
    badge: "Cannot be disabled",
  },
  {
    code: "hard_unknown_tool_reject",
    title: "Unknown tool execution",
    description: "Always rejected",
    enabled: true,
    badge: "Cannot be disabled",
  },
];

const DEFAULT_FORM: GuardrailsFormState = {
  bulkUpdateLimit: "100",
  simulationModeEnabled: true,
  businessHoursLockEnabled: true,
  businessStart: "09:00",
  businessEnd: "18:00",
  businessTimezone: "UTC",
  financialMutationLimit: "10000",
  financialCurrency: "USD",
  newUserRestrictionDays: "7",
};

const EMPTY_PAYLOAD: GuardrailsPayload = {
  profileRole: "member",
  isAdmin: false,
  hardGuardrails: DEFAULT_HARD_GUARDRAILS,
  configuration: {
    bulkUpdateLimit: { enabled: true, threshold: 100, unlimited: false },
    simulationMode: { enabled: true },
    businessHoursLock: { enabled: true, start: "09:00", end: "18:00", timezone: "UTC" },
    financialMutationLimit: { enabled: true, amount: 10000, currency: "USD" },
    newUserRestriction: { enabled: true, days: 7 },
  },
  updatedAt: null,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function sanitizeTime(value: string, fallback: string) {
  return /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value) ? value : fallback;
}

function normalizePayload(value: unknown): GuardrailsPayload {
  const raw = asRecord(value);
  if (!raw) return EMPTY_PAYLOAD;

  const configuration = asRecord(raw.configuration);
  const bulk = asRecord(configuration?.bulkUpdateLimit);
  const simulation = asRecord(configuration?.simulationMode);
  const business = asRecord(configuration?.businessHoursLock);
  const financial = asRecord(configuration?.financialMutationLimit);
  const newUser = asRecord(configuration?.newUserRestriction);

  const hardRules = Array.isArray(raw.hardGuardrails)
    ? raw.hardGuardrails
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const title = String(row.title ?? "").trim();
          if (!title) return null;

          return {
            code: String(row.code ?? title.toLowerCase().replace(/\s+/g, "_")),
            title,
            description: String(row.description ?? "Always active"),
            enabled: row.enabled !== false,
            badge: String(row.badge ?? "Cannot be disabled"),
          } satisfies HardGuardrail;
        })
        .filter((item): item is HardGuardrail => Boolean(item))
    : [];

  const bulkThresholdRaw = Number(bulk?.threshold ?? 100);
  const bulkThreshold = [10, 100, 500, 1000].includes(bulkThresholdRaw) ? bulkThresholdRaw : 100;
  const bulkUnlimited = bulk?.unlimited === true || bulk?.enabled === false;

  const businessTimezone = String(business?.timezone ?? "UTC");

  return {
    profileRole: String(raw.profileRole ?? "member"),
    isAdmin: raw.isAdmin === true,
    hardGuardrails: hardRules.length > 0 ? hardRules : DEFAULT_HARD_GUARDRAILS,
    configuration: {
      bulkUpdateLimit: {
        enabled: bulk?.enabled !== false,
        threshold: bulkThreshold,
        unlimited: bulkUnlimited,
      },
      simulationMode: {
        enabled: simulation?.enabled !== false,
      },
      businessHoursLock: {
        enabled: business?.enabled !== false,
        start: sanitizeTime(String(business?.start ?? "09:00"), "09:00"),
        end: sanitizeTime(String(business?.end ?? "18:00"), "18:00"),
        timezone: TIMEZONE_OPTIONS.includes(businessTimezone) ? businessTimezone : "UTC",
      },
      financialMutationLimit: {
        enabled: financial?.enabled !== false,
        amount: Number(financial?.amount ?? 10000) || 10000,
        currency: String(financial?.currency ?? "USD").toUpperCase(),
      },
      newUserRestriction: {
        enabled: newUser?.enabled !== false,
        days: Math.max(0, Math.min(365, Number(newUser?.days ?? 7) || 7)),
      },
    },
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : null,
  };
}

function payloadToForm(payload: GuardrailsPayload): GuardrailsFormState {
  const bulkUpdateLimit = payload.configuration.bulkUpdateLimit.unlimited
    ? "unlimited"
    : (String(payload.configuration.bulkUpdateLimit.threshold) as GuardrailsFormState["bulkUpdateLimit"]);

  return {
    bulkUpdateLimit: BULK_OPTIONS.includes(bulkUpdateLimit as (typeof BULK_OPTIONS)[number])
      ? (bulkUpdateLimit as GuardrailsFormState["bulkUpdateLimit"])
      : "100",
    simulationModeEnabled: payload.configuration.simulationMode.enabled,
    businessHoursLockEnabled: payload.configuration.businessHoursLock.enabled,
    businessStart: payload.configuration.businessHoursLock.start,
    businessEnd: payload.configuration.businessHoursLock.end,
    businessTimezone: payload.configuration.businessHoursLock.timezone,
    financialMutationLimit: String(payload.configuration.financialMutationLimit.amount),
    financialCurrency: payload.configuration.financialMutationLimit.currency,
    newUserRestrictionDays: String(payload.configuration.newUserRestriction.days),
  };
}

export default function Guardrails() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [tenantId, setTenantId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [payload, setPayload] = useState<GuardrailsPayload>(EMPTY_PAYLOAD);
  const [form, setForm] = useState<GuardrailsFormState>(DEFAULT_FORM);
  const [baselineForm, setBaselineForm] = useState<GuardrailsFormState>(DEFAULT_FORM);

  useEffect(() => {
    if (!user) {
      setTenantId(null);
      setPayload(EMPTY_PAYLOAD);
      setForm(DEFAULT_FORM);
      setBaselineForm(DEFAULT_FORM);
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
        const { data, error } = await invokeEdge("guardrails-config", {
          body: {
            operation: "get_payload",
          },
        });

        if (error) {
          const parsed = sanitizeConnectionErrorMessage(
            await formatEdgeFunctionError(error, { functionName: "guardrails-config" }),
          );
          throw new Error(parsed);
        }

        const normalized = normalizePayload((data as { payload?: unknown } | null)?.payload ?? null);
        const nextForm = payloadToForm(normalized);

        setPayload(normalized);
        setForm(nextForm);
        setBaselineForm(nextForm);
      } catch (error) {
        toast({
          title: "Could not load guardrails",
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

    const channel = supabase
      .channel(`guardrails-config-${tenantId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "guardrails",
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

  const bulkIndex = useMemo(() => BULK_OPTIONS.indexOf(form.bulkUpdateLimit), [form.bulkUpdateLimit]);

  const isDirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(baselineForm), [form, baselineForm]);
  const canSaveConfig = useMemo(() => {
    const role = payload.profileRole.toLowerCase();
    return role === "owner" || role === "admin" || role === "manager";
  }, [payload.profileRole]);

  const handleSave = async () => {
    if (!tenantId) return;

    setSaving(true);

    try {
      const { data, error } = await invokeEdge("guardrails-config", {
        body: {
          operation: "save_configuration",
          bulkUpdateLimit: form.bulkUpdateLimit,
          simulationModeEnabled: form.simulationModeEnabled,
          businessHoursLockEnabled: form.businessHoursLockEnabled,
          businessStart: form.businessStart,
          businessEnd: form.businessEnd,
          businessTimezone: form.businessTimezone,
          financialMutationLimit: Number(form.financialMutationLimit || "0"),
          financialCurrency: form.financialCurrency,
          newUserRestrictionDays: Number(form.newUserRestrictionDays || "0"),
        },
      });

      if (error) {
        const parsed = sanitizeConnectionErrorMessage(
          await formatEdgeFunctionError(error, { functionName: "guardrails-config" }),
        );
        throw new Error(parsed);
      }

      const normalized = normalizePayload((data as { payload?: unknown } | null)?.payload ?? null);
      const nextForm = payloadToForm(normalized);

      setPayload(normalized);
      setForm(nextForm);
      setBaselineForm(nextForm);

      toast({
        title: "Guardrails saved",
        description: "Configuration updated and audit log recorded.",
      });
    } catch (error) {
      toast({
        title: "Could not save guardrails",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">AI Guardrails</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Guardrails protect your data from unsafe AI actions. Some are mandatory and cannot be disabled.
        </p>
      </div>

      <section className="rounded-xl border border-red-200 bg-red-50 p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-red-100 text-red-700">
            <Lock className="h-4 w-4" />
          </span>
          <h2 className="text-sm font-semibold text-red-900">Mandatory Protections (Always Active)</h2>
        </div>

        <div className="mt-4 space-y-2">
          {(loading ? DEFAULT_HARD_GUARDRAILS : payload.hardGuardrails).map((rule) => (
            <article key={rule.code} className="flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-white px-3 py-3">
              <div className="flex items-start gap-2">
                <Lock className="mt-0.5 h-4 w-4 text-red-700" />
                <div>
                  <p className="text-sm font-semibold text-slate-900">{rule.title}</p>
                  <p className="mt-1 text-xs text-slate-600">{rule.description}</p>
                </div>
              </div>
              <Badge variant="outline" className="border-slate-300 bg-slate-100 text-slate-700">
                {rule.badge || "Cannot be disabled"}
              </Badge>
            </article>
          ))}
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Configurable Guardrails</h2>

        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={`guardrail-config-skeleton-${index}`} className="h-24 w-full" />
            ))}
          </div>
        ) : (
          <>
            <article className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">Bulk Update Limit</h3>
                  <p className="mt-1 text-xs text-slate-600">Block updates affecting more than N rows without approval.</p>
                </div>
                <Badge variant="outline" className="border-slate-300 bg-white text-slate-700">
                  {form.bulkUpdateLimit === "unlimited" ? "Unlimited" : `${form.bulkUpdateLimit} rows`}
                </Badge>
              </div>

              <div className="mt-3 space-y-2">
                <input
                  type="range"
                  min={0}
                  max={BULK_OPTIONS.length - 1}
                  step={1}
                  value={Math.max(0, bulkIndex)}
                  onChange={(event) => {
                    const nextIndex = Math.max(0, Math.min(BULK_OPTIONS.length - 1, Number(event.target.value)));
                    setForm((prev) => ({ ...prev, bulkUpdateLimit: BULK_OPTIONS[nextIndex] }));
                  }}
                  className="w-full accent-violet-600"
                />
                <div className="grid grid-cols-5 text-[11px] font-medium text-slate-500">
                  {BULK_OPTIONS.map((option) => (
                    <span key={option} className={cn("text-center", form.bulkUpdateLimit === option ? "text-violet-700" : undefined)}>
                      {option === "unlimited" ? "Unlimited" : option}
                    </span>
                  ))}
                </div>
              </div>
            </article>

            <article className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">Simulation Mode</h3>
                  <p className="mt-1 text-xs text-slate-600">Always show simulation preview before executing WRITE actions.</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="border-emerald-200 bg-emerald-100 text-emerald-700">ON (recommended)</Badge>
                  <Switch
                    checked={form.simulationModeEnabled}
                    onCheckedChange={(checked) => setForm((prev) => ({ ...prev, simulationModeEnabled: checked }))}
                  />
                </div>
              </div>
            </article>

            <article className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">Business Hours Lock</h3>
                  <p className="mt-1 text-xs text-slate-600">Block CRITICAL actions outside business hours.</p>
                </div>
                <Switch
                  checked={form.businessHoursLockEnabled}
                  onCheckedChange={(checked) => setForm((prev) => ({ ...prev, businessHoursLockEnabled: checked }))}
                />
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-600">Start</p>
                  <Input
                    type="time"
                    value={form.businessStart}
                    onChange={(event) => setForm((prev) => ({ ...prev, businessStart: event.target.value }))}
                  />
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-600">End</p>
                  <Input
                    type="time"
                    value={form.businessEnd}
                    onChange={(event) => setForm((prev) => ({ ...prev, businessEnd: event.target.value }))}
                  />
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-600">Timezone</p>
                  <Select
                    value={form.businessTimezone}
                    onValueChange={(value) => setForm((prev) => ({ ...prev, businessTimezone: value }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIMEZONE_OPTIONS.map((timezone) => (
                        <SelectItem key={timezone} value={timezone}>
                          {timezone}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </article>

            <article className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <h3 className="text-sm font-semibold text-slate-900">Financial Mutation Limit</h3>
              <p className="mt-1 text-xs text-slate-600">Require dual approval for financial changes above $X.</p>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-600">Currency</p>
                  <Input
                    value={form.financialCurrency}
                    maxLength={3}
                    onChange={(event) => setForm((prev) => ({ ...prev, financialCurrency: event.target.value.toUpperCase() }))}
                    placeholder="USD"
                  />
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-600">Limit amount</p>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={form.financialMutationLimit}
                    onChange={(event) => setForm((prev) => ({ ...prev, financialMutationLimit: event.target.value }))}
                    placeholder="10000"
                  />
                </div>
              </div>
            </article>

            <article className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <h3 className="text-sm font-semibold text-slate-900">New User Restriction</h3>
              <p className="mt-1 text-xs text-slate-600">Users added in last N days can only use READ_ONLY actions.</p>

              <div className="mt-3 max-w-[220px]">
                <p className="mb-1 text-xs font-medium text-slate-600">Restriction window (days)</p>
                <Input
                  type="number"
                  min={0}
                  max={365}
                  value={form.newUserRestrictionDays}
                  onChange={(event) => setForm((prev) => ({ ...prev, newUserRestrictionDays: event.target.value }))}
                />
              </div>
            </article>
          </>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <div className="flex items-center gap-2 text-xs text-slate-600">
            <AlertCircle className="h-4 w-4" />
            Changes are logged in audit log automatically.
          </div>
          <Button type="button" onClick={() => void handleSave()} disabled={loading || saving || !isDirty || !canSaveConfig}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save Changes
          </Button>
        </div>

        {!canSaveConfig ? (
          <p className="text-xs text-amber-700">
            Your role is <span className="font-semibold">{payload.profileRole}</span>. Owner/Admin/Manager roles can save guardrail changes.
          </p>
        ) : null}
      </section>
    </div>
  );
}
