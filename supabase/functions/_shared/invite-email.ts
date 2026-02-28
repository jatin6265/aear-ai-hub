type InviteEmailPayload = {
  to: string;
  companyName: string;
  role: string;
  inviteUrl: string;
  expiresAt?: string | null;
  inviterName?: string | null;
  customMessage?: string | null;
};

function formatExpiry(value?: string | null) {
  if (!value) return "in 14 days";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "soon";
  return parsed.toUTCString();
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function resolveInviteBaseUrl(req: Request) {
  const configured = Deno.env.get("INVITE_APP_BASE_URL") ?? Deno.env.get("APP_BASE_URL") ?? "";
  if (configured.trim().length > 0) return configured.trim().replace(/\/+$/, "");

  const origin = req.headers.get("origin");
  if (origin && origin.trim().length > 0) return origin.trim().replace(/\/+$/, "");

  return "http://localhost:8080";
}

export async function sendInviteEmail(payload: InviteEmailPayload) {
  const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const fromEmail =
    Deno.env.get("RESEND_FROM_EMAIL") ??
    Deno.env.get("INVITE_FROM_EMAIL") ??
    Deno.env.get("MAIL_FROM") ??
    "";

  if (!resendApiKey.trim()) {
    return { ok: false as const, error: "RESEND_API_KEY is not configured" };
  }
  if (!fromEmail.trim()) {
    return { ok: false as const, error: "RESEND_FROM_EMAIL (or INVITE_FROM_EMAIL/MAIL_FROM) is not configured" };
  }

  const company = escapeHtml(payload.companyName || "your workspace");
  const role = escapeHtml(payload.role || "member");
  const inviter = escapeHtml(payload.inviterName || "A teammate");
  const inviteUrl = payload.inviteUrl;
  const customMessage = payload.customMessage ? escapeHtml(payload.customMessage) : "";
  const expiresText = formatExpiry(payload.expiresAt);

  const subject = `${payload.inviterName || "A teammate"} invited you to join ${payload.companyName} on OpsAI`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827">
      <h2 style="margin:0 0 12px">You are invited to join ${company} on OpsAI</h2>
      <p style="margin:0 0 10px">${inviter} invited you as <strong>${role}</strong>.</p>
      ${customMessage ? `<p style="margin:0 0 10px"><em>${customMessage}</em></p>` : ""}
      <p style="margin:0 0 14px">Accept your invitation:</p>
      <p style="margin:0 0 16px">
        <a href="${inviteUrl}" style="display:inline-block;background:#6d28d9;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none">Accept Invitation</a>
      </p>
      <p style="margin:0 0 8px">Or use this link:</p>
      <p style="margin:0 0 8px"><a href="${inviteUrl}">${inviteUrl}</a></p>
      <p style="margin:0;color:#6b7280;font-size:12px">This invite expires ${escapeHtml(expiresText)}.</p>
    </div>
  `;
  const text = [
    `You are invited to join ${payload.companyName} on OpsAI.`,
    `${payload.inviterName || "A teammate"} invited you as ${payload.role || "member"}.`,
    payload.customMessage ? `Message: ${payload.customMessage}` : "",
    `Accept invitation: ${inviteUrl}`,
    `Invite expires ${expiresText}.`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [payload.to],
      subject,
      html,
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    return { ok: false as const, error: `Resend API error (${response.status}): ${body}` };
  }

  return { ok: true as const };
}

export async function sendInviteEmailViaSupabaseAuth(
  adminSupabase: {
    auth: {
      admin: {
        inviteUserByEmail: (
          email: string,
          options?: { redirectTo?: string; data?: Record<string, unknown> },
        ) => Promise<{ error: { message?: string } | null }>;
      };
    };
  },
  payload: InviteEmailPayload,
) {
  const result = await adminSupabase.auth.admin.inviteUserByEmail(payload.to, {
    redirectTo: payload.inviteUrl,
    data: {
      invited_to_tenant: payload.companyName,
      invited_role: payload.role,
      inviter_name: payload.inviterName ?? null,
    },
  });

  if (result.error) {
    return {
      ok: false as const,
      error: `Supabase Auth invite failed: ${result.error.message ?? "unknown error"}`,
    };
  }

  return { ok: true as const };
}
