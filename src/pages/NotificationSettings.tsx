import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, Link2, Loader2, Send, Slack } from "lucide-react";
import { Link, NavLink } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { invokeEdge } from "@/lib/edge-invoke";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

type NotificationTypeRow = {
  eventKey: string;
  eventName: string;
  inApp: boolean;
  email: boolean;
  slack: boolean;
  webhook: boolean;
  sortOrder: number;
};

type NotificationPayload = {
  profileRole: string;
  canManage: boolean;
  channels: {
    emailEnabled: boolean;
    emailAddress: string;
    slackEnabled: boolean;
    slackWorkspace: string;
    slackChannel: string;
    webhookEnabled: boolean;
    webhookUrl: string;
    webhookSecretMasked: string;
    inAppEnabled: boolean;
  };
  slackIntegration: {
    connected: boolean;
    label: string;
    lastConnectedAt: string | null;
  };
  notificationTypes: NotificationTypeRow[];
  digest: {
    dailyDigestEnabled: boolean;
    dailyDigestTime: string;
    weeklyReportEnabled: boolean;
    weeklyReportDay: number;
    timezone: string;
  };
};

type ChannelResult = {
  status: string;
  detail: string;
  httpStatus?: number;
};

type TestResults = {
  inApp: ChannelResult;
  email: ChannelResult;
  slack: ChannelResult;
  webhook: ChannelResult;
};

const EMPTY_PAYLOAD: NotificationPayload = {
  profileRole: "member",
  canManage: false,
  channels: {
    emailEnabled: true,
    emailAddress: "",
    slackEnabled: false,
    slackWorkspace: "",
    slackChannel: "",
    webhookEnabled: false,
    webhookUrl: "",
    webhookSecretMasked: "",
    inAppEnabled: true,
  },
  slackIntegration: {
    connected: false,
    label: "",
    lastConnectedAt: null,
  },
  notificationTypes: [],
  digest: {
    dailyDigestEnabled: false,
    dailyDigestTime: "09:00",
    weeklyReportEnabled: false,
    weeklyReportDay: 1,
    timezone: "UTC",
  },
};

const DAY_OPTIONS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
] as const;

const TIMEZONE_OPTIONS = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
];

const SETTINGS_SUB_NAV = [
  { label: "General", to: "/dashboard/settings", end: true },
  { label: "Notifications", to: "/dashboard/settings/notifications" },
  { label: "Widget", to: "/dashboard/settings/widget" },
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizePayload(value: unknown): NotificationPayload {
  const raw = asRecord(value);
  if (!raw) return EMPTY_PAYLOAD;

  const channels = asRecord(raw.channels);
  const slackIntegration = asRecord(raw.slackIntegration);
  const digest = asRecord(raw.digest);

  const notificationTypes = Array.isArray(raw.notificationTypes)
    ? raw.notificationTypes
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const key = String(row.eventKey ?? "").trim();
          const name = String(row.eventName ?? "").trim();
          if (!key || !name) return null;
          return {
            eventKey: key,
            eventName: name,
            inApp: row.inApp !== false,
            email: row.email === true,
            slack: row.slack === true,
            webhook: row.webhook === true,
            sortOrder: Number(row.sortOrder ?? 0) || 0,
          } satisfies NotificationTypeRow;
        })
        .filter((row): row is NotificationTypeRow => Boolean(row))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.eventName.localeCompare(b.eventName))
    : [];

  return {
    profileRole: String(raw.profileRole ?? "member"),
    canManage: raw.canManage === true,
    channels: {
      emailEnabled: channels?.emailEnabled !== false,
      emailAddress: String(channels?.emailAddress ?? ""),
      slackEnabled: channels?.slackEnabled === true,
      slackWorkspace: String(channels?.slackWorkspace ?? ""),
      slackChannel: String(channels?.slackChannel ?? ""),
      webhookEnabled: channels?.webhookEnabled === true,
      webhookUrl: String(channels?.webhookUrl ?? ""),
      webhookSecretMasked: String(channels?.webhookSecretMasked ?? ""),
      inAppEnabled: channels?.inAppEnabled !== false,
    },
    slackIntegration: {
      connected: slackIntegration?.connected === true,
      label: String(slackIntegration?.label ?? ""),
      lastConnectedAt: slackIntegration?.lastConnectedAt ? String(slackIntegration.lastConnectedAt) : null,
    },
    notificationTypes,
    digest: {
      dailyDigestEnabled: digest?.dailyDigestEnabled === true,
      dailyDigestTime: String(digest?.dailyDigestTime ?? "09:00").slice(0, 5),
      weeklyReportEnabled: digest?.weeklyReportEnabled === true,
      weeklyReportDay: Number(digest?.weeklyReportDay ?? 1) || 1,
      timezone: String(digest?.timezone ?? "UTC"),
    },
  };
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Please try again.";
}

function statusBadgeClass(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "sent") return "bg-emerald-100 text-emerald-700";
  if (normalized === "simulated") return "bg-blue-100 text-blue-700";
  if (normalized === "disabled") return "bg-slate-200 text-slate-700";
  return "bg-rose-100 text-rose-700";
}

export default function NotificationSettings() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [tenantId, setTenantId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [payload, setPayload] = useState<NotificationPayload>(EMPTY_PAYLOAD);
  const [channelDraft, setChannelDraft] = useState(EMPTY_PAYLOAD.channels);
  const [typeDraft, setTypeDraft] = useState<NotificationTypeRow[]>([]);
  const [digestDraft, setDigestDraft] = useState(EMPTY_PAYLOAD.digest);
  const [webhookSecretInput, setWebhookSecretInput] = useState("");
  const [testResults, setTestResults] = useState<TestResults | null>(null);

  useEffect(() => {
    if (!user) {
      setTenantId(null);
      setPayload(EMPTY_PAYLOAD);
      setChannelDraft(EMPTY_PAYLOAD.channels);
      setTypeDraft([]);
      setDigestDraft(EMPTY_PAYLOAD.digest);
      setLoading(false);
      return;
    }

    let cancelled = false;

    const bootstrap = async () => {
      try {
        const workspace = await ensureUserWorkspace(user);
        if (cancelled) return;
        setTenantId(workspace.tenantId);
      } catch (error) {
        if (cancelled) return;
        setLoading(false);
        toast({
          title: "Could not load workspace",
          description: normalizeError(error),
          variant: "destructive",
        });
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [toast, user]);

  const applyPayload = useCallback((next: NotificationPayload) => {
    setPayload(next);
    setChannelDraft(next.channels);
    setTypeDraft(next.notificationTypes);
    setDigestDraft(next.digest);
    setWebhookSecretInput("");
  }, []);

  const loadPayload = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);

    try {
      const { data, error } = await invokeEdge("notification-settings", {
        body: {
          operation: "get_payload",
        },
      });

      if (error) throw error;

      const normalized = normalizePayload((asRecord(data)?.payload as unknown) ?? null);
      applyPayload(normalized);
    } catch (error) {
      toast({
        title: "Could not load notification settings",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [applyPayload, tenantId, toast]);

  useEffect(() => {
    if (!tenantId) return;
    void loadPayload();
  }, [tenantId, loadPayload]);

  const isDirty = useMemo(() => {
    const webhookChanged = webhookSecretInput.trim().length > 0;
    const channelChanged = JSON.stringify(channelDraft) !== JSON.stringify(payload.channels);
    const typeChanged = JSON.stringify(typeDraft) !== JSON.stringify(payload.notificationTypes);
    const digestChanged = JSON.stringify(digestDraft) !== JSON.stringify(payload.digest);
    return webhookChanged || channelChanged || typeChanged || digestChanged;
  }, [channelDraft, digestDraft, payload.channels, payload.digest, payload.notificationTypes, typeDraft, webhookSecretInput]);

  const canManage = payload.canManage;

  const saveAll = async () => {
    if (!tenantId || !canManage) return;
    setSaving(true);

    try {
      const channelPayload = {
        ...channelDraft,
        webhookSecret: webhookSecretInput.trim(),
      };

      const channelRes = await invokeEdge("notification-settings", {
        body: {
          operation: "save_channels",
          channels: channelPayload,
        },
      });
      if (channelRes.error) throw channelRes.error;

      const typeRes = await invokeEdge("notification-settings", {
        body: {
          operation: "save_types",
          notificationTypes: typeDraft.map((row) => ({
            eventKey: row.eventKey,
            email: row.email,
            slack: row.slack,
            webhook: row.webhook,
          })),
        },
      });
      if (typeRes.error) throw typeRes.error;

      const digestRes = await invokeEdge("notification-settings", {
        body: {
          operation: "save_digest",
          digest: digestDraft,
        },
      });
      if (digestRes.error) throw digestRes.error;

      const latestPayload = normalizePayload((asRecord(digestRes.data)?.payload as unknown) ?? null);
      applyPayload(latestPayload);

      toast({
        title: "Notification settings saved",
        description: "Your channel, event, and digest preferences are updated.",
      });
    } catch (error) {
      toast({
        title: "Could not save notification settings",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    if (!tenantId || !canManage) return;
    setSendingTest(true);

    try {
      const { data, error } = await invokeEdge("notification-settings", {
        body: {
          operation: "send_test",
        },
      });

      if (error) throw error;

      const normalized = normalizePayload((asRecord(data)?.payload as unknown) ?? null);
      applyPayload(normalized);

      const resultsRaw = asRecord(data)?.channelResults;
      const parsed: TestResults | null = resultsRaw
        ? {
            inApp: asRecord(resultsRaw)?.inApp as ChannelResult,
            email: asRecord(resultsRaw)?.email as ChannelResult,
            slack: asRecord(resultsRaw)?.slack as ChannelResult,
            webhook: asRecord(resultsRaw)?.webhook as ChannelResult,
          }
        : null;
      setTestResults(parsed);

      toast({
        title: "Test notification sent",
        description: "Check channel results below for delivery status.",
      });
    } catch (error) {
      toast({
        title: "Could not send test notification",
        description: normalizeError(error),
        variant: "destructive",
      });
    } finally {
      setSendingTest(false);
    }
  };

  const connectSlack = async () => {
    try {
      const { data, error } = await invokeEdge("oauth-start", {
        body: {
          provider: "slack",
          label: "notifications",
        },
      });

      if (error) throw error;

      const authUrl = String(asRecord(data)?.authUrl ?? "").trim();
      if (!authUrl) throw new Error("OAuth URL not returned by server.");

      window.location.assign(authUrl);
    } catch (error) {
      toast({
        title: "Slack connection failed",
        description: normalizeError(error),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <nav className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
        <div className="flex flex-wrap gap-1">
          {SETTINGS_SUB_NAV.map((item) => (
            <NavLink
              key={item.label}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "rounded-lg px-3 py-2 text-sm font-medium transition",
                  isActive ? "bg-violet-100 text-violet-800" : "text-slate-600 hover:bg-slate-100 hover:text-slate-800",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      </nav>

      <header className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Notification Preferences</h1>
            <p className="mt-1 text-sm text-slate-600">
              Configure channel delivery, event subscriptions, and digest schedules.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Badge className={cn("border-0", canManage ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-700")}> 
              {canManage ? "Owner/Admin" : "Read only"}
            </Badge>
            <Button variant="outline" asChild>
              <Link to="/dashboard/settings">Back to Settings</Link>
            </Button>
          </div>
        </div>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Notification Channels</h2>
        <div className="mt-4 space-y-4">
          {loading ? (
            <>
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-14 w-full" />
            </>
          ) : (
            <>
              <div className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-slate-900">Email Notifications</p>
                    <p className="text-xs text-slate-600">Primary recipient: {channelDraft.emailAddress || "Not set"}</p>
                  </div>
                  <Switch
                    checked={channelDraft.emailEnabled}
                    onCheckedChange={(checked) => setChannelDraft((prev) => ({ ...prev, emailEnabled: checked }))}
                    disabled={!canManage}
                  />
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Slack className="h-4 w-4 text-violet-700" />
                      <p className="text-sm font-medium text-slate-900">Slack Integration</p>
                      {payload.slackIntegration.connected ? (
                        <Badge className="border-0 bg-emerald-100 text-emerald-700">Connected</Badge>
                      ) : (
                        <Badge className="border-0 bg-slate-200 text-slate-700">Not connected</Badge>
                      )}
                    </div>
                    <p className="text-xs text-slate-600">
                      {payload.slackIntegration.connected
                        ? `Credential: ${payload.slackIntegration.label || "notifications"}`
                        : "Connect Slack OAuth to route notifications to channels."}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <Switch
                      checked={channelDraft.slackEnabled}
                      onCheckedChange={(checked) => setChannelDraft((prev) => ({ ...prev, slackEnabled: checked }))}
                      disabled={!canManage}
                    />
                    <Button variant="outline" onClick={connectSlack} disabled={!canManage}>
                      <Link2 className="h-4 w-4" />
                      Connect
                    </Button>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Workspace</Label>
                    <Input
                      value={channelDraft.slackWorkspace}
                      onChange={(event) =>
                        setChannelDraft((prev) => ({
                          ...prev,
                          slackWorkspace: event.target.value,
                        }))
                      }
                      placeholder="AEAR Workspace"
                      disabled={!canManage}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Channel</Label>
                    <Input
                      value={channelDraft.slackChannel}
                      onChange={(event) =>
                        setChannelDraft((prev) => ({
                          ...prev,
                          slackChannel: event.target.value,
                        }))
                      }
                      placeholder="#alerts"
                      disabled={!canManage}
                    />
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-slate-900">Webhook</p>
                    <p className="text-xs text-slate-600">POST payload is signed with `X-AEAR-Signature` when secret is set.</p>
                  </div>
                  <Switch
                    checked={channelDraft.webhookEnabled}
                    onCheckedChange={(checked) => setChannelDraft((prev) => ({ ...prev, webhookEnabled: checked }))}
                    disabled={!canManage}
                  />
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5 md:col-span-2">
                    <Label>Webhook URL</Label>
                    <Input
                      value={channelDraft.webhookUrl}
                      onChange={(event) =>
                        setChannelDraft((prev) => ({
                          ...prev,
                          webhookUrl: event.target.value,
                        }))
                      }
                      placeholder="https://your-domain.com/hooks/aear"
                      disabled={!canManage}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Secret key</Label>
                    <Input
                      value={webhookSecretInput}
                      onChange={(event) => setWebhookSecretInput(event.target.value)}
                      placeholder={channelDraft.webhookSecretMasked || "Set secret"}
                      type="password"
                      disabled={!canManage}
                    />
                  </div>
                  <div className="flex items-end">
                    <Button variant="outline" onClick={sendTest} disabled={!canManage || sendingTest}>
                      {sendingTest ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      Test webhook
                    </Button>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-slate-900">In-App Notifications</p>
                    <p className="text-xs text-slate-600">Always on for governance and safety events.</p>
                  </div>
                  <Switch checked disabled />
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Notification Types</h2>
        <div className="mt-4 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event Name</TableHead>
                <TableHead className="text-center">In-App</TableHead>
                <TableHead className="text-center">Email</TableHead>
                <TableHead className="text-center">Slack</TableHead>
                <TableHead className="text-center">Webhook</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 6 }).map((_, index) => (
                  <TableRow key={`event-row-skeleton-${index}`}>
                    <TableCell><Skeleton className="h-4 w-56" /></TableCell>
                    <TableCell><Skeleton className="mx-auto h-5 w-10" /></TableCell>
                    <TableCell><Skeleton className="mx-auto h-5 w-10" /></TableCell>
                    <TableCell><Skeleton className="mx-auto h-5 w-10" /></TableCell>
                    <TableCell><Skeleton className="mx-auto h-5 w-10" /></TableCell>
                  </TableRow>
                ))
              ) : typeDraft.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-16 text-center text-sm text-slate-500">
                    No notification event preferences found.
                  </TableCell>
                </TableRow>
              ) : (
                typeDraft.map((row) => (
                  <TableRow key={row.eventKey}>
                    <TableCell className="font-medium text-slate-900">{row.eventName}</TableCell>
                    <TableCell className="text-center">
                      <Switch checked disabled />
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={row.email}
                        onCheckedChange={(checked) =>
                          setTypeDraft((prev) =>
                            prev.map((item) =>
                              item.eventKey === row.eventKey
                                ? {
                                    ...item,
                                    email: checked,
                                  }
                                : item,
                            ),
                          )
                        }
                        disabled={!canManage}
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={row.slack}
                        onCheckedChange={(checked) =>
                          setTypeDraft((prev) =>
                            prev.map((item) =>
                              item.eventKey === row.eventKey
                                ? {
                                    ...item,
                                    slack: checked,
                                  }
                                : item,
                            ),
                          )
                        }
                        disabled={!canManage}
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={row.webhook}
                        onCheckedChange={(checked) =>
                          setTypeDraft((prev) =>
                            prev.map((item) =>
                              item.eventKey === row.eventKey
                                ? {
                                    ...item,
                                    webhook: checked,
                                  }
                                : item,
                            ),
                          )
                        }
                        disabled={!canManage}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Digest Settings</h2>
        {loading ? (
          <div className="mt-4 space-y-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="space-y-2 rounded-lg border border-slate-200 p-4">
              <div className="flex items-center justify-between">
                <Label>Daily digest</Label>
                <Switch
                  checked={digestDraft.dailyDigestEnabled}
                  onCheckedChange={(checked) =>
                    setDigestDraft((prev) => ({
                      ...prev,
                      dailyDigestEnabled: checked,
                    }))
                  }
                  disabled={!canManage}
                />
              </div>
              <Input
                type="time"
                value={digestDraft.dailyDigestTime}
                onChange={(event) =>
                  setDigestDraft((prev) => ({
                    ...prev,
                    dailyDigestTime: event.target.value,
                  }))
                }
                disabled={!canManage || !digestDraft.dailyDigestEnabled}
              />
            </div>

            <div className="space-y-2 rounded-lg border border-slate-200 p-4">
              <div className="flex items-center justify-between">
                <Label>Weekly report</Label>
                <Switch
                  checked={digestDraft.weeklyReportEnabled}
                  onCheckedChange={(checked) =>
                    setDigestDraft((prev) => ({
                      ...prev,
                      weeklyReportEnabled: checked,
                    }))
                  }
                  disabled={!canManage}
                />
              </div>
              <Select
                value={String(digestDraft.weeklyReportDay)}
                onValueChange={(value) =>
                  setDigestDraft((prev) => ({
                    ...prev,
                    weeklyReportDay: Number(value) || 1,
                  }))
                }
                disabled={!canManage || !digestDraft.weeklyReportEnabled}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAY_OPTIONS.map((day) => (
                    <SelectItem key={day.value} value={String(day.value)}>
                      {day.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 rounded-lg border border-slate-200 p-4 md:col-span-2">
              <Label>Timezone</Label>
              <Select
                value={digestDraft.timezone}
                onValueChange={(value) =>
                  setDigestDraft((prev) => ({
                    ...prev,
                    timezone: value,
                  }))
                }
                disabled={!canManage}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONE_OPTIONS.map((zone) => (
                    <SelectItem key={zone} value={zone}>
                      {zone}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={saveAll} disabled={loading || saving || !canManage || !isDirty}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />}
            Save Notification Preferences
          </Button>

          <Button variant="outline" onClick={sendTest} disabled={loading || sendingTest || !canManage}>
            {sendingTest ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send Test
          </Button>
        </div>

        {testResults ? (
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            {([
              ["In-App", testResults.inApp],
              ["Email", testResults.email],
              ["Slack", testResults.slack],
              ["Webhook", testResults.webhook],
            ] as const).map(([label, result]) => (
              <div key={label} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-slate-900">{label}</p>
                  <Badge className={cn("border-0 capitalize", statusBadgeClass(result.status))}>{result.status}</Badge>
                </div>
                <p className="mt-1 text-xs text-slate-600">{result.detail}</p>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
