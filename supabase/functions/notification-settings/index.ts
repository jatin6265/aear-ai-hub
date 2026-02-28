import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

type Operation =
  | "get_payload"
  | "save_channels"
  | "save_types"
  | "save_digest"
  | "send_test";

type RequestBody = {
  operation?: Operation;
  channels?: {
    emailEnabled?: boolean;
    emailAddress?: string;
    slackEnabled?: boolean;
    slackWorkspace?: string;
    slackChannel?: string;
    webhookEnabled?: boolean;
    webhookUrl?: string;
    webhookSecret?: string;
  };
  notificationTypes?: Array<{
    eventKey: string;
    email: boolean;
    slack: boolean;
    webhook: boolean;
  }>;
  digest?: {
    dailyDigestEnabled?: boolean;
    dailyDigestTime?: string;
    weeklyReportEnabled?: boolean;
    weeklyReportDay?: number;
    timezone?: string;
  };
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function sha256Hex(input: string) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function loadPayload(
  supabase: {
    rpc: (
      fn: string,
      args?: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message?: string } | null }>;
  },
) {
  const { data, error } = await supabase.rpc("get_notification_settings_payload");
  if (error) throw new Error(error.message || "Failed to load notification settings payload");
  return data;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const operation = clean(body.operation || "get_payload").toLowerCase() as Operation;

  try {
    if (operation === "save_channels") {
      const channels = asObject(body.channels) ?? {};
      const { error } = await auth.supabase.rpc("save_notification_channel_settings", {
        p_email_enabled: channels.emailEnabled ?? null,
        p_email_address: clean(channels.emailAddress),
        p_slack_enabled: channels.slackEnabled ?? null,
        p_slack_workspace: clean(channels.slackWorkspace),
        p_slack_channel: clean(channels.slackChannel),
        p_webhook_enabled: channels.webhookEnabled ?? null,
        p_webhook_url: clean(channels.webhookUrl),
        p_webhook_secret: clean(channels.webhookSecret),
      });

      if (error) return errorResponse(400, "Could not save notification channels", error.message);

      const payload = await loadPayload(auth.supabase);
      return jsonResponse(200, { ok: true, operation, payload });
    }

    if (operation === "save_types") {
      const rows = Array.isArray(body.notificationTypes) ? body.notificationTypes : [];
      const { error } = await auth.supabase.rpc("save_notification_type_preferences", {
        p_preferences: rows.map((row) => ({
          eventKey: clean(row.eventKey),
          email: row.email === true,
          slack: row.slack === true,
          webhook: row.webhook === true,
        })),
      });

      if (error) return errorResponse(400, "Could not save notification type preferences", error.message);

      const payload = await loadPayload(auth.supabase);
      return jsonResponse(200, { ok: true, operation, payload });
    }

    if (operation === "save_digest") {
      const digest = asObject(body.digest) ?? {};
      const { error } = await auth.supabase.rpc("save_notification_digest_settings", {
        p_daily_digest_enabled: digest.dailyDigestEnabled ?? null,
        p_daily_digest_time: clean(digest.dailyDigestTime) || null,
        p_weekly_report_enabled: digest.weeklyReportEnabled ?? null,
        p_weekly_report_day:
          typeof digest.weeklyReportDay === "number"
            ? Math.trunc(digest.weeklyReportDay)
            : digest.weeklyReportDay === null
              ? null
              : Number.isFinite(Number(digest.weeklyReportDay))
                ? Math.trunc(Number(digest.weeklyReportDay))
                : null,
        p_timezone: clean(digest.timezone),
      });

      if (error) return errorResponse(400, "Could not save digest settings", error.message);

      const payload = await loadPayload(auth.supabase);
      return jsonResponse(200, { ok: true, operation, payload });
    }

    if (operation === "send_test") {
      const { error: enqueueError } = await auth.supabase.rpc("enqueue_notification_test_event");
      if (enqueueError) return errorResponse(400, "Could not queue test notification", enqueueError.message);

      const channelRes = await auth.supabase
        .from("notification_channel_settings")
        .select("email_enabled,email_address,slack_enabled,slack_workspace,slack_channel,webhook_enabled,webhook_url,webhook_secret")
        .single();

      if (channelRes.error) return errorResponse(400, "Could not load channel settings", channelRes.error.message);

      const channel = channelRes.data;

      const slackCredRes = await auth.supabase
        .from("integration_credentials")
        .select("id")
        .eq("service", "slack")
        .eq("status", "active")
        .limit(1)
        .maybeSingle();

      const webhookResult: { status: string; detail: string; httpStatus?: number } = {
        status: "disabled",
        detail: "Webhook is disabled",
      };

      if (channel.webhook_enabled) {
        if (!channel.webhook_url) {
          webhookResult.status = "error";
          webhookResult.detail = "Webhook URL is not configured";
        } else {
          const payload = {
            event: "notification.test",
            sentAt: new Date().toISOString(),
            source: "settings.notifications",
            message: "This is a sample test notification from OpsAI.",
          };
          const json = JSON.stringify(payload);

          try {
            const timestamp = String(Math.floor(Date.now() / 1000));
            const signature = channel.webhook_secret
              ? await sha256Hex(`${timestamp}.${json}.${channel.webhook_secret}`)
              : "";

            const response = await fetch(channel.webhook_url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-OpsAI-Event": "notification.test",
                "X-OpsAI-Timestamp": timestamp,
                ...(signature ? { "X-OpsAI-Signature": signature } : {}),
              },
              body: json,
            });

            webhookResult.status = response.ok ? "sent" : "error";
            webhookResult.detail = response.ok ? "Webhook accepted test payload" : `Webhook responded ${response.status}`;
            webhookResult.httpStatus = response.status;
          } catch (error) {
            webhookResult.status = "error";
            webhookResult.detail = error instanceof Error ? error.message : "Webhook request failed";
          }
        }
      }

      const payload = await loadPayload(auth.supabase);

      return jsonResponse(200, {
        ok: true,
        operation,
        payload,
        channelResults: {
          inApp: {
            status: "sent",
            detail: "In-app test notification inserted.",
          },
          email: {
            status: channel.email_enabled ? "queued" : "disabled",
            detail: channel.email_enabled
              ? `Email test queued for ${channel.email_address || "configured recipient"}.`
              : "Email channel is disabled",
          },
          slack: {
            status: channel.slack_enabled ? (slackCredRes.data?.id ? "queued" : "error") : "disabled",
            detail: channel.slack_enabled
              ? slackCredRes.data?.id
                ? `Slack test queued for ${channel.slack_workspace || "workspace"} ${
                    channel.slack_channel ? `(${channel.slack_channel})` : ""
                  }.`
                : "Slack is enabled but not connected."
              : "Slack channel is disabled",
          },
          webhook: webhookResult,
        },
      });
    }

    if (operation !== "get_payload") {
      return errorResponse(400, "Unsupported operation");
    }

    const payload = await loadPayload(auth.supabase);
    return jsonResponse(200, { ok: true, operation, payload });
  } catch (error) {
    return errorResponse(500, "Unexpected notification settings error", error instanceof Error ? error.message : null);
  }
});
