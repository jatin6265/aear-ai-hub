import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, Plus, Search, Sparkles, Trash2, Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdge } from "@/lib/edge-invoke";

type RoleMember = {
  id: string;
  fullName: string;
  email: string | null;
  avatarUrl: string | null;
};

type PermissionPreview = {
  resource: string;
  action: string;
  raciType: "R" | "A" | "C" | "I";
};

type RaciRoleCard = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  icon: string;
  memberCount: number;
  memberIds: string[];
  members: RoleMember[];
  responsibleCount: number;
  accountableCount: number;
  permissionPreview: PermissionPreview[];
};

type WorkspaceMember = {
  id: string;
  fullName: string;
  email: string | null;
  avatarUrl: string | null;
  defaultRole: string | null;
};

type RoleTemplate = {
  key: string;
  name: string;
  icon: string;
  description: string;
  defaults: PermissionPreview[];
};

type Payload = {
  roles: RaciRoleCard[];
  members: WorkspaceMember[];
  templates: RoleTemplate[];
};

type Operation = "get_payload" | "upsert_role" | "apply_template" | "delete_role";

type RoleFormState = {
  roleName: string;
  description: string;
  icon: string;
  memberIds: string[];
};

const ICON_OPTIONS = ["💰", "⚙️", "📦", "📋", "📊", "🛡️", "🤖", "🔍", "🧠", "🧾", "🏢", "👤"];

function normalizeText(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function toArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function inferredIcon(name: string) {
  const lower = name.toLowerCase();
  if (/(finance|billing|revenue|cfo|account)/.test(lower)) return "💰";
  if (/(ops|operation|supply|warehouse)/.test(lower)) return "⚙️";
  if (/(hr|people|talent)/.test(lower)) return "📦";
  if (/(admin|it|security|infra)/.test(lower)) return "🛡️";
  if (/(suite|executive|ceo|cto|board)/.test(lower)) return "📊";
  return "👤";
}

function normalizePermissionPreview(raw: unknown): PermissionPreview[] {
  return toArray(raw)
    .map((value) => {
      const item = value as Record<string, unknown>;
      const resource = normalizeText(item.resource);
      const action = normalizeText(item.action, "execute");
      const raciType = normalizeText(item.raciType).toUpperCase();
      if (!resource || !["R", "A", "C", "I"].includes(raciType)) return null;
      return { resource, action, raciType: raciType as PermissionPreview["raciType"] };
    })
    .filter((item): item is PermissionPreview => item !== null);
}

function normalizeRoleMembers(raw: unknown): RoleMember[] {
  return toArray(raw)
    .map((value) => {
      const item = value as Record<string, unknown>;
      const id = normalizeText(item.id);
      if (!id) return null;
      return {
        id,
        fullName: normalizeText(item.fullName, `User ${id.slice(0, 8)}`),
        email: normalizeText(item.email, "") || null,
        avatarUrl: normalizeText(item.avatarUrl, "") || null,
      };
    })
    .filter((item): item is RoleMember => item !== null);
}

function normalizePayload(rawPayload: unknown): Payload {
  const raw = (rawPayload ?? {}) as Record<string, unknown>;

  const roles: RaciRoleCard[] = toArray(raw.roles)
    .map((value) => {
      const role = value as Record<string, unknown>;
      const id = normalizeText(role.id);
      const name = normalizeText(role.name).toLowerCase();
      if (!id || !name) return null;
      const displayName = normalizeText(role.displayName, name.replaceAll("_", " "));
      const icon = normalizeText(role.icon, inferredIcon(name));
      return {
        id,
        name,
        displayName,
        description: normalizeText(role.description, "") || null,
        icon,
        memberCount: Number(role.memberCount ?? 0),
        memberIds: toArray(role.memberIds).map((memberId) => String(memberId)),
        members: normalizeRoleMembers(role.members),
        responsibleCount: Number(role.responsibleCount ?? 0),
        accountableCount: Number(role.accountableCount ?? 0),
        permissionPreview: normalizePermissionPreview(role.permissionPreview),
      };
    })
    .filter((item): item is RaciRoleCard => item !== null);

  const members: WorkspaceMember[] = toArray(raw.members)
    .map((value) => {
      const member = value as Record<string, unknown>;
      const id = normalizeText(member.id);
      if (!id) return null;
      return {
        id,
        fullName: normalizeText(member.fullName, `User ${id.slice(0, 8)}`),
        email: normalizeText(member.email, "") || null,
        avatarUrl: normalizeText(member.avatarUrl, "") || null,
        defaultRole: normalizeText(member.defaultRole, "") || null,
      };
    })
    .filter((item): item is WorkspaceMember => item !== null);

  const templates: RoleTemplate[] = toArray(raw.templates)
    .map((value) => {
      const template = value as Record<string, unknown>;
      const key = normalizeText(template.key).toLowerCase();
      if (!key) return null;
      return {
        key,
        name: normalizeText(template.name, key.replaceAll("_", " ")),
        icon: normalizeText(template.icon, inferredIcon(key)),
        description: normalizeText(template.description),
        defaults: normalizePermissionPreview(template.defaults),
      };
    })
    .filter((item): item is RoleTemplate => item !== null);

  return { roles, members, templates };
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

function initials(name: string) {
  const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "U";
}

function roleSummary(role: RaciRoleCard) {
  return `Responsible for ${role.responsibleCount} resources, Accountable for ${role.accountableCount}`;
}

export default function RaciRoles() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [payload, setPayload] = useState<Payload>({ roles: [], members: [], templates: [] });
  const [query, setQuery] = useState("");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<RaciRoleCard | null>(null);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState<string | null>(null);
  const [form, setForm] = useState<RoleFormState>({
    roleName: "",
    description: "",
    icon: "👤",
    memberIds: [],
  });
  const [memberSearch, setMemberSearch] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);

  const runRpcFallback = useCallback(async (operation: Operation, args: Record<string, unknown>) => {
    if (operation === "get_payload") {
      const { data, error } = await supabase.rpc("get_raci_role_management_payload");
      if (error) throw error;
      return { payload: data };
    }

    if (operation === "upsert_role") {
      const { error } = await supabase.rpc("upsert_raci_role_management", {
        p_role_name: args.roleName,
        p_description: args.description,
        p_icon: args.icon,
        p_member_ids: args.memberIds,
        p_previous_role_name: args.previousRoleName,
      });
      if (error) throw error;
    }

    if (operation === "apply_template") {
      const { error } = await supabase.rpc("apply_raci_role_template", {
        p_template_key: args.templateKey,
        p_role_name: args.roleName,
        p_member_ids: args.memberIds,
      });
      if (error) throw error;
    }

    if (operation === "delete_role") {
      const { error } = await supabase.rpc("delete_raci_role", {
        p_role_name: args.roleName,
        p_force: true,
      });
      if (error) throw error;
    }

    const next = await runRpcFallback("get_payload", {});
    return { payload: next.payload };
  }, []);

  const runOperation = useCallback(
    async (operation: Operation, args: Record<string, unknown> = {}) => {
      try {
        const { data, error } = await invokeEdge("raci-role-management", {
          body: {
            operation,
            ...args,
          },
        });
        if (error) throw error;
        return data as Record<string, unknown>;
      } catch (error) {
        if (!shouldUseRpcFallback(error)) throw error;
        return (await runRpcFallback(operation, args)) as Record<string, unknown>;
      }
    },
    [runRpcFallback],
  );

  const load = useCallback(async () => {
    if (!user) return;

    setLoading(true);
    try {
      await ensureUserWorkspace(user);
      const response = await runOperation("get_payload");
      setPayload(normalizePayload(response.payload));
    } catch (error) {
      toast({
        title: "Could not load RACI roles",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [runOperation, toast, user]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredRoles = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return payload.roles;
    return payload.roles.filter((role) => {
      return (
        role.displayName.toLowerCase().includes(text) ||
        role.name.toLowerCase().includes(text) ||
        (role.description ?? "").toLowerCase().includes(text)
      );
    });
  }, [payload.roles, query]);

  const selectedTemplate = useMemo(
    () => payload.templates.find((template) => template.key === selectedTemplateKey) ?? null,
    [payload.templates, selectedTemplateKey],
  );

  const previewRules = useMemo(() => {
    if (selectedTemplate) return selectedTemplate.defaults;
    if (editingRole) return editingRole.permissionPreview;
    return [] as PermissionPreview[];
  }, [editingRole, selectedTemplate]);

  const filteredMembers = useMemo(() => {
    const text = memberSearch.trim().toLowerCase();
    if (!text) return payload.members;
    return payload.members.filter((member) => {
      return (
        member.fullName.toLowerCase().includes(text) ||
        (member.email ?? "").toLowerCase().includes(text)
      );
    });
  }, [memberSearch, payload.members]);

  const openCreate = () => {
    setEditingRole(null);
    setSelectedTemplateKey(null);
    setMemberSearch("");
    setShowTemplates(false);
    setForm({ roleName: "", description: "", icon: "👤", memberIds: [] });
    setDialogOpen(true);
  };

  const openEdit = (role: RaciRoleCard) => {
    setEditingRole(role);
    setSelectedTemplateKey(null);
    setMemberSearch("");
    setShowTemplates(false);
    setForm({
      roleName: role.name,
      description: role.description ?? "",
      icon: role.icon || inferredIcon(role.name),
      memberIds: [...role.memberIds],
    });
    setDialogOpen(true);
  };

  const toggleMember = (memberId: string) => {
    setForm((prev) => {
      if (prev.memberIds.includes(memberId)) {
        return { ...prev, memberIds: prev.memberIds.filter((id) => id !== memberId) };
      }
      return { ...prev, memberIds: [...prev.memberIds, memberId] };
    });
  };

  const applyTemplatePrefill = (template: RoleTemplate) => {
    setSelectedTemplateKey(template.key);
    setForm((prev) => ({
      ...prev,
      roleName: template.key,
      description: template.description,
      icon: template.icon,
    }));
  };

  const handleSave = async () => {
    const roleName = form.roleName.trim().toLowerCase();
    if (!roleName) {
      toast({
        title: "Role name is required",
        description: "Enter a role name before saving.",
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    try {
      const args = {
        roleName,
        description: form.description.trim() || null,
        icon: form.icon,
        memberIds: form.memberIds,
        previousRoleName: editingRole?.name ?? null,
      };

      if (selectedTemplateKey && !editingRole) {
        await runOperation("apply_template", {
          templateKey: selectedTemplateKey,
          roleName,
          memberIds: form.memberIds,
        });
      } else {
        await runOperation("upsert_role", args);
      }

      toast({ title: editingRole ? "Role updated" : "Role created" });
      setDialogOpen(false);
      await load();
    } catch (error) {
      toast({
        title: "Could not save role",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteRole = async (role: RaciRoleCard) => {
    const confirmed = window.confirm(`Delete role ${role.displayName}? This removes its RACI assignments.`);
    if (!confirmed) return;

    setSaving(true);
    try {
      await runOperation("delete_role", { roleName: role.name });
      toast({ title: "Role deleted" });
      await load();
    } catch (error) {
      toast({
        title: "Could not delete role",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <Link
            to="/dashboard/raci"
            className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-violet-600 hover:text-violet-700"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to RACI Matrix
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">RACI Role Management</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage governance roles, member assignments, and template defaults.
          </p>
        </div>

        <Button onClick={openCreate} className="bg-violet-600 hover:bg-violet-700">
          <Plus className="mr-2 h-4 w-4" />
          Create Role
        </Button>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:flex-row md:items-center md:justify-between">
        <div className="relative md:w-96">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search roles"
            className="pl-9"
          />
        </div>
        <Button variant="outline" onClick={() => setShowTemplates((prev) => !prev)}>
          <Sparkles className="mr-2 h-4 w-4" />
          Use a template
        </Button>
      </div>

      {showTemplates ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {payload.templates.map((template) => (
            <button
              key={template.key}
              type="button"
              onClick={() => {
                openCreate();
                applyTemplatePrefill(template);
              }}
              className="rounded-xl border border-violet-200 bg-violet-50 p-4 text-left transition hover:border-violet-300 hover:bg-violet-100"
            >
              <p className="text-lg">{template.icon}</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">{template.name}</p>
              <p className="mt-1 text-xs text-slate-600">{template.description}</p>
            </button>
          ))}
        </div>
      ) : null}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="mt-3 h-4 w-44" />
              <Skeleton className="mt-3 h-4 w-32" />
            </div>
          ))}
        </div>
      ) : filteredRoles.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center text-sm text-slate-500">
          No roles found. Create a role or use a template to initialize defaults.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredRoles.map((role) => (
            <article key={role.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-violet-100 text-lg">
                    {role.icon || inferredIcon(role.name)}
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">{role.displayName}</h3>
                    <p className="text-xs text-slate-500">{role.description || "No description"}</p>
                  </div>
                </div>
                <Badge variant="outline" className="border-slate-300 bg-slate-50 text-slate-700">
                  {role.memberCount} member{role.memberCount === 1 ? "" : "s"}
                </Badge>
              </div>

              <div className="mt-3 flex items-center gap-1">
                {role.members.slice(0, 5).map((member) => (
                  <Avatar key={member.id} className="h-7 w-7 border border-white">
                    <AvatarImage src={member.avatarUrl ?? undefined} alt={member.fullName} />
                    <AvatarFallback className="bg-violet-100 text-[10px] font-semibold text-violet-700">
                      {initials(member.fullName)}
                    </AvatarFallback>
                  </Avatar>
                ))}
                {role.memberCount > 5 ? (
                  <span className="ml-1 text-xs text-slate-500">+{role.memberCount - 5}</span>
                ) : null}
              </div>

              <p className="mt-3 text-xs text-slate-600">{roleSummary(role)}</p>

              <div className="mt-4 flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => openEdit(role)} disabled={saving}>
                  Edit Role
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                  onClick={() => void handleDeleteRole(role)}
                  disabled={saving}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  Delete Role
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editingRole ? "Edit Role" : "Create Role"}</DialogTitle>
            <DialogDescription>
              Configure role metadata, icon, members and permissions footprint.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-600">Role Name</label>
                <Input
                  value={form.roleName}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      roleName: event.target.value,
                    }))
                  }
                  placeholder="finance_manager"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-600">Role Icon</label>
                <div className="flex flex-wrap gap-2">
                  {ICON_OPTIONS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setForm((prev) => ({ ...prev, icon: option }))}
                      className={cn(
                        "inline-flex h-9 w-9 items-center justify-center rounded-md border text-lg transition",
                        form.icon === option
                          ? "border-violet-500 bg-violet-100"
                          : "border-slate-200 hover:border-violet-300 hover:bg-violet-50",
                      )}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-600">Role Description</label>
              <Textarea
                value={form.description}
                onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                rows={3}
                placeholder="Describe this role's governance responsibilities"
              />
            </div>

            {!editingRole ? (
              <div className="rounded-lg border border-violet-200 bg-violet-50 p-3">
                <button
                  type="button"
                  className="text-xs font-semibold text-violet-700 underline-offset-2 hover:underline"
                  onClick={() => setShowTemplates((prev) => !prev)}
                >
                  Use a template
                </button>
                <div className="mt-2 flex flex-wrap gap-2">
                  {payload.templates.map((template) => (
                    <button
                      key={`modal-template-${template.key}`}
                      type="button"
                      onClick={() => applyTemplatePrefill(template)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs",
                        selectedTemplateKey === template.key
                          ? "border-violet-500 bg-violet-100 text-violet-700"
                          : "border-violet-200 bg-white text-violet-700 hover:bg-violet-100",
                      )}
                    >
                      <span>{template.icon}</span>
                      <span>{template.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="rounded-lg border border-slate-200 p-3">
              <p className="mb-2 text-xs font-medium text-slate-600">Members assignment</p>
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <Input
                  value={memberSearch}
                  onChange={(event) => setMemberSearch(event.target.value)}
                  className="h-8 pl-8 text-xs"
                  placeholder="Search team members"
                />
              </div>

              <div className="max-h-40 space-y-1 overflow-auto">
                {filteredMembers.map((member) => {
                  const active = form.memberIds.includes(member.id);
                  return (
                    <button
                      key={member.id}
                      type="button"
                      onClick={() => toggleMember(member.id)}
                      className={cn(
                        "flex w-full items-center justify-between rounded-md border px-2 py-1.5 text-left text-xs",
                        active
                          ? "border-violet-300 bg-violet-50"
                          : "border-slate-200 hover:bg-slate-50",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-slate-800">{member.fullName}</span>
                        <span className="block truncate text-slate-500">{member.email ?? member.defaultRole ?? "Member"}</span>
                      </span>
                      {active ? <Check className="h-3.5 w-3.5 text-violet-600" /> : <Users className="h-3.5 w-3.5 text-slate-400" />}
                    </button>
                  );
                })}
                {filteredMembers.length === 0 ? (
                  <p className="px-1 py-3 text-xs text-slate-500">No team members match your search.</p>
                ) : null}
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 p-3">
              <p className="mb-2 text-xs font-medium text-slate-600">Permission preview</p>
              {previewRules.length === 0 ? (
                <p className="text-xs text-slate-500">No RACI rules are associated with this role yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {previewRules.slice(0, 8).map((rule, index) => (
                    <div key={`${rule.resource}-${rule.action}-${rule.raciType}-${index}`} className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1 text-xs">
                      <span className="truncate text-slate-700">
                        {rule.resource} · {rule.action}
                      </span>
                      <Badge
                        className={cn(
                          "border-0",
                          rule.raciType === "R"
                            ? "bg-violet-100 text-violet-700"
                            : rule.raciType === "A"
                              ? "bg-amber-100 text-amber-700"
                              : rule.raciType === "C"
                                ? "bg-blue-100 text-blue-700"
                                : "bg-slate-200 text-slate-700",
                        )}
                      >
                        {rule.raciType}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button className="bg-violet-600 hover:bg-violet-700" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
