import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileUp,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdge } from "@/lib/edge-invoke";

type RaciType = "R" | "A" | "C" | "I";
type RaciCellValue = RaciType | "-";
type RaciCategory = "Financial Data" | "Inventory" | "HR" | "Operations" | "System" | string;

type RaciRole = {
  name: string;
  displayName: string;
  displayOrder: number;
  rulesCount: number;
};

type RaciResource = {
  resourceKey: string;
  resourceLabel: string;
  action: string;
  category: RaciCategory;
  displayOrder: number;
};

type RaciCell = {
  resourceKey: string;
  action: string;
  roleName: string;
  raciType: RaciType;
};

type RaciPayload = {
  roles: RaciRole[];
  resources: RaciResource[];
  cells: RaciCell[];
};

type ValidationIssue = {
  resourceKey: string;
  resourceLabel: string;
  action: string;
  category: string;
  issue: string;
};

type ValidationSummary = {
  totalResources: number;
  compliantResources: number;
  issuesCount: number;
  issues: ValidationIssue[];
};

type RaciFunctionResponse = {
  ok?: boolean;
  error?: string;
  payload?: unknown;
  validation?: unknown;
  importedCount?: number;
};

const CATEGORY_ORDER = ["Financial Data", "Inventory", "HR", "Operations", "System"] as const;
const RACI_CYCLE: RaciCellValue[] = ["R", "A", "C", "I", "-"];
const ACCEPTED_RACI = new Set<RaciCellValue>(RACI_CYCLE);
const ACCEPTED_TYPES = new Set<RaciType>(["R", "A", "C", "I"]);

const CATEGORY_OPTIONS: string[] = [
  "Financial Data",
  "Inventory",
  "HR",
  "Operations",
  "System",
];

const cellClassMap: Record<RaciCellValue, string> = {
  R: "bg-violet-500 text-white hover:bg-violet-600",
  A: "bg-amber-400 text-amber-950 hover:bg-amber-500",
  C: "bg-blue-500 text-white hover:bg-blue-600",
  I: "bg-slate-500 text-white hover:bg-slate-600",
  "-": "bg-white text-slate-400 hover:bg-slate-100",
};

const raciBadgeClass: Record<RaciCellValue, string> = {
  R: "bg-violet-100 text-violet-700",
  A: "bg-amber-100 text-amber-700",
  C: "bg-blue-100 text-blue-700",
  I: "bg-slate-200 text-slate-700",
  "-": "bg-white text-slate-500",
};

function normalizeText(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeCellValue(value: unknown): RaciType | null {
  const upper = normalizeText(value).toUpperCase();
  if (ACCEPTED_TYPES.has(upper as RaciType)) return upper as RaciType;
  return null;
}

function normalizePayload(input: unknown): RaciPayload {
  const raw = (input ?? {}) as {
    roles?: unknown[];
    resources?: unknown[];
    cells?: unknown[];
  };

  const roles: RaciRole[] = Array.isArray(raw.roles)
    ? raw.roles
        .map((item) => {
          const role = item as Record<string, unknown>;
          const name = normalizeText(role.name).toLowerCase();
          if (!name) return null;
          return {
            name,
            displayName: normalizeText(role.displayName, name),
            displayOrder: Number(role.displayOrder ?? 100),
            rulesCount: Number(role.rulesCount ?? 0),
          };
        })
        .filter((item): item is RaciRole => item !== null)
    : [];

  const resources: RaciResource[] = Array.isArray(raw.resources)
    ? raw.resources
        .map((item) => {
          const resource = item as Record<string, unknown>;
          const resourceKey = normalizeText(resource.resourceKey).toLowerCase();
          if (!resourceKey) return null;
          return {
            resourceKey,
            resourceLabel: normalizeText(resource.resourceLabel, resourceKey),
            action: normalizeText(resource.action, "execute").toLowerCase(),
            category: normalizeText(resource.category, "System"),
            displayOrder: Number(resource.displayOrder ?? 100),
          };
        })
        .filter((item): item is RaciResource => item !== null)
    : [];

  const cells: RaciCell[] = Array.isArray(raw.cells)
    ? raw.cells
        .map((item) => {
          const cell = item as Record<string, unknown>;
          const resourceKey = normalizeText(cell.resourceKey).toLowerCase();
          const action = normalizeText(cell.action, "execute").toLowerCase();
          const roleName = normalizeText(cell.roleName).toLowerCase();
          const raciType = normalizeCellValue(cell.raciType);
          if (!resourceKey || !action || !roleName || !raciType) return null;
          return {
            resourceKey,
            action,
            roleName,
            raciType,
          };
        })
        .filter((item): item is RaciCell => item !== null)
    : [];

  return { roles, resources, cells };
}

function normalizeValidation(input: unknown): ValidationSummary {
  const raw = (input ?? {}) as {
    totalResources?: unknown;
    compliantResources?: unknown;
    issuesCount?: unknown;
    issues?: unknown[];
  };

  const issues: ValidationIssue[] = Array.isArray(raw.issues)
    ? raw.issues
        .map((item) => {
          const issue = item as Record<string, unknown>;
          const resourceKey = normalizeText(issue.resourceKey);
          const resourceLabel = normalizeText(issue.resourceLabel, resourceKey);
          const action = normalizeText(issue.action, "execute");
          const category = normalizeText(issue.category, "System");
          const message = normalizeText(issue.issue);
          if (!resourceKey || !message) return null;
          return {
            resourceKey,
            resourceLabel,
            action,
            category,
            issue: message,
          };
        })
        .filter((item): item is ValidationIssue => item !== null)
    : [];

  return {
    totalResources: Number(raw.totalResources ?? 0),
    compliantResources: Number(raw.compliantResources ?? 0),
    issuesCount: Number(raw.issuesCount ?? issues.length),
    issues,
  };
}

function formatTitleCase(value: string) {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(" ");
}

function resourceCellKey(resourceKey: string, action: string, roleName: string) {
  return `${resourceKey.toLowerCase()}::${action.toLowerCase()}::${roleName.toLowerCase()}`;
}

function cycleRaci(current: RaciCellValue): RaciCellValue {
  const currentIndex = RACI_CYCLE.indexOf(current);
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % RACI_CYCLE.length : 0;
  return RACI_CYCLE[nextIndex];
}

function shouldUseRpcFallback(error: unknown) {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("edge function") ||
    normalized.includes("failed to send") ||
    normalized.includes("404") ||
    normalized.includes("non-2xx")
  );
}

function applyCell(payload: RaciPayload, resourceKey: string, action: string, roleName: string, nextValue: RaciCellValue): RaciPayload {
  const normalizedResource = resourceKey.toLowerCase();
  const normalizedAction = action.toLowerCase();
  const normalizedRole = roleName.toLowerCase();

  const filtered = payload.cells.filter(
    (cell) =>
      !(cell.resourceKey === normalizedResource && cell.action === normalizedAction && cell.roleName === normalizedRole),
  );

  const nextCells =
    nextValue === "-"
      ? filtered
      : [
          ...filtered,
          {
            resourceKey: normalizedResource,
            action: normalizedAction,
            roleName: normalizedRole,
            raciType: nextValue,
          },
        ];

  return {
    ...payload,
    cells: nextCells,
  };
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function parseCsvRows(rawText: string): Array<Record<string, string>> {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((header) => header.trim().toLowerCase());
  const rows: Array<Record<string, string>> = [];

  for (let index = 1; index < lines.length; index += 1) {
    const values = parseCsvLine(lines[index]);
    const row: Record<string, string> = {};

    headers.forEach((header, colIdx) => {
      row[header] = (values[colIdx] ?? "").trim();
    });

    rows.push(row);
  }

  return rows;
}

export default function Raci() {
  const { user } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [tenantId, setTenantId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingCellKey, setSavingCellKey] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [payload, setPayload] = useState<RaciPayload>({
    roles: [],
    resources: [],
    cells: [],
  });

  const [validation, setValidation] = useState<ValidationSummary | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});

  const [newRoleName, setNewRoleName] = useState("");
  const [showAddRole, setShowAddRole] = useState(false);

  const [showAddRule, setShowAddRule] = useState(false);
  const [newResourceKey, setNewResourceKey] = useState("");
  const [newAction, setNewAction] = useState("execute");
  const [newCategory, setNewCategory] = useState("System");

  const [importingCsv, setImportingCsv] = useState(false);

  const runRpcFallback = useCallback(
    async (operation: string, args: Record<string, unknown>) => {
      if (operation === "get_payload") {
        const { data, error } = await supabase.rpc("get_raci_editor_payload");
        if (error) throw error;
        return { payload: data };
      }

      if (operation === "set_cell") {
        const { error } = await supabase.rpc("set_raci_cell", {
          p_resource_key: args.resourceKey,
          p_action: args.action,
          p_role_name: args.roleName,
          p_raci_type: args.raciType,
        });
        if (error) throw error;
      } else if (operation === "add_role") {
        const { error } = await supabase.rpc("add_raci_role", {
          p_role_name: args.roleName,
        });
        if (error) throw error;
      } else if (operation === "rename_role") {
        const { error } = await supabase.rpc("rename_raci_role", {
          p_old_role_name: args.oldRoleName,
          p_new_role_name: args.newRoleName,
        });
        if (error) throw error;
      } else if (operation === "delete_role") {
        const { data, error } = await supabase.rpc("delete_raci_role", {
          p_role_name: args.roleName,
          p_force: Boolean(args.force),
        });
        if (error) throw error;
        const payloadResult = await runRpcFallback("get_payload", {});
        return {
          payload: payloadResult.payload,
          deleted: Number(data ?? 0),
        };
      } else if (operation === "add_rule") {
        const { error } = await supabase.rpc("add_raci_rule_resource", {
          p_resource_key: args.resourceKey,
          p_action: args.action,
          p_category: args.category,
        });
        if (error) throw error;
      } else if (operation === "import_csv") {
        const { data, error } = await supabase.rpc("import_raci_rules_csv_rows", {
          p_rows: args.rows,
        });
        if (error) throw error;

        const payloadResult = await runRpcFallback("get_payload", {});
        return {
          payload: payloadResult.payload,
          importedCount: Number(data ?? 0),
        };
      } else if (operation === "validate") {
        const { data, error } = await supabase.rpc("validate_raci_matrix_rules");
        if (error) throw error;
        return {
          validation: data,
        };
      }

      const payloadResult = await runRpcFallback("get_payload", {});
      return { payload: payloadResult.payload };
    },
    [],
  );

  const runEditor = useCallback(
    async (operation: string, args: Record<string, unknown> = {}) => {
      try {
        const { data, error } = await invokeEdge("raci-editor", {
          body: {
            operation,
            ...args,
          },
        });

        if (error) throw error;

        const response = (data ?? {}) as RaciFunctionResponse;
        if (response.ok === false) {
          throw new Error(response.error || "RACI request failed");
        }

        return response;
      } catch (error) {
        if (!shouldUseRpcFallback(error)) throw error;
        const fallbackResult = await runRpcFallback(operation, args);
        return {
          ok: true,
          payload: fallbackResult.payload,
          validation: fallbackResult.validation,
          importedCount: fallbackResult.importedCount,
        } as RaciFunctionResponse;
      }
    },
    [runRpcFallback],
  );

  const loadPayload = useCallback(async () => {
    const response = await runEditor("get_payload");
    setPayload(normalizePayload(response.payload));
  }, [runEditor]);

  useEffect(() => {
    if (!user) return;
    let isActive = true;
    let channel: RealtimeChannel | null = null;

    const bootstrap = async () => {
      try {
        const workspace = await ensureUserWorkspace(user);
        if (!isActive) return;

        setTenantId(workspace.tenantId);
        await loadPayload();
        if (!isActive) return;

        channel = supabase
          .channel(`raci-editor-${workspace.tenantId}`)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "raci_matrix",
              filter: `tenant_id=eq.${workspace.tenantId}`,
            },
            () => {
              void loadPayload();
            },
          )
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "raci_roles",
              filter: `tenant_id=eq.${workspace.tenantId}`,
            },
            () => {
              void loadPayload();
            },
          )
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "raci_resources",
              filter: `tenant_id=eq.${workspace.tenantId}`,
            },
            () => {
              void loadPayload();
            },
          )
          .subscribe();
      } catch (error) {
        if (!isActive) return;
        toast({
          title: "Could not load RACI matrix",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        });
      } finally {
        if (isActive) setLoading(false);
      }
    };

    void bootstrap();

    return () => {
      isActive = false;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [loadPayload, toast, user]);

  const roleStatsMap = useMemo(() => {
    return payload.roles.reduce<Record<string, number>>((acc, role) => {
      acc[role.name.toLowerCase()] = Number(role.rulesCount ?? 0);
      return acc;
    }, {});
  }, [payload.roles]);

  const resourcesByCategory = useMemo(() => {
    const grouped = payload.resources.reduce<Record<string, RaciResource[]>>((acc, resource) => {
      const key = resource.category || "System";
      if (!acc[key]) acc[key] = [];
      acc[key].push(resource);
      return acc;
    }, {});

    return Object.entries(grouped)
      .sort(([left], [right]) => {
        const leftIdx = CATEGORY_ORDER.indexOf(left as (typeof CATEGORY_ORDER)[number]);
        const rightIdx = CATEGORY_ORDER.indexOf(right as (typeof CATEGORY_ORDER)[number]);
        const leftOrder = leftIdx === -1 ? 999 : leftIdx;
        const rightOrder = rightIdx === -1 ? 999 : rightIdx;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        return left.localeCompare(right);
      })
      .map(([category, resources]) => ({
        category,
        resources: [...resources].sort((a, b) => {
          if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
          return a.resourceLabel.localeCompare(b.resourceLabel);
        }),
      }));
  }, [payload.resources]);

  const cellValueMap = useMemo(() => {
    const map = new Map<string, RaciType>();
    payload.cells.forEach((cell) => {
      map.set(resourceCellKey(cell.resourceKey, cell.action, cell.roleName), cell.raciType);
    });
    return map;
  }, [payload.cells]);

  const getCellValue = useCallback(
    (resourceKey: string, action: string, roleName: string): RaciCellValue => {
      const value = cellValueMap.get(resourceCellKey(resourceKey, action, roleName));
      return value ?? "-";
    },
    [cellValueMap],
  );

  const applyResponsePayload = useCallback((response: RaciFunctionResponse) => {
    if (response.payload) {
      setPayload(normalizePayload(response.payload));
    }
  }, []);

  const handleCellClick = useCallback(
    async (resourceKey: string, action: string, roleName: string) => {
      const current = getCellValue(resourceKey, action, roleName);
      const next = cycleRaci(current);
      const key = resourceCellKey(resourceKey, action, roleName);

      setSavingCellKey(key);
      const previous = payload;
      setPayload((existing) => applyCell(existing, resourceKey, action, roleName, next));

      try {
        const response = await runEditor("set_cell", {
          resourceKey,
          action,
          roleName,
          raciType: next,
        });
        applyResponsePayload(response);
      } catch (error) {
        setPayload(previous);
        toast({
          title: "Could not update RACI assignment",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        });
      } finally {
        setSavingCellKey(null);
      }
    },
    [applyResponsePayload, getCellValue, payload, runEditor, toast],
  );

  const handleAddRole = useCallback(async () => {
    const roleName = newRoleName.trim().toLowerCase();
    if (!roleName) {
      toast({
        title: "Role name is required",
        description: "Provide a role name before adding.",
        variant: "destructive",
      });
      return;
    }

    setWorking(true);
    try {
      const response = await runEditor("add_role", { roleName });
      applyResponsePayload(response);
      setNewRoleName("");
      setShowAddRole(false);
      toast({ title: "Role added", description: `${formatTitleCase(roleName)} is now part of the matrix.` });
    } catch (error) {
      toast({
        title: "Could not add role",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setWorking(false);
    }
  }, [applyResponsePayload, newRoleName, runEditor, toast]);

  const handleRenameRole = useCallback(
    async (roleName: string) => {
      const nextName = window.prompt("Rename role", roleName)?.trim().toLowerCase();
      if (!nextName || nextName === roleName.toLowerCase()) return;

      setWorking(true);
      try {
        const response = await runEditor("rename_role", {
          oldRoleName: roleName,
          newRoleName: nextName,
        });
        applyResponsePayload(response);
        toast({ title: "Role renamed", description: `${formatTitleCase(roleName)} updated to ${formatTitleCase(nextName)}.` });
      } catch (error) {
        toast({
          title: "Could not rename role",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        });
      } finally {
        setWorking(false);
      }
    },
    [applyResponsePayload, runEditor, toast],
  );

  const handleDeleteRole = useCallback(
    async (roleName: string) => {
      const normalized = roleName.toLowerCase();
      const rulesCount = roleStatsMap[normalized] ?? 0;

      let force = false;
      if (rulesCount > 0) {
        const confirmed = window.confirm(
          `Role ${formatTitleCase(roleName)} has ${rulesCount} assigned rule${rulesCount === 1 ? "" : "s"}. Delete role and remove those assignments?`,
        );
        if (!confirmed) return;
        force = true;
      } else {
        const confirmed = window.confirm(`Delete role ${formatTitleCase(roleName)}?`);
        if (!confirmed) return;
      }

      setWorking(true);
      try {
        const response = await runEditor("delete_role", { roleName, force });
        applyResponsePayload(response);
        toast({ title: "Role deleted", description: `${formatTitleCase(roleName)} was removed.` });
      } catch (error) {
        toast({
          title: "Could not delete role",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        });
      } finally {
        setWorking(false);
      }
    },
    [applyResponsePayload, roleStatsMap, runEditor, toast],
  );

  const handleAddRule = useCallback(async () => {
    const resourceKey = newResourceKey.trim().toLowerCase();
    const action = newAction.trim().toLowerCase() || "execute";
    const category = newCategory.trim() || "System";

    if (!resourceKey) {
      toast({
        title: "Resource is required",
        description: "Enter a resource key before saving.",
        variant: "destructive",
      });
      return;
    }

    setWorking(true);
    try {
      const response = await runEditor("add_rule", {
        resourceKey,
        action,
        category,
      });
      applyResponsePayload(response);
      setNewResourceKey("");
      setNewAction("execute");
      setNewCategory("System");
      setShowAddRule(false);
      toast({ title: "Rule resource added", description: `${formatTitleCase(resourceKey)} is now available in the matrix.` });
    } catch (error) {
      toast({
        title: "Could not add rule resource",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setWorking(false);
    }
  }, [applyResponsePayload, newAction, newCategory, newResourceKey, runEditor, toast]);

  const handleValidate = useCallback(async () => {
    setWorking(true);
    try {
      const response = await runEditor("validate");
      setValidation(normalizeValidation(response.validation));
      toast({ title: "Validation complete", description: "RACI assignments were checked." });
    } catch (error) {
      toast({
        title: "Validation failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setWorking(false);
    }
  }, [runEditor, toast]);

  const handleCsvImport = useCallback(
    async (file: File) => {
      const text = await file.text();
      const rows = parseCsvRows(text).map((row) => ({
        resource:
          row.resource ||
          row.resource_key ||
          row.resourcekey ||
          row.entity ||
          "",
        action: row.action || "execute",
        role: row.role || row.role_name || row.rolename || "",
        raciType: (row.racitype || row.raci_type || "-").toUpperCase(),
        category: row.category || "",
      }));

      const validRows = rows.filter((row) => {
        const value = row.raciType as RaciCellValue;
        return row.resource && row.role && ACCEPTED_RACI.has(value);
      });

      if (validRows.length === 0) {
        toast({
          title: "No valid CSV rows",
          description: "Use columns: resource, action, role, raciType, category.",
          variant: "destructive",
        });
        return;
      }

      setImportingCsv(true);
      try {
        const response = await runEditor("import_csv", { rows: validRows });
        applyResponsePayload(response);
        toast({
          title: "CSV imported",
          description: `${response.importedCount ?? validRows.length} row${(response.importedCount ?? validRows.length) === 1 ? "" : "s"} imported.`,
        });
      } catch (error) {
        toast({
          title: "CSV import failed",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        });
      } finally {
        setImportingCsv(false);
      }
    },
    [applyResponsePayload, runEditor, toast],
  );

  const onCsvFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;
    await handleCsvImport(file);
  };

  const toggleCategory = (category: string) => {
    setCollapsedCategories((prev) => ({
      ...prev,
      [category]: !prev[category],
    }));
  };

  const totalRules = payload.cells.length;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">RACI Access Matrix</h1>
          <p className="text-sm text-muted-foreground">
            Define who can do what with your data. R = Responsible (executes), A = Accountable (approves), C = Consulted (view only), I = Informed (notified).
          </p>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{payload.roles.length} roles</Badge>
            <Badge variant="outline">{payload.resources.length} resources</Badge>
            <Badge variant="outline">{totalRules} assignments</Badge>
            {tenantId ? <Badge className="border-0 bg-emerald-100 text-emerald-700">Realtime connected</Badge> : null}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/dashboard/raci/roles">Manage Roles</Link>
          </Button>
          <Button onClick={() => setShowAddRule((prev) => !prev)} className="bg-violet-600 hover:bg-violet-700">
            <Plus className="mr-2 h-4 w-4" />
            Add Rule
          </Button>
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={importingCsv || working}
          >
            <FileUp className="mr-2 h-4 w-4" />
            {importingCsv ? "Importing..." : "Import CSV"}
          </Button>
          <Button variant="outline" onClick={handleValidate} disabled={working || loading}>
            <ShieldCheck className="mr-2 h-4 w-4" />
            Quick Validate
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".csv,text/csv"
            onChange={(event) => {
              void onCsvFileChange(event);
            }}
          />
        </div>
      </div>

      <div className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900">
        Persisted in real time to Supabase `raci_matrix`. Cell clicks cycle <span className="font-semibold">R → A → C → I → -</span>.
      </div>

      {showAddRole ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <Input
              value={newRoleName}
              onChange={(event) => setNewRoleName(event.target.value)}
              placeholder="Role name (e.g. finance_manager)"
              className="md:max-w-xs"
            />
            <div className="flex gap-2">
              <Button onClick={() => void handleAddRole()} disabled={working} className="bg-violet-600 hover:bg-violet-700">
                Add Role
              </Button>
              <Button variant="outline" onClick={() => setShowAddRole(false)} disabled={working}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <Button variant="outline" onClick={() => setShowAddRole(true)} className="w-fit">
          <Plus className="mr-2 h-4 w-4" />
          Add Role
        </Button>
      )}

      {showAddRule ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="grid gap-3 md:grid-cols-4">
            <Input
              value={newResourceKey}
              onChange={(event) => setNewResourceKey(event.target.value)}
              placeholder="resource_key"
            />
            <Input value={newAction} onChange={(event) => setNewAction(event.target.value)} placeholder="action" />
            <select
              value={newCategory}
              onChange={(event) => setNewCategory(event.target.value)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <Button onClick={() => void handleAddRule()} disabled={working} className="bg-violet-600 hover:bg-violet-700">
                Save
              </Button>
              <Button variant="outline" onClick={() => setShowAddRule(false)} disabled={working}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {validation ? (
        <div
          className={cn(
            "rounded-xl border px-4 py-3 text-sm",
            validation.issuesCount === 0
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-amber-200 bg-amber-50 text-amber-900",
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="font-medium">
              Validation Summary: {validation.compliantResources}/{validation.totalResources} compliant
            </p>
            <Badge className={validation.issuesCount === 0 ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"}>
              {validation.issuesCount} issue{validation.issuesCount === 1 ? "" : "s"}
            </Badge>
          </div>
          {validation.issues.length > 0 ? (
            <div className="mt-3 space-y-1">
              {validation.issues.slice(0, 6).map((issue) => (
                <p key={`${issue.resourceKey}-${issue.action}-${issue.issue}`} className="text-xs">
                  <span className="font-semibold">{issue.resourceLabel}</span> ({issue.action}): {issue.issue}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : payload.resources.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center text-sm text-slate-500">
          No resources available yet. Add a rule resource to start building your RACI matrix.
        </div>
      ) : (
        <>
          <div className="hidden overflow-auto rounded-xl border border-slate-200 bg-white shadow-sm md:block">
            <table className="min-w-full border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="sticky left-0 top-0 z-20 w-72 border-r border-slate-200 bg-slate-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Resource / Action
                  </th>
                  {payload.roles.map((role) => (
                    <th key={role.name} className="top-0 z-10 min-w-[128px] bg-slate-50 px-3 py-3 text-center text-xs font-semibold uppercase tracking-wide text-slate-600 sticky">
                      <div className="group inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void handleRenameRole(role.name)}
                          className="max-w-[90px] truncate rounded px-1 py-0.5 text-xs hover:bg-slate-200"
                          title="Rename role"
                        >
                          {role.displayName}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteRole(role.name)}
                          className="rounded p-0.5 text-slate-400 opacity-0 transition group-hover:opacity-100 hover:bg-rose-100 hover:text-rose-600"
                          title="Delete role"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {resourcesByCategory.map((group) => {
                  const collapsed = Boolean(collapsedCategories[group.category]);
                  return (
                    <Fragment key={`group-fragment-${group.category}`}>
                      <tr key={`group-${group.category}`} className="border-b border-slate-200 bg-slate-100/80">
                        <td
                          colSpan={Math.max(payload.roles.length + 1, 2)}
                          className="sticky left-0 z-[1] bg-slate-100/80 px-3 py-2"
                        >
                          <button
                            type="button"
                            className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700"
                            onClick={() => toggleCategory(group.category)}
                          >
                            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            {group.category}
                            <Badge variant="outline">{group.resources.length}</Badge>
                          </button>
                        </td>
                      </tr>

                      {!collapsed
                        ? group.resources.map((resource) => (
                            <tr key={`${group.category}-${resource.resourceKey}-${resource.action}`} className="border-b border-slate-100 hover:bg-slate-50/70">
                              <td className="sticky left-0 z-[1] border-r border-slate-200 bg-white px-4 py-3 align-middle">
                                <div className="text-sm font-semibold text-slate-900">{resource.resourceLabel}</div>
                                <div className="text-xs text-slate-500">{resource.action}</div>
                              </td>
                              {payload.roles.map((role) => {
                                const value = getCellValue(resource.resourceKey, resource.action, role.name);
                                const key = resourceCellKey(resource.resourceKey, resource.action, role.name);
                                const isSaving = savingCellKey === key;
                                return (
                                  <td key={key} className="px-3 py-3 text-center">
                                    <button
                                      type="button"
                                      disabled={Boolean(savingCellKey) || working}
                                      onClick={() => void handleCellClick(resource.resourceKey, resource.action, role.name)}
                                      className={cn(
                                        "inline-flex h-8 w-8 items-center justify-center rounded-md border text-xs font-semibold transition",
                                        isSaving ? "animate-pulse border-violet-300 bg-violet-100 text-violet-700" : cellClassMap[value],
                                      )}
                                    >
                                      {isSaving ? "..." : value}
                                    </button>
                                  </td>
                                );
                              })}
                            </tr>
                          ))
                        : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="space-y-4 md:hidden">
            {resourcesByCategory.map((group) => {
              const collapsed = Boolean(collapsedCategories[group.category]);
              return (
                <div key={`mobile-${group.category}`} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between text-left"
                    onClick={() => toggleCategory(group.category)}
                  >
                    <span className="text-sm font-semibold text-slate-800">{group.category}</span>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{group.resources.length}</Badge>
                      {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </div>
                  </button>

                  {!collapsed ? (
                    <div className="mt-3 space-y-3">
                      {group.resources.map((resource) => (
                        <div key={`mobile-card-${resource.resourceKey}-${resource.action}`} className="rounded-lg border border-slate-200 p-3">
                          <div className="mb-2">
                            <p className="text-sm font-semibold text-slate-900">{resource.resourceLabel}</p>
                            <p className="text-xs text-slate-500">Action: {resource.action}</p>
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            {payload.roles.map((role) => {
                              const value = getCellValue(resource.resourceKey, resource.action, role.name);
                              const key = resourceCellKey(resource.resourceKey, resource.action, role.name);
                              const isSaving = savingCellKey === key;
                              return (
                                <button
                                  key={`mobile-${key}`}
                                  type="button"
                                  disabled={Boolean(savingCellKey) || working}
                                  onClick={() => void handleCellClick(resource.resourceKey, resource.action, role.name)}
                                  className={cn(
                                    "flex items-center justify-between rounded-md border px-2 py-1.5 text-xs",
                                    isSaving ? "border-violet-300 bg-violet-100 text-violet-700" : "border-slate-200",
                                  )}
                                >
                                  <span className="truncate">{role.displayName}</span>
                                  <span className={cn("ml-2 rounded px-1.5 py-0.5 font-semibold", raciBadgeClass[value])}>
                                    {isSaving ? "..." : value}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
        <div className="flex items-center gap-2 text-slate-700">
          <AlertCircle className="h-4 w-4" />
          <span className="font-medium">CSV import format</span>
        </div>
        <p className="mt-1">Headers: resource, action, role, raciType, category</p>
        <p className="mt-1">Example: inventory, update, manager, R, Inventory</p>
        <p className="mt-1 flex items-center gap-1 text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Use uppercase R/A/C/I for `raciType`.
        </p>
      </div>
    </div>
  );
}
