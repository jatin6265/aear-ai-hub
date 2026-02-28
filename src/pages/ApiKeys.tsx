import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { CheckCircle2, ChevronDown, ChevronRight, Copy, KeyRound, Loader2, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdge } from "@/lib/edge-invoke";
import { cn } from "@/lib/utils";

type ApiKeyScope = "read" | "write" | "admin" | "billing";
type ApiKeyEnvironment = "production" | "development" | "testing";
type ExpiryMode = "never" | "30_days" | "90_days" | "1_year" | "custom";
type ApiKeyStatus = "active" | "revoked";

type ApiKeyUsage = {
  requestsToday: number;
  requestsTotal: number;
  endpointsCalled: string[];
};

type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  environment: ApiKeyEnvironment;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  status: ApiKeyStatus;
  usage: ApiKeyUsage;
};

type ApiKeysPayload = {
  profileRole: string;
  canManage: boolean;
  keys: ApiKeyRow[];
};

type CreatedKey = {
  keyId: string;
  key: string;
  keyPrefix: string;
  createdAt: string;
  environment: ApiKeyEnvironment;
  expiresAt: string | null;
  scopes: ApiKeyScope[];
};

const EMPTY_PAYLOAD: ApiKeysPayload = {
  profileRole: "member",
  canManage: false,
  keys: [],
};

const SCOPE_OPTIONS: Array<{ key: ApiKeyScope; label: string; description: string }> = [
  { key: "read", label: "Read", description: "Query data, get insights" },
  { key: "write", label: "Write", description: "Execute actions" },
  { key: "admin", label: "Admin", description: "Manage connections, RACI" },
  { key: "billing", label: "Billing", description: "View invoices, usage" },
];

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

function normalizePayload(value: unknown): ApiKeysPayload {
  const raw = asRecord(value);
  if (!raw) return EMPTY_PAYLOAD;

  const keys = Array.isArray(raw.keys)
    ? raw.keys
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const id = String(row.id ?? "").trim();
          if (!id) return null;

          const usage = asRecord(row.usage);
          const scopes = Array.isArray(row.scopes)
            ? row.scopes
                .map((scope) => String(scope ?? "").toLowerCase().trim())
                .filter((scope): scope is ApiKeyScope =>
                  scope === "read" || scope === "write" || scope === "admin" || scope === "billing",
                )
            : [];

          return {
            id,
            name: String(row.name ?? "Untitled key"),
            prefix: String(row.prefix ?? ""),
            scopes,
            environment: (["production", "development", "testing"].includes(String(row.environment ?? "").toLowerCase())
              ? String(row.environment).toLowerCase()
              : "production") as ApiKeyEnvironment,
            createdAt: String(row.createdAt ?? ""),
            lastUsedAt: row.lastUsedAt ? String(row.lastUsedAt) : null,
            expiresAt: row.expiresAt ? String(row.expiresAt) : null,
            revokedAt: row.revokedAt ? String(row.revokedAt) : null,
            status: String(row.status ?? "active").toLowerCase() === "revoked" ? "revoked" : "active",
            usage: {
              requestsToday: Number(usage?.requestsToday ?? 0) || 0,
              requestsTotal: Number(usage?.requestsTotal ?? 0) || 0,
              endpointsCalled: Array.isArray(usage?.endpointsCalled)
                ? usage.endpointsCalled.map((endpoint) => String(endpoint ?? "")).filter((endpoint) => endpoint.trim().length > 0)
                : [],
            },
          } satisfies ApiKeyRow;
        })
        .filter((row): row is ApiKeyRow => Boolean(row))
    : [];

  return {
    profileRole: String(raw.profileRole ?? "member"),
    canManage: raw.canManage === true,
    keys,
  };
}

function formatRelativeTime(value: string | null) {
  if (!value) return "Never";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "Never";
  const diff = Date.now() - then;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatPrefix(prefix: string) {
  if (!prefix) return "-";
  return `${prefix}...`;
}

function statusClass(status: ApiKeyStatus) {
  if (status === "active") return "border-0 bg-emerald-100 text-emerald-700";
  return "border-0 bg-rose-100 text-rose-700";
}

function scopeBadgeClass(scope: ApiKeyScope) {
  if (scope === "read") return "border-0 bg-blue-100 text-blue-700";
  if (scope === "write") return "border-0 bg-violet-100 text-violet-700";
  if (scope === "admin") return "border-0 bg-amber-100 text-amber-700";
  return "border-0 bg-slate-200 text-slate-700";
}

export default function ApiKeys() {
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [payload, setPayload] = useState<ApiKeysPayload>(EMPTY_PAYLOAD);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [sessionSecrets, setSessionSecrets] = useState<Record<string, string>>({});

  const [createOpen, setCreateOpen] = useState(false);
  const [createStep, setCreateStep] = useState<"form" | "reveal">("form");
  const [createName, setCreateName] = useState("");
  const [createEnvironment, setCreateEnvironment] = useState<ApiKeyEnvironment>("production");
  const [createScopes, setCreateScopes] = useState<Record<ApiKeyScope, boolean>>({
    read: true,
    write: false,
    admin: false,
    billing: false,
  });
  const [createExpiryMode, setCreateExpiryMode] = useState<ExpiryMode>("never");
  const [createCustomDate, setCreateCustomDate] = useState("");

  const [revealedKey, setRevealedKey] = useState<CreatedKey | null>(null);
  const [ackSaved, setAckSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await invokeEdge("api-keys-management", {
        body: {
          operation: "get_payload",
        },
      });

      if (error) throw error;
      const next = normalizePayload((asRecord(data)?.payload as unknown) ?? null);
      setPayload(next);
    } catch (error) {
      toast({
        title: "Could not load API keys",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const canManage = payload.canManage;

  const selectedScopes = useMemo(
    () =>
      (Object.entries(createScopes)
        .filter((entry) => entry[1])
        .map((entry) => entry[0]) as ApiKeyScope[]),
    [createScopes],
  );

  const handleCreateOpenChange = (open: boolean) => {
    if (!open && createStep === "reveal" && !ackSaved) {
      toast({
        title: "Save your key first",
        description: "Confirm you have saved the key securely before closing.",
        variant: "destructive",
      });
      return;
    }

    setCreateOpen(open);

    if (!open) {
      setCreateStep("form");
      setCreateName("");
      setCreateEnvironment("production");
      setCreateScopes({ read: true, write: false, admin: false, billing: false });
      setCreateExpiryMode("never");
      setCreateCustomDate("");
      setRevealedKey(null);
      setAckSaved(false);
    }
  };

  const generateKey = async () => {
    if (!canManage) return;

    const name = createName.trim();
    if (!name) {
      toast({
        title: "Key name required",
        description: "Provide a descriptive label.",
        variant: "destructive",
      });
      return;
    }

    if (selectedScopes.length === 0) {
      toast({
        title: "Select at least one scope",
        description: "A key must include one or more scopes.",
        variant: "destructive",
      });
      return;
    }

    if (createExpiryMode === "custom" && !createCustomDate) {
      toast({
        title: "Custom expiry date required",
        description: "Pick a custom expiry date or select another expiry mode.",
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    try {
      const { data, error } = await invokeEdge("api-keys-management", {
        body: {
          operation: "create_key",
          name,
          environment: createEnvironment,
          scopes: selectedScopes,
          expiryMode: createExpiryMode,
          customExpiryDate: createCustomDate || null,
        },
      });

      if (error) throw error;

      const created = asRecord(data)?.created;
      const createdKeyId = String(asRecord(created)?.keyId ?? "").trim();
      const createdKey = String(asRecord(created)?.key ?? "").trim();

      if (!createdKeyId || !createdKey) {
        throw new Error("Create key response did not include the one-time secret");
      }

      const nextPayload = normalizePayload((asRecord(data)?.payload as unknown) ?? null);
      setPayload(nextPayload);
      setSessionSecrets((prev) => ({
        ...prev,
        [createdKeyId]: createdKey,
      }));

      setRevealedKey({
        keyId: createdKeyId,
        key: createdKey,
        keyPrefix: String(asRecord(created)?.keyPrefix ?? "").trim(),
        createdAt: String(asRecord(created)?.createdAt ?? new Date().toISOString()),
        environment: createEnvironment,
        expiresAt: asRecord(created)?.expiresAt ? String(asRecord(created)?.expiresAt) : null,
        scopes: selectedScopes,
      });

      setCreateStep("reveal");
      setAckSaved(false);

      toast({
        title: "API key generated",
        description: "Copy the key now. It will never be shown again.",
      });
    } catch (error) {
      toast({
        title: "Could not generate key",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async (row: ApiKeyRow) => {
    const fullSecret = sessionSecrets[row.id];
    const valueToCopy = fullSecret || row.prefix;

    try {
      await navigator.clipboard.writeText(valueToCopy);

      toast({
        title: fullSecret ? "Key copied" : "Prefix copied",
        description: fullSecret
          ? "Full API key copied to clipboard."
          : "Only key prefix is available now. Full key is shown only once at creation.",
      });
    } catch {
      toast({
        title: "Copy failed",
        description: "Clipboard permission denied.",
        variant: "destructive",
      });
    }
  };

  const revokeKey = async (keyId: string) => {
    if (!canManage) return;

    const confirmed = window.confirm("Revoke this key? This action cannot be undone.");
    if (!confirmed) return;

    setRevokingId(keyId);
    try {
      const { data, error } = await invokeEdge("api-keys-management", {
        body: {
          operation: "revoke_key",
          keyId,
        },
      });
      if (error) throw error;

      const nextPayload = normalizePayload((asRecord(data)?.payload as unknown) ?? null);
      setPayload(nextPayload);

      toast({
        title: "API key revoked",
      });
    } catch (error) {
      toast({
        title: "Could not revoke key",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setRevokingId(null);
    }
  };

  const copyRevealedKey = async () => {
    if (!revealedKey?.key) return;
    try {
      await navigator.clipboard.writeText(revealedKey.key);
      toast({
        title: "Key copied",
        description: "Store it in your secrets manager now.",
      });
    } catch {
      toast({
        title: "Copy failed",
        description: "Clipboard permission denied.",
        variant: "destructive",
      });
    }
  };

  const activeCount = useMemo(() => payload.keys.filter((key) => key.status === "active").length, [payload.keys]);

  return (
    <div className="space-y-6 animate-fade-in">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">API Keys</h1>
          <p className="mt-1 text-sm text-slate-600">Use API keys to integrate OpsAI into your own applications.</p>
        </div>

        <Button onClick={() => setCreateOpen(true)} disabled={!canManage} className="gap-2 bg-violet-600 hover:bg-violet-700">
          <Plus className="h-4 w-4" />
          Create New Key
        </Button>
      </header>

      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Badge className="border-0 bg-slate-200 text-slate-700">{activeCount} active keys</Badge>
        {!canManage ? <Badge className="border-0 bg-amber-100 text-amber-700">Read only</Badge> : null}
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[280px]">Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last Used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 4 }).map((_, index) => (
                  <TableRow key={`api-key-skeleton-${index}`}>
                    <TableCell><Skeleton className="h-4 w-44" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                    <TableCell><Skeleton className="h-6 w-16" /></TableCell>
                    <TableCell><div className="ml-auto flex w-fit gap-2"><Skeleton className="h-8 w-20" /><Skeleton className="h-8 w-20" /></div></TableCell>
                  </TableRow>
                ))
              ) : payload.keys.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-sm text-slate-500">
                    No API keys created yet.
                  </TableCell>
                </TableRow>
              ) : (
                payload.keys.map((row) => {
                  const expanded = expandedRows[row.id] === true;
                  return (
                    <Fragment key={row.id}>
                      <TableRow className="align-top">
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              className="rounded border border-slate-200 p-1 text-slate-500 hover:bg-slate-100"
                              onClick={() =>
                                setExpandedRows((prev) => ({
                                  ...prev,
                                  [row.id]: !prev[row.id],
                                }))
                              }
                              aria-label={expanded ? "Collapse usage" : "Expand usage"}
                            >
                              {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            </button>
                            <div>
                              <p className="font-medium text-slate-900">{row.name}</p>
                              <p className="text-xs text-slate-500 capitalize">{row.environment}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <code className="rounded bg-slate-100 px-2 py-1 text-xs">{formatPrefix(row.prefix)}</code>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1.5">
                            {row.scopes.length === 0 ? (
                              <span className="text-xs text-slate-500">-</span>
                            ) : (
                              row.scopes.map((scope) => (
                                <Badge key={`${row.id}-${scope}`} className={cn("capitalize", scopeBadgeClass(scope))}>
                                  {scope}
                                </Badge>
                              ))
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-slate-700">
                          {row.createdAt ? format(new Date(row.createdAt), "MMM d, yyyy") : "-"}
                        </TableCell>
                        <TableCell className="text-sm text-slate-700">{formatRelativeTime(row.lastUsedAt)}</TableCell>
                        <TableCell>
                          <Badge className={cn("capitalize", statusClass(row.status))}>{row.status === "active" ? "Active" : "Revoked"}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => void handleCopy(row)} className="gap-1">
                              <Copy className="h-3.5 w-3.5" />
                              Copy
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="gap-1 border-rose-200 text-rose-700 hover:bg-rose-50"
                              disabled={!canManage || row.status === "revoked" || revokingId === row.id}
                              onClick={() => void revokeKey(row.id)}
                            >
                              {revokingId === row.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                              Revoke
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>

                      {expanded ? (
                        <TableRow>
                          <TableCell colSpan={7} className="bg-slate-50">
                            <div className="grid gap-3 md:grid-cols-3">
                              <div className="rounded-lg border border-slate-200 bg-white p-3">
                                <p className="text-xs uppercase tracking-wide text-slate-500">Requests Today</p>
                                <p className="mt-1 text-xl font-semibold text-slate-900">{row.usage.requestsToday.toLocaleString()}</p>
                              </div>
                              <div className="rounded-lg border border-slate-200 bg-white p-3">
                                <p className="text-xs uppercase tracking-wide text-slate-500">Requests Total</p>
                                <p className="mt-1 text-xl font-semibold text-slate-900">{row.usage.requestsTotal.toLocaleString()}</p>
                              </div>
                              <div className="rounded-lg border border-slate-200 bg-white p-3">
                                <p className="text-xs uppercase tracking-wide text-slate-500">Endpoints Called</p>
                                {row.usage.endpointsCalled.length === 0 ? (
                                  <p className="mt-1 text-sm text-slate-500">No endpoint usage yet.</p>
                                ) : (
                                  <div className="mt-1 flex flex-wrap gap-1.5">
                                    {row.usage.endpointsCalled.slice(0, 8).map((endpoint) => (
                                      <code key={`${row.id}-${endpoint}`} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                                        {endpoint}
                                      </code>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <Dialog open={createOpen} onOpenChange={handleCreateOpenChange}>
        <DialogContent className="max-w-xl">
          {createStep === "form" ? (
            <>
              <DialogHeader>
                <DialogTitle>Create New Key</DialogTitle>
                <DialogDescription>Generate a key for secure API integration.</DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="api-key-name">Key Name</Label>
                  <Input
                    id="api-key-name"
                    value={createName}
                    onChange={(event) => setCreateName(event.target.value)}
                    placeholder="Production Backend Integration"
                    disabled={saving}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>Environment</Label>
                  <Select value={createEnvironment} onValueChange={(value) => setCreateEnvironment(value as ApiKeyEnvironment)} disabled={saving}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="production">Production</SelectItem>
                      <SelectItem value="development">Development</SelectItem>
                      <SelectItem value="testing">Testing</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Scopes</Label>
                  <div className="space-y-2 rounded-lg border border-slate-200 p-3">
                    {SCOPE_OPTIONS.map((scope) => (
                      <label key={scope.key} className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-slate-50">
                        <Checkbox
                          checked={createScopes[scope.key]}
                          onCheckedChange={(checked) =>
                            setCreateScopes((prev) => ({
                              ...prev,
                              [scope.key]: checked === true,
                            }))
                          }
                          disabled={saving}
                        />
                        <span>
                          <span className="block text-sm font-medium text-slate-900">{scope.label}</span>
                          <span className="block text-xs text-slate-600">{scope.description}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Expiry</Label>
                    <Select value={createExpiryMode} onValueChange={(value) => setCreateExpiryMode(value as ExpiryMode)} disabled={saving}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="never">Never</SelectItem>
                        <SelectItem value="30_days">30 days</SelectItem>
                        <SelectItem value="90_days">90 days</SelectItem>
                        <SelectItem value="1_year">1 year</SelectItem>
                        <SelectItem value="custom">Custom date</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label>Custom Date</Label>
                    <Input
                      type="date"
                      value={createCustomDate}
                      onChange={(event) => setCreateCustomDate(event.target.value)}
                      disabled={saving || createExpiryMode !== "custom"}
                    />
                  </div>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => handleCreateOpenChange(false)} disabled={saving}>
                  Cancel
                </Button>
                <Button onClick={() => void generateKey()} disabled={saving || !canManage} className="bg-violet-600 hover:bg-violet-700">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                  Generate Key
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Copy Your API Key</DialogTitle>
                <DialogDescription>This is shown only once. Save it securely now.</DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  <div className="flex items-start gap-2">
                    <ShieldAlert className="mt-0.5 h-4 w-4" />
                    <p>
                      <span className="font-semibold">Warning:</span> Copy this key now. It will never be shown again.
                    </p>
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <code className="block break-all font-mono text-sm text-slate-900">{revealedKey?.key ?? ""}</code>
                </div>

                <Button onClick={() => void copyRevealedKey()} className="w-full gap-2 bg-violet-600 hover:bg-violet-700">
                  <Copy className="h-4 w-4" />
                  Copy to clipboard
                </Button>

                <label className="flex items-start gap-2 rounded border border-slate-200 p-3">
                  <Checkbox checked={ackSaved} onCheckedChange={(checked) => setAckSaved(checked === true)} />
                  <span className="text-sm text-slate-700">I have saved this key securely</span>
                </label>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => void copyRevealedKey()}>
                  Copy Again
                </Button>
                <Button
                  onClick={() => handleCreateOpenChange(false)}
                  disabled={!ackSaved}
                  className="bg-emerald-600 hover:bg-emerald-700"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Done
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
