import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/service.ts";
import { resolveInviteBaseUrl, sendInviteEmail, sendInviteEmailViaSupabaseAuth } from "../_shared/invite-email.ts";

type InviteInput = {
  email: string;
  role?: string;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let invites: InviteInput[] = [];
  try {
    const body = await req.json();
    invites = Array.isArray(body?.invites) ? body.invites : [];
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (invites.length === 0) {
    return errorResponse(400, "Provide at least one invite in invites[]");
  }

  const normalized = invites.map((invite) => ({
    email: String(invite.email ?? "").trim().toLowerCase(),
    role: String(invite.role ?? "member").trim().toLowerCase(),
  }));

  const { data, error } = await auth.supabase.rpc("create_team_invitations", {
    p_invites: normalized,
  });

  if (error) return errorResponse(400, "Could not create invitations", error.message);

  const { data: me, error: meError } = await auth.supabase
    .from("profiles")
    .select("tenant_id, full_name")
    .eq("id", auth.user.id)
    .maybeSingle();
  if (meError || !me?.tenant_id) return errorResponse(400, "Could not resolve inviter profile", meError?.message);

  const { data: tenant, error: tenantError } = await auth.supabase
    .from("tenants")
    .select("name")
    .eq("id", me.tenant_id)
    .maybeSingle();
  if (tenantError) return errorResponse(400, "Could not load tenant", tenantError.message);

  const emails = Array.from(new Set(normalized.map((invite) => invite.email)));
  const { data: inviteRows, error: inviteRowsError } = await auth.supabase
    .from("team_invitations")
    .select("email, role, token, expires_at, custom_message")
    .eq("tenant_id", me.tenant_id)
    .in("email", emails);
  if (inviteRowsError) return errorResponse(400, "Could not load invitation records", inviteRowsError.message);

  const byEmail = new Map((inviteRows ?? []).map((row) => [String(row.email).toLowerCase(), row]));
  const baseUrl = resolveInviteBaseUrl(req);
  const failures: Array<{ email: string; reason: string }> = [];
  let sentCount = 0;
  const service = getServiceClient();

  for (const invite of normalized) {
    const row = byEmail.get(invite.email);
    if (!row?.token) {
      failures.push({ email: invite.email, reason: "Invitation token not found" });
      continue;
    }

    const inviteUrl = `${baseUrl}/invite/accept?token=${encodeURIComponent(String(row.token))}`;
    const sendResult = await sendInviteEmail({
      to: invite.email,
      companyName: String(tenant?.name ?? "your workspace"),
      role: String(row.role ?? invite.role ?? "member"),
      inviteUrl,
      expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
      inviterName: typeof me.full_name === "string" ? me.full_name : null,
      customMessage: typeof row.custom_message === "string" ? row.custom_message : null,
    });

    if (!sendResult.ok && service.ok) {
      const fallback = await sendInviteEmailViaSupabaseAuth(service.supabase, {
        to: invite.email,
        companyName: String(tenant?.name ?? "your workspace"),
        role: String(row.role ?? invite.role ?? "member"),
        inviteUrl,
        expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
        inviterName: typeof me.full_name === "string" ? me.full_name : null,
        customMessage: typeof row.custom_message === "string" ? row.custom_message : null,
      });
      if (fallback.ok) {
        sentCount += 1;
        continue;
      }
      failures.push({ email: invite.email, reason: `${sendResult.error}; fallback: ${fallback.error}` });
      continue;
    }

    if (!sendResult.ok) {
      failures.push({ email: invite.email, reason: sendResult.error });
      continue;
    }

    sentCount += 1;
  }

  if (failures.length > 0) {
    return errorResponse(502, "Could not deliver one or more invitation emails", {
      sentCount,
      failures,
      summary: failures.map((failure) => `${failure.email}: ${failure.reason}`).join(" | "),
    });
  }

  const summary = data?.[0] ?? { inserted_count: 0, remaining_slots: 0 };

  return jsonResponse(200, {
    ok: true,
    insertedCount: summary.inserted_count,
    remainingSlots: summary.remaining_slots,
    sentCount,
    message: "Invitation emails sent.",
  });
});
