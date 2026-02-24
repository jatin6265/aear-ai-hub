import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/service.ts";
import { resolveInviteBaseUrl, sendInviteEmail, sendInviteEmailViaSupabaseAuth } from "../_shared/invite-email.ts";

type Operation =
  | "get_payload"
  | "invite_members"
  | "update_member_role"
  | "update_member_status"
  | "remove_member"
  | "manage_invitation";

function normalizeString(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeEmails(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter((value) => value.length > 0);
  }

  if (typeof input === "string") {
    return input
      .split(/[\n,;]+/)
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);
  }

  return [];
}

function isRpcMissing(error: { code?: string | null; message?: string | null } | null) {
  if (!error) return false;
  const code = String(error.code ?? "");
  const message = String(error.message ?? "").toLowerCase();
  return code === "PGRST202" || message.includes("could not find the function");
}

function isAmbiguousTenantError(error: { code?: string | null; message?: string | null } | null) {
  if (!error) return false;
  const code = String(error.code ?? "");
  const message = String(error.message ?? "").toLowerCase();
  return code === "42702" && message.includes("tenant_id") && message.includes("ambiguous");
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

type TeamPayload = {
  members: Array<Record<string, unknown>>;
  invitations: Array<Record<string, unknown>>;
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

async function sendInvitationEmails(
  req: Request,
  supabase: SupabaseClient,
  userId: string,
  emails: string[],
) {
  if (emails.length === 0) return { sentCount: 0, failures: [] as Array<{ email: string; reason: string }> };

  const { data: me, error: meError } = (await supabase
    .from("profiles")
    .select("tenant_id, full_name")
    .eq("id", userId)
    .maybeSingle()) as { data: { tenant_id?: string; full_name?: string | null } | null; error: { message?: string } | null };
  if (meError || !me?.tenant_id) {
    throw new Error(meError?.message || "Could not resolve inviter profile");
  }

  const { data: tenant, error: tenantError } = (await supabase
    .from("tenants")
    .select("name")
    .eq("id", me.tenant_id)
    .maybeSingle()) as { data: { name?: string | null } | null; error: { message?: string } | null };
  if (tenantError) throw new Error(tenantError.message || "Could not load tenant");

  const uniqueEmails = Array.from(new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean)));
  const { data: inviteRows, error: inviteRowsError } = (await supabase
    .from("team_invitations")
    .select("email, role, token, expires_at, custom_message")
    .eq("tenant_id", me.tenant_id)
    .in("email", uniqueEmails)) as {
    data:
      | Array<{
          email: string;
          role?: string | null;
          token?: string | null;
          expires_at?: string | null;
          custom_message?: string | null;
        }>
      | null;
    error: { message?: string } | null;
  };
  if (inviteRowsError) throw new Error(inviteRowsError.message || "Could not load invitation records");

  const rowsByEmail = new Map((inviteRows ?? []).map((row) => [String(row.email).toLowerCase(), row]));
  const baseUrl = resolveInviteBaseUrl(req);
  const failures: Array<{ email: string; reason: string }> = [];
  let sentCount = 0;
  const service = getServiceClient();

  for (const email of uniqueEmails) {
    const row = rowsByEmail.get(email);
    if (!row?.token) {
      failures.push({ email, reason: "Invitation token not found" });
      continue;
    }

    const inviteUrl = `${baseUrl}/invite/accept?token=${encodeURIComponent(String(row.token))}`;
    const result = await sendInviteEmail({
      to: email,
      companyName: String(tenant?.name ?? "your workspace"),
      role: String(row.role ?? "member"),
      inviteUrl,
      expiresAt: row.expires_at ?? null,
      inviterName: me.full_name ?? null,
      customMessage: row.custom_message ?? null,
    });

    if (!result.ok && service.ok) {
      const fallback = await sendInviteEmailViaSupabaseAuth(service.supabase, {
        to: email,
        companyName: String(tenant?.name ?? "your workspace"),
        role: String(row.role ?? "member"),
        inviteUrl,
        expiresAt: row.expires_at ?? null,
        inviterName: me.full_name ?? null,
        customMessage: row.custom_message ?? null,
      });
      if (fallback.ok) {
        sentCount += 1;
        continue;
      }
      failures.push({ email, reason: `${result.error}; fallback: ${fallback.error}` });
      continue;
    }

    if (!result.ok) {
      failures.push({ email, reason: result.error });
      continue;
    }

    sentCount += 1;
  }

  return { sentCount, failures };
}

async function buildFallbackPayload(
  supabase: SupabaseClient,
  userId: string,
  filters?: { search?: string; roleFilter?: string; statusFilter?: string },
): Promise<TeamPayload> {
  const fallback: TeamPayload = {
    members: [],
    invitations: [],
    summary: { memberCount: 0, invitationCount: 0, totalCount: 0 },
    seats: { used: 0, limit: null, remaining: null, nearLimit: false, plan: "starter" },
  };

  const search = normalizeString(filters?.search).toLowerCase();
  const roleFilter = normalizeString(filters?.roleFilter).toLowerCase();
  const statusFilter = normalizeString(filters?.statusFilter).toLowerCase();

  const { data: me, error: meError } = (await supabase
    .from("profiles")
    .select("tenant_id")
    .eq("id", userId)
    .maybeSingle()) as { data: { tenant_id?: string | null } | null; error: { message?: string } | null };

  if (meError || !me?.tenant_id) return fallback;
  const tenantId = String(me.tenant_id);

  const { data: tenant } = (await supabase
    .from("tenants")
    .select("plan")
    .eq("id", tenantId)
    .maybeSingle()) as { data: { plan?: string | null } | null };
  const plan = String(tenant?.plan ?? "starter").toLowerCase();
  const seatLimit = plan === "starter" ? 25 : plan === "pro" ? 100 : null;

  const { data: membersRaw } = (await supabase
    .from("profiles")
    .select("id, full_name, role, status, last_active_at, avatar_url")
    .eq("tenant_id", tenantId)
    .neq("status", "removed")
    .order("updated_at", { ascending: false })) as {
    data:
      | Array<{
          id?: string | null;
          full_name?: string | null;
          role?: string | null;
          status?: string | null;
          last_active_at?: string | null;
          avatar_url?: string | null;
        }>
      | null;
  };

  const { data: invitesRaw } = (await supabase
    .from("team_invitations")
    .select("id, email, role, status, created_at, sent_at, expires_at, custom_message")
    .eq("tenant_id", tenantId)
    .in("status", ["pending", "sent"])
    .order("created_at", { ascending: false })) as {
    data:
      | Array<{
          id?: string | null;
          email?: string | null;
          role?: string | null;
          status?: string | null;
          created_at?: string | null;
          sent_at?: string | null;
          expires_at?: string | null;
          custom_message?: string | null;
        }>
      | null;
  };

  const members = asArray<{
    id?: string | null;
    full_name?: string | null;
    role?: string | null;
    status?: string | null;
    last_active_at?: string | null;
    avatar_url?: string | null;
  }>(membersRaw).map((row) => ({
    id: String(row.id ?? ""),
    name: String(row.full_name ?? "Unknown User"),
    email: "",
    role: String(row.role ?? "member").toLowerCase(),
    status: String(row.status ?? "active").toLowerCase(),
    lastActiveAt: row.last_active_at ?? null,
    avatarUrl: row.avatar_url ?? null,
    isCurrentUser: String(row.id ?? "") === userId,
  }));

  const invitations = asArray<{
    id?: string | null;
    email?: string | null;
    role?: string | null;
    status?: string | null;
    created_at?: string | null;
    sent_at?: string | null;
    expires_at?: string | null;
    custom_message?: string | null;
  }>(invitesRaw).map((row) => ({
    id: String(row.id ?? ""),
    email: String(row.email ?? ""),
    role: String(row.role ?? "member").toLowerCase(),
    status: String(row.status ?? "pending").toLowerCase(),
    invitedAt: row.created_at ?? new Date().toISOString(),
    sentAt: row.sent_at ?? null,
    expiresAt: row.expires_at ?? null,
    customMessage: row.custom_message ?? null,
  }));

  const filteredMembers = members.filter((member) => {
    if (roleFilter && roleFilter !== "all" && member.role !== roleFilter) return false;
    if (statusFilter && statusFilter !== "all") {
      if (statusFilter === "invited") return false;
      if (member.status !== statusFilter) return false;
    }
    if (search) {
      const text = `${member.name} ${member.email}`.toLowerCase();
      if (!text.includes(search)) return false;
    }
    return true;
  });

  const filteredInvitations = invitations.filter((invite) => {
    if (roleFilter && roleFilter !== "all" && invite.role !== roleFilter) return false;
    if (statusFilter && statusFilter !== "all" && statusFilter !== "invited") return false;
    if (search && !invite.email.toLowerCase().includes(search)) return false;
    return true;
  });

  const used = members.length + invitations.length;
  const remaining = seatLimit === null ? null : Math.max(seatLimit - used, 0);
  const nearLimit = seatLimit === null ? false : seatLimit > 0 && used / seatLimit >= 0.72;

  return {
    members: filteredMembers,
    invitations: filteredInvitations,
    summary: {
      memberCount: filteredMembers.length,
      invitationCount: filteredInvitations.length,
      totalCount: filteredMembers.length + filteredInvitations.length,
    },
    seats: {
      plan,
      used,
      limit: seatLimit,
      remaining,
      nearLimit,
    },
  };
}

async function loadPayload(
  supabase: SupabaseClient,
  userId: string,
  filters?: { search?: string; roleFilter?: string; statusFilter?: string },
) {
  const { data, error } = await supabase.rpc("get_team_management_payload", {
    p_search: filters?.search?.trim() || null,
    p_role_filter: filters?.roleFilter?.trim().toLowerCase() || null,
    p_status_filter: filters?.statusFilter?.trim().toLowerCase() || null,
  });

  if (error) {
    if (isRpcMissing(error) || isAmbiguousTenantError(error)) {
      return await buildFallbackPayload(supabase, userId, filters);
    }
    throw new Error(error.message || "Failed to load team payload");
  }

  return (
    data ?? {
      members: [],
      invitations: [],
      summary: { memberCount: 0, invitationCount: 0, totalCount: 0 },
      seats: { used: 0, limit: null, remaining: null, nearLimit: false, plan: "starter" },
    }
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let operation: Operation = "get_payload";
  let body: Record<string, unknown> = {};

  try {
    body = (await req.json()) as Record<string, unknown>;
    operation = normalizeString(body.operation || "get_payload").toLowerCase() as Operation;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const filters = {
    search: normalizeString(body.search),
    roleFilter: normalizeString(body.roleFilter),
    statusFilter: normalizeString(body.statusFilter),
  };

  try {
    if (operation === "invite_members") {
      const emails = normalizeEmails(body.emails);
      const role = normalizeString(body.role || "member").toLowerCase() || "member";
      const customMessage = normalizeString(body.customMessage);

      if (emails.length === 0) return errorResponse(400, "Provide at least one email");

      const { data, error } = await auth.supabase.rpc("invite_team_members", {
        p_emails: emails,
        p_role: role,
        p_custom_message: customMessage || null,
      });

      if (error) return errorResponse(400, "Could not send invitations", error.message);
      const emailDelivery = await sendInvitationEmails(req, auth.supabase, auth.user.id, emails);
      if (emailDelivery.failures.length > 0) {
        return errorResponse(502, "Could not deliver one or more invitation emails", emailDelivery);
      }

      const payload = await loadPayload(auth.supabase, auth.user.id, filters);
      return jsonResponse(200, {
        ok: true,
        operation,
        result: data,
        inviteEmailDelivery: emailDelivery,
        payload,
      });
    }

    if (operation === "update_member_role") {
      const profileId = normalizeString(body.profileId);
      const role = normalizeString(body.role).toLowerCase();
      if (!profileId || !role) return errorResponse(400, "profileId and role are required");

      const { data, error } = await auth.supabase.rpc("update_team_member_role", {
        p_profile_id: profileId,
        p_role: role,
      });

      if (error) return errorResponse(400, "Could not update role", error.message);

      const payload = await loadPayload(auth.supabase, auth.user.id, filters);
      return jsonResponse(200, {
        ok: true,
        operation,
        result: data,
        payload,
      });
    }

    if (operation === "update_member_status") {
      const profileId = normalizeString(body.profileId);
      const status = normalizeString(body.status).toLowerCase();
      if (!profileId || !status) return errorResponse(400, "profileId and status are required");

      const { data, error } = await auth.supabase.rpc("set_team_member_status", {
        p_profile_id: profileId,
        p_status: status,
      });

      if (error) return errorResponse(400, "Could not update member status", error.message);

      const payload = await loadPayload(auth.supabase, auth.user.id, filters);
      return jsonResponse(200, {
        ok: true,
        operation,
        result: data,
        payload,
      });
    }

    if (operation === "remove_member") {
      const profileId = normalizeString(body.profileId);
      if (!profileId) return errorResponse(400, "profileId is required");

      const { data, error } = await auth.supabase.rpc("remove_team_member", {
        p_profile_id: profileId,
      });

      if (error) return errorResponse(400, "Could not remove member", error.message);

      const payload = await loadPayload(auth.supabase, auth.user.id, filters);
      return jsonResponse(200, {
        ok: true,
        operation,
        result: data,
        payload,
      });
    }

    if (operation === "manage_invitation") {
      const invitationId = normalizeString(body.invitationId);
      const action = normalizeString(body.action).toLowerCase();
      if (!invitationId || !action) return errorResponse(400, "invitationId and action are required");

      const { data, error } = await auth.supabase.rpc("manage_team_invitation", {
        p_invitation_id: invitationId,
        p_action: action,
      });

      if (error) return errorResponse(400, "Could not manage invitation", error.message);
      let emailDelivery: { sentCount: number; failures: Array<{ email: string; reason: string }> } | null = null;
      if (action === "resend") {
        const emailFromResult =
          data && typeof data === "object" && "email" in data ? String((data as { email?: unknown }).email ?? "") : "";
        if (emailFromResult) {
          emailDelivery = await sendInvitationEmails(req, auth.supabase, auth.user.id, [emailFromResult]);
          if (emailDelivery.failures.length > 0) {
            return errorResponse(502, "Could not deliver invitation email", emailDelivery);
          }
        }
      }

      const payload = await loadPayload(auth.supabase, auth.user.id, filters);
      return jsonResponse(200, {
        ok: true,
        operation,
        result: data,
        ...(emailDelivery ? { inviteEmailDelivery: emailDelivery } : {}),
        payload,
      });
    }

    if (operation !== "get_payload") {
      return errorResponse(400, "Unsupported operation");
    }

    const payload = await loadPayload(auth.supabase, auth.user.id, filters);
    return jsonResponse(200, {
      ok: true,
      operation,
      payload,
    });
  } catch (error) {
    return errorResponse(500, "Unexpected team management error", error instanceof Error ? error.message : null);
  }
});
