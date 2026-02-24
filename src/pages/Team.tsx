import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Mail, Search, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { formatEdgeFunctionError } from "@/lib/edge-function-error";
import { invokeEdge } from "@/lib/edge-invoke";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

type TeamRole = "owner" | "admin" | "manager" | "member" | "viewer";
type MemberStatus = "active" | "suspended";
type StatusFilter = "all" | "active" | "invited" | "suspended";

type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: TeamRole;
  status: MemberStatus;
  lastActiveAt: string | null;
  avatarUrl: string | null;
  isCurrentUser: boolean;
};

type TeamInvitation = {
  id: string;
  email: string;
  role: Exclude<TeamRole, "owner">;
  status: "pending" | "sent";
  invitedAt: string;
  sentAt: string | null;
  expiresAt: string | null;
  customMessage: string | null;
};

type TeamPayload = {
  members: TeamMember[];
  invitations: TeamInvitation[];
  summary: {
    memberCount: number;
    invitationCount: number;
    totalCount: number;
  };
  seats: {
    plan: string;
    used: number;
    limit: number | null;
    remaining: number | null;
    nearLimit: boolean;
  };
};

const DEFAULT_PAYLOAD: TeamPayload = {
  members: [],
  invitations: [],
  summary: {
    memberCount: 0,
    invitationCount: 0,
    totalCount: 0,
  },
  seats: {
    plan: "starter",
    used: 0,
    limit: null,
    remaining: null,
    nearLimit: false,
  },
};

const MANAGEABLE_ROLES: Array<{ value: Exclude<TeamRole, "owner">; label: string }> = [
  { value: "admin", label: "Admin" },
  { value: "manager", label: "Manager" },
  { value: "member", label: "Member" },
  { value: "viewer", label: "Viewer" },
];

function titleCase(value: string) {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "U";
}

function formatRelativeTime(value: string | null) {
  if (!value) return "Never";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";

  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);

  if (diffMinutes < 1) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes} min ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hr ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;

  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths} month${diffMonths === 1 ? "" : "s"} ago`;

  const diffYears = Math.floor(diffMonths / 12);
  return `${diffYears} year${diffYears === 1 ? "" : "s"} ago`;
}

function parseInviteEmails(raw: string) {
  return Array.from(
    new Set(
      raw
        .split(/[\n,;]+/)
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0),
    ),
  );
}

function statusBadgeClass(status: string) {
  if (status === "active") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "suspended") return "border-red-200 bg-red-50 text-red-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}

export default function Team() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [tenantId, setTenantId] = useState<string | null>(null);
  const [payload, setPayload] = useState<TeamPayload>(DEFAULT_PAYLOAD);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmailsRaw, setInviteEmailsRaw] = useState("");
  const [inviteRole, setInviteRole] = useState<Exclude<TeamRole, "owner">>("member");
  const [inviteMessage, setInviteMessage] = useState("");

  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
  const [editRole, setEditRole] = useState<Exclude<TeamRole, "owner">>("member");
  const [editStatus, setEditStatus] = useState<MemberStatus>("active");

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSearchQuery(searchInput.trim());
    }, 280);

    return () => window.clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    if (!user) {
      setTenantId(null);
      setPayload(DEFAULT_PAYLOAD);
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
        const { data, error } = await invokeEdge("team-management", {
          body: {
            operation: "get_payload",
            search: searchQuery,
            roleFilter,
            statusFilter,
          },
        });

        if (error) throw error;
        setPayload((data?.payload as TeamPayload) ?? DEFAULT_PAYLOAD);
      } catch (error) {
        const description = await formatEdgeFunctionError(error, { functionName: "team-management" });
        toast({
          title: "Could not load team",
          description,
          variant: "destructive",
        });
      } finally {
        if (withLoading) setLoading(false);
      }
    },
    [roleFilter, searchQuery, statusFilter, tenantId, toast],
  );

  useEffect(() => {
    void loadPayload(true);
  }, [loadPayload]);

  useEffect(() => {
    if (!tenantId) return;

    const channel = supabase
      .channel(`team-management-${tenantId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "profiles",
          filter: `tenant_id=eq.${tenantId}`,
        },
        () => {
          void loadPayload(false);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "team_invitations",
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
  }, [loadPayload, tenantId]);

  const executeOperation = useCallback(
    async (
      operation: string,
      operationBody: Record<string, unknown>,
      options?: {
        busyKey?: string;
        successTitle?: string;
        successDescription?: string;
      },
    ) => {
      const busyKey = options?.busyKey ?? operation;
      setBusy(busyKey);

      try {
        const { data, error } = await invokeEdge("team-management", {
          body: {
            operation,
            search: searchQuery,
            roleFilter,
            statusFilter,
            ...operationBody,
          },
        });

        if (error) throw error;

        if (data?.payload) {
          setPayload((data.payload as TeamPayload) ?? DEFAULT_PAYLOAD);
        }

        if (options?.successTitle) {
          toast({
            title: options.successTitle,
            description: options.successDescription,
          });
        }

        return data;
      } catch (error) {
        const description = await formatEdgeFunctionError(error, { functionName: "team-management" });
        toast({
          title: "Action failed",
          description,
          variant: "destructive",
        });
        return null;
      } finally {
        setBusy(null);
      }
    },
    [roleFilter, searchQuery, statusFilter, toast],
  );

  const handleRoleChange = async (member: TeamMember, role: Exclude<TeamRole, "owner">) => {
    if (member.role === role) return;

    await executeOperation(
      "update_member_role",
      {
        profileId: member.id,
        role,
      },
      {
        busyKey: `member-role-${member.id}`,
        successTitle: "Role updated",
        successDescription: `${member.name} is now ${titleCase(role)}.`,
      },
    );
  };

  const handleStatusChange = async (member: TeamMember, status: MemberStatus) => {
    if (member.status === status) return;

    await executeOperation(
      "update_member_status",
      {
        profileId: member.id,
        status,
      },
      {
        busyKey: `member-status-${member.id}`,
        successTitle: "Status updated",
        successDescription: `${member.name} is now ${titleCase(status)}.`,
      },
    );
  };

  const handleRemoveMember = async (member: TeamMember) => {
    const confirmed = window.confirm(`Remove ${member.name} from this workspace?`);
    if (!confirmed) return;

    await executeOperation(
      "remove_member",
      {
        profileId: member.id,
      },
      {
        busyKey: `member-remove-${member.id}`,
        successTitle: "Member removed",
        successDescription: `${member.name} has been removed from the workspace.`,
      },
    );
  };

  const handleInvitationAction = async (invitation: TeamInvitation, action: "resend" | "cancel") => {
    await executeOperation(
      "manage_invitation",
      {
        invitationId: invitation.id,
        action,
      },
      {
        busyKey: `invite-${action}-${invitation.id}`,
        successTitle: action === "resend" ? "Invitation resent" : "Invitation cancelled",
      },
    );
  };

  const openMemberEditor = (member: TeamMember) => {
    setEditingMember(member);
    setEditRole((member.role === "owner" ? "admin" : member.role) as Exclude<TeamRole, "owner">);
    setEditStatus(member.status);
  };

  const saveMemberEditor = async () => {
    if (!editingMember) return;

    if (editingMember.role !== "owner" && editRole !== editingMember.role) {
      await handleRoleChange(editingMember, editRole);
    }

    if (editStatus !== editingMember.status) {
      await handleStatusChange(editingMember, editStatus);
    }

    setEditingMember(null);
  };

  const inviteEmails = useMemo(() => parseInviteEmails(inviteEmailsRaw), [inviteEmailsRaw]);

  const sendInvites = async () => {
    if (inviteEmails.length === 0) {
      toast({
        title: "No valid emails",
        description: "Provide at least one valid email address.",
        variant: "destructive",
      });
      return;
    }

    const response = await executeOperation(
      "invite_members",
      {
        emails: inviteEmails,
        role: inviteRole,
        customMessage: inviteMessage,
      },
      {
        busyKey: "invite-members",
      },
    );

    if (!response) return;

    const insertedCount = Number(response?.result?.insertedCount ?? inviteEmails.length);
    const remainingSlots = response?.result?.remainingSlots;

    toast({
      title: "Invitation sent",
      description:
        typeof remainingSlots === "number"
          ? `${insertedCount} invite${insertedCount === 1 ? "" : "s"} queued. ${remainingSlots} seats remaining.`
          : `${insertedCount} invite${insertedCount === 1 ? "" : "s"} queued.`,
    });

    setInviteEmailsRaw("");
    setInviteMessage("");
    setInviteRole("member");
    setInviteOpen(false);
  };

  const showSeatBanner = payload.seats.limit !== null && payload.seats.nearLimit;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">Team Members</h1>
            <Badge variant="outline" className="border-violet-200 bg-violet-50 text-violet-700">
              {payload.summary.memberCount}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Manage users, invitations, roles, and workspace access.</p>
        </div>

        <Button className="gap-2 bg-gradient-to-r from-violet-600 to-indigo-600 text-white hover:from-violet-700 hover:to-indigo-700" onClick={() => setInviteOpen(true)}>
          <UserPlus className="h-4 w-4" />
          Invite Member
        </Button>
      </div>

      {showSeatBanner ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="font-semibold">
            {payload.seats.used}/{payload.seats.limit} seats used.
          </span>{" "}
          Upgrade for unlimited seats.
          <Link to="/dashboard/billing" className="ml-2 inline-flex items-center font-semibold text-amber-900 underline underline-offset-4">
            View plans
          </Link>
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-[1fr_180px_180px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search by name or email"
            className="pl-10"
          />
        </div>

        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger>
            <SelectValue placeholder="Filter by role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All roles</SelectItem>
            <SelectItem value="owner">Owner</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="manager">Manager</SelectItem>
            <SelectItem value="member">Member</SelectItem>
            <SelectItem value="viewer">Viewer</SelectItem>
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
          <SelectTrigger>
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="invited">Invited</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Members</h2>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="hidden md:table-cell">Avatar</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="hidden md:table-cell">Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden md:table-cell">Last Active</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ? Array.from({ length: 6 }).map((_, index) => (
                <TableRow key={`member-skeleton-${index}`}>
                    <TableCell className="hidden md:table-cell">
                      <Skeleton className="h-9 w-9 rounded-full" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-32" />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Skeleton className="h-4 w-40" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-8 w-28" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-6 w-20" />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Skeleton className="h-4 w-20" />
                    </TableCell>
                    <TableCell>
                      <div className="ml-auto flex w-fit gap-2">
                        <Skeleton className="h-8 w-14" />
                        <Skeleton className="h-8 w-20" />
                        <Skeleton className="h-8 w-16" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              : payload.members.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell className="hidden md:table-cell">
                      <Avatar className="h-9 w-9">
                        <AvatarImage src={member.avatarUrl ?? undefined} alt={member.name} />
                        <AvatarFallback>{initials(member.name)}</AvatarFallback>
                      </Avatar>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-900">{member.name}</span>
                        {member.isCurrentUser ? (
                          <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-600">
                            You
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <span className="inline-flex items-center gap-1 text-slate-600">
                        <Mail className="h-3.5 w-3.5" />
                        {member.email || "-"}
                      </span>
                    </TableCell>
                    <TableCell>
                      {member.role === "owner" ? (
                        <Badge variant="outline" className="border-violet-200 bg-violet-50 text-violet-700">
                          Owner
                        </Badge>
                      ) : (
                        <Select
                          value={member.role}
                          onValueChange={(value) => void handleRoleChange(member, value as Exclude<TeamRole, "owner">)}
                          disabled={busy === `member-role-${member.id}`}
                        >
                          <SelectTrigger className="h-11 w-[132px] md:h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {MANAGEABLE_ROLES.map((role) => (
                              <SelectItem key={`${member.id}-${role.value}`} value={role.value}>
                                {role.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("capitalize", statusBadgeClass(member.status))}>
                        {member.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-slate-600">{formatRelativeTime(member.lastActiveAt)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" className="md:hidden" onClick={() => openMemberEditor(member)}>
                          View details
                        </Button>
                        <div className="hidden md:flex md:gap-2">
                          <Button variant="outline" size="sm" onClick={() => openMemberEditor(member)}>
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleStatusChange(member, member.status === "active" ? "suspended" : "active")}
                            disabled={busy === `member-status-${member.id}`}
                          >
                            {member.status === "active" ? "Suspend" : "Activate"}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                            onClick={() => void handleRemoveMember(member)}
                            disabled={busy === `member-remove-${member.id}`}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}

            {!loading && payload.members.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-slate-500">
                  No members found for this filter.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </section>

      <section className="overflow-hidden rounded-xl border border-amber-200 bg-amber-50/70 shadow-sm">
        <div className="border-b border-amber-200 px-5 py-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-900">Pending Invitations</h2>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead className="hidden md:table-cell">Role</TableHead>
              <TableHead className="hidden md:table-cell">Invited</TableHead>
              <TableHead className="hidden md:table-cell">Expires</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ? Array.from({ length: 3 }).map((_, index) => (
                  <TableRow key={`invite-skeleton-${index}`}>
                    <TableCell>
                      <Skeleton className="h-4 w-48" />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Skeleton className="h-6 w-20" />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Skeleton className="h-4 w-20" />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Skeleton className="h-4 w-20" />
                    </TableCell>
                    <TableCell>
                      <div className="ml-auto flex w-fit gap-2">
                        <Skeleton className="h-8 w-16" />
                        <Skeleton className="h-8 w-16" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              : payload.invitations.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell className="font-medium text-slate-900">{invitation.email}</TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Badge variant="outline" className="border-amber-300 bg-amber-100 text-amber-900">
                        {titleCase(invitation.role)}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-slate-700">{formatRelativeTime(invitation.sentAt || invitation.invitedAt)}</TableCell>
                    <TableCell className="hidden md:table-cell text-slate-700">{formatRelativeTime(invitation.expiresAt)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleInvitationAction(invitation, "resend")}
                          disabled={busy === `invite-resend-${invitation.id}`}
                        >
                          Resend
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="border-amber-400 text-amber-900 hover:bg-amber-100"
                          onClick={() => void handleInvitationAction(invitation, "cancel")}
                          disabled={busy === `invite-cancel-${invitation.id}`}
                        >
                          Cancel
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}

            {!loading && payload.invitations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-amber-900/80">
                  No pending invitations.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </section>

      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
        <span className="font-medium">Role permissions are managed in the RACI Matrix</span>
        <Link to="/dashboard/raci" className="ml-2 inline-flex items-center font-semibold text-violet-700 hover:text-violet-800">
          Open RACI Matrix
          <ArrowRight className="ml-1 h-3.5 w-3.5" />
        </Link>
      </div>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Invite Team Members</DialogTitle>
            <DialogDescription>Invite one or multiple users by entering comma-separated emails.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700" htmlFor="invite-emails">
                Emails
              </label>
              <Textarea
                id="invite-emails"
                rows={4}
                placeholder="alex@company.com, sam@company.com"
                value={inviteEmailsRaw}
                onChange={(event) => setInviteEmailsRaw(event.target.value)}
              />
              <p className="text-xs text-slate-500">Detected: {inviteEmails.length} email{inviteEmails.length === 1 ? "" : "s"}</p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Role</label>
              <Select value={inviteRole} onValueChange={(value) => setInviteRole(value as Exclude<TeamRole, "owner">)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MANAGEABLE_ROLES.map((role) => (
                    <SelectItem key={`invite-role-${role.value}`} value={role.value}>
                      {role.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700" htmlFor="invite-message">
                Custom message (optional)
              </label>
              <Textarea
                id="invite-message"
                rows={4}
                maxLength={300}
                placeholder="Welcome to AEAR. Join our workspace to collaborate with AI agents and governed actions."
                value={inviteMessage}
                onChange={(event) => setInviteMessage(event.target.value)}
              />
              <p className="text-right text-xs text-slate-500">{inviteMessage.length}/300</p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-gradient-to-r from-violet-600 to-indigo-600 text-white hover:from-violet-700 hover:to-indigo-700"
              onClick={() => void sendInvites()}
              disabled={busy === "invite-members"}
            >
              Send Invitation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editingMember)} onOpenChange={(open) => (open ? null : setEditingMember(null))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Member</DialogTitle>
            <DialogDescription>Update role and status for this team member.</DialogDescription>
          </DialogHeader>

          {editingMember ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                <p className="font-medium text-slate-900">{editingMember.name}</p>
                <p className="text-slate-600">{editingMember.email}</p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">Role</label>
                {editingMember.role === "owner" ? (
                  <Input value="Owner" disabled />
                ) : (
                  <Select value={editRole} onValueChange={(value) => setEditRole(value as Exclude<TeamRole, "owner">)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MANAGEABLE_ROLES.map((role) => (
                        <SelectItem key={`edit-role-${role.value}`} value={role.value}>
                          {role.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">Status</label>
                <Select value={editStatus} onValueChange={(value) => setEditStatus(value as MemberStatus)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="suspended">Suspended</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingMember(null)}>
              Cancel
            </Button>
            <Button onClick={() => void saveMemberEditor()} disabled={busy !== null}>
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
