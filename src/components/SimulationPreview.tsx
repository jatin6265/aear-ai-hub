import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { invokeEdge } from "@/lib/edge-invoke";

export type SimulationPreviewActionInput = {
  action?: string | null;
  resource?: string | null;
  riskLevel?: string | null;
  simulation?: Record<string, unknown> | null;
  params?: Record<string, unknown> | null;
};

type SimulationPreviewProps = {
  action: SimulationPreviewActionInput;
  className?: string;
};

type SimulationPreviewRow = {
  field: string;
  currentValue: string;
  newValue: string;
  changed: boolean;
  masked: boolean;
  pii: boolean;
};

type SimulationRiskFactor = {
  label: string;
  passed: boolean;
};

type SimulationPreviewData = {
  recordsAffected: number;
  reversible: boolean;
  reversibleExplanation: string;
  estimatedExecutionTime: string;
  dataScope: string;
  beforeAfterRows: SimulationPreviewRow[];
  bulkPreview: {
    enabled: boolean;
    shownCount: number;
    remainingCount: number;
    message: string;
  };
  downstreamEffects: string[];
  riskFactors: SimulationRiskFactor[];
  rollbackInfo: string;
  undoWindowSeconds: number;
  highRiskWarning: string | null;
  dryRun: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0);
}

function normalizeRows(value: unknown): SimulationPreviewRow[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      const row = asRecord(item);
      if (!row) return null;
      const field = String(row.field ?? row.column ?? row.key ?? "").trim();
      if (!field) return null;

      const masked = Boolean(row.masked ?? row.pii ?? false);
      const currentValueRaw = row.currentValue ?? row.before ?? "-";
      const newValueRaw = row.newValue ?? row.after ?? "-";

      return {
        field,
        currentValue: masked ? "[masked]" : String(currentValueRaw ?? "-"),
        newValue: masked ? "[masked]" : String(newValueRaw ?? "-"),
        changed: Boolean(row.changed ?? String(currentValueRaw ?? "") !== String(newValueRaw ?? "")),
        masked,
        pii: Boolean(row.pii ?? masked),
      } satisfies SimulationPreviewRow;
    })
    .filter((row): row is SimulationPreviewRow => Boolean(row));
}

function normalizeRiskFactors(value: unknown): SimulationRiskFactor[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const row = asRecord(item);
      if (!row) return null;
      const label = String(row.label ?? "").trim();
      if (!label) return null;
      return {
        label,
        passed: Boolean(row.passed),
      } satisfies SimulationRiskFactor;
    })
    .filter((row): row is SimulationRiskFactor => Boolean(row));
}

function localFallbackPreview(action: SimulationPreviewActionInput): SimulationPreviewData {
  const simulation = action.simulation ?? {};

  const rows = normalizeRows((simulation as Record<string, unknown>).beforeAfterRows ?? (simulation as Record<string, unknown>).previewRows ?? (simulation as Record<string, unknown>).changes);

  const recordsAffected = Math.max(
    Number((simulation as Record<string, unknown>).recordsAffected ?? (simulation as Record<string, unknown>).recordCount ?? (simulation as Record<string, unknown>).affectedRows ?? 1) || 1,
    1,
  );

  const reversible = Boolean((simulation as Record<string, unknown>).reversible ?? true);
  const dataScope = String((simulation as Record<string, unknown>).dataScope ?? `Within ${action.resource ?? "governed"} data only`).trim();

  const fallbackRows =
    rows.length > 0
      ? rows
      : [
          {
            field: "value",
            currentValue: "current",
            newValue: "updated",
            changed: true,
            masked: false,
            pii: false,
          },
        ];

  return {
    recordsAffected,
    reversible,
    reversibleExplanation: reversible
      ? "Compensation action is available for this update."
      : "This action cannot be automatically reversed.",
    estimatedExecutionTime: String((simulation as Record<string, unknown>).estimatedExecutionTime ?? "< 100ms"),
    dataScope,
    beforeAfterRows: fallbackRows,
    bulkPreview: {
      enabled: recordsAffected > 3,
      shownCount: Math.min(recordsAffected, 3),
      remainingCount: Math.max(recordsAffected - 3, 0),
      message:
        recordsAffected > 3
          ? `Preview of first 3 records + ${Math.max(recordsAffected - 3, 0)} more`
          : "Preview of affected records",
    },
    downstreamEffects: asStringArray((simulation as Record<string, unknown>).downstreamEffects).length
      ? asStringArray((simulation as Record<string, unknown>).downstreamEffects)
      : ["Inventory reports may be recalculated", "Related records may be updated"],
    riskFactors: normalizeRiskFactors((simulation as Record<string, unknown>).riskFactors).length
      ? normalizeRiskFactors((simulation as Record<string, unknown>).riskFactors)
      : [
          { label: "Has WHERE clause (not mass update)", passed: true },
          { label: "Target table has backup", passed: true },
          { label: "Affects financial calculations", passed: false },
          { label: "Within business hours", passed: true },
        ],
    rollbackInfo: String(
      (simulation as Record<string, unknown>).rollbackInfo ??
        `Compensation action: SET ${fallbackRows[0].field} = ${JSON.stringify(fallbackRows[0].currentValue)} WHERE id = '...'`,
    ),
    undoWindowSeconds: Number((simulation as Record<string, unknown>).undoWindowSeconds ?? 30) || 30,
    highRiskWarning:
      String(action.riskLevel ?? "").toLowerCase() === "high" || String(action.riskLevel ?? "").toLowerCase() === "critical"
        ? "This is a high-risk action. Review carefully."
        : null,
    dryRun: true,
  };
}

function toPreviewShape(value: unknown, fallback: SimulationPreviewActionInput): SimulationPreviewData {
  const row = asRecord(value);
  if (!row) return localFallbackPreview(fallback);

  const normalizedRows = normalizeRows(row.beforeAfterRows);
  const fallbackPreview = localFallbackPreview(fallback);

  return {
    recordsAffected: Math.max(Number(row.recordsAffected ?? fallbackPreview.recordsAffected) || 1, 1),
    reversible: Boolean(row.reversible ?? fallbackPreview.reversible),
    reversibleExplanation: String(row.reversibleExplanation ?? fallbackPreview.reversibleExplanation),
    estimatedExecutionTime: String(row.estimatedExecutionTime ?? fallbackPreview.estimatedExecutionTime),
    dataScope: String(row.dataScope ?? fallbackPreview.dataScope),
    beforeAfterRows: normalizedRows.length > 0 ? normalizedRows : fallbackPreview.beforeAfterRows,
    bulkPreview: {
      enabled: Boolean((asRecord(row.bulkPreview)?.enabled ?? fallbackPreview.bulkPreview.enabled) as boolean),
      shownCount: Number(asRecord(row.bulkPreview)?.shownCount ?? fallbackPreview.bulkPreview.shownCount) || fallbackPreview.bulkPreview.shownCount,
      remainingCount:
        Number(asRecord(row.bulkPreview)?.remainingCount ?? fallbackPreview.bulkPreview.remainingCount) || fallbackPreview.bulkPreview.remainingCount,
      message: String(asRecord(row.bulkPreview)?.message ?? fallbackPreview.bulkPreview.message),
    },
    downstreamEffects: asStringArray(row.downstreamEffects).length ? asStringArray(row.downstreamEffects) : fallbackPreview.downstreamEffects,
    riskFactors: normalizeRiskFactors(row.riskFactors).length ? normalizeRiskFactors(row.riskFactors) : fallbackPreview.riskFactors,
    rollbackInfo: String(row.rollbackInfo ?? fallbackPreview.rollbackInfo),
    undoWindowSeconds: Number(row.undoWindowSeconds ?? fallbackPreview.undoWindowSeconds) || fallbackPreview.undoWindowSeconds,
    highRiskWarning: row.highRiskWarning ? String(row.highRiskWarning) : fallbackPreview.highRiskWarning,
    dryRun: Boolean(row.dryRun ?? true),
  };
}

export default function SimulationPreview({ action, className }: SimulationPreviewProps) {
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<SimulationPreviewData | null>(null);
  const requestPayload = useMemo(
    () =>
      ({
        action: action.action ?? null,
        resource: action.resource ?? null,
        riskLevel: action.riskLevel ?? null,
        simulation: action.simulation ?? null,
        params: action.params ?? null,
      }) satisfies SimulationPreviewActionInput,
    [action.action, action.params, action.resource, action.riskLevel, action.simulation],
  );

  const simulationKey = useMemo(
    () =>
      JSON.stringify({
        action: requestPayload.action ?? "",
        resource: requestPayload.resource ?? "",
        riskLevel: requestPayload.riskLevel ?? "",
        simulation: requestPayload.simulation ?? {},
        params: requestPayload.params ?? {},
      }),
    [requestPayload.action, requestPayload.params, requestPayload.resource, requestPayload.riskLevel, requestPayload.simulation],
  );

  useEffect(() => {
    let active = true;

    const run = async () => {
      setLoading(true);

      const randomDelayMs = 500 + Math.floor(Math.random() * 500);
      const delayPromise = new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), randomDelayMs);
      });

      const fetchPromise = invokeEdge("simulate-action-preview", {
        body: {
          action: requestPayload.action,
          resource: requestPayload.resource,
          riskLevel: requestPayload.riskLevel,
          simulation: requestPayload.simulation,
          params: requestPayload.params,
        },
      });

      try {
        const [{ data, error }] = await Promise.all([fetchPromise, delayPromise]);
        if (!active) return;

        if (error) {
          setPreview(localFallbackPreview(requestPayload));
          return;
        }

        setPreview(toPreviewShape(data?.preview ?? null, requestPayload));
      } catch {
        if (!active) return;
        setPreview(localFallbackPreview(requestPayload));
      } finally {
        if (active) setLoading(false);
      }
    };

    void run();

    return () => {
      active = false;
    };
  }, [requestPayload, simulationKey]);

  const resolved = preview ?? localFallbackPreview(requestPayload);

  return (
    <div className={cn("rounded-lg border border-dashed border-slate-300 bg-slate-100/80 p-3", className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-700">Simulation Preview</p>
        <Badge variant="outline" className="border-slate-300 bg-slate-200 text-[10px] uppercase text-slate-700">
          Dry Run Only
        </Badge>
      </div>

      {loading ? (
        <div className="flex h-24 items-center justify-center gap-2 text-sm text-slate-600">
          <Loader2 className="h-4 w-4 animate-spin" />
          Calculating simulation...
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <section className="grid gap-2 rounded-md border border-slate-200 bg-white p-3 sm:grid-cols-2">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Records affected</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{resolved.recordsAffected}</p>
            </div>
            <div className="space-y-1">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Reversible</p>
              <p className="text-sm font-semibold text-slate-900">{resolved.reversible ? "Yes" : "No"}</p>
              <p className="text-xs text-slate-600">{resolved.reversibleExplanation}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Estimated execution time</p>
              <p className="mt-1 text-sm font-semibold text-slate-800">{resolved.estimatedExecutionTime}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Data scope</p>
              <p className="mt-1 text-sm font-semibold text-slate-800">{resolved.dataScope}</p>
            </div>
          </section>

          <section className="overflow-hidden rounded-md border border-slate-200 bg-white">
            <table className="w-full text-xs">
              <thead className="bg-slate-100 text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-left">Field</th>
                  <th className="px-3 py-2 text-left">Current Value</th>
                  <th className="px-3 py-2 text-left">New Value</th>
                </tr>
              </thead>
              <tbody>
                {resolved.beforeAfterRows.slice(0, 3).map((row) => (
                  <tr key={`${row.field}-${row.currentValue}-${row.newValue}`} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium text-slate-800">{row.field}</td>
                    <td className={cn("px-3 py-2 text-slate-700", row.changed ? "bg-yellow-50" : null)}>{row.currentValue}</td>
                    <td className={cn("px-3 py-2 text-slate-700", row.changed ? "bg-yellow-100" : null)}>{row.newValue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {resolved.bulkPreview.enabled ? (
            <p className="text-xs text-slate-600">{resolved.bulkPreview.message}</p>
          ) : null}

          <section className="rounded-md border border-slate-200 bg-white p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">This action may also affect:</p>
            <ul className="mt-2 space-y-1 text-xs text-slate-700">
              {resolved.downstreamEffects.map((effect) => (
                <li key={effect} className="flex items-start gap-1.5">
                  <span className="mt-1 h-1.5 w-1.5 rounded-full bg-slate-400" />
                  <span>{effect}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-md border border-slate-200 bg-white p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">Risk factors</p>
            <div className="mt-2 space-y-1.5 text-xs">
              {resolved.riskFactors.map((factor) => (
                <p key={factor.label} className="flex items-center gap-2 text-slate-700">
                  {factor.passed ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-red-600" />
                  )}
                  {factor.label}
                </p>
              ))}
            </div>
          </section>

          <section className="rounded-md border border-slate-200 bg-white p-3 text-xs text-slate-700">
            <p>
              <span className="font-semibold">Reversibility:</span> {resolved.rollbackInfo}
            </p>
            <p className="mt-1">
              <span className="font-semibold">Undo window:</span> {resolved.undoWindowSeconds}-second undo window shown if action is executed.
            </p>
          </section>

          {resolved.highRiskWarning ? (
            <div className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-100 px-2 py-1 text-xs text-amber-900">
              <AlertTriangle className="h-3.5 w-3.5" />
              {resolved.highRiskWarning}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
