import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { differenceInCalendarDays } from "date-fns";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";

type SubscriptionRow = {
  plan: string;
  status: string;
  trial_ends_at: string | null;
};

type UsageRow = {
  metric_type: string;
  quantity: number;
};

const LIMITS_BY_PLAN: Record<string, { apiCalls: number; aiInferences: number; storageGb: number; teamMembers: number }> = {
  starter: { apiCalls: 50_000, aiInferences: 10_000, storageGb: 10, teamMembers: 25 },
  pro: { apiCalls: 250_000, aiInferences: 75_000, storageGb: 100, teamMembers: 100 },
  enterprise: { apiCalls: 1_000_000, aiInferences: 300_000, storageGb: 500, teamMembers: 500 },
};

function clampPercent(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
}

export default function Usage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [plan, setPlan] = useState("starter");
  const [status, setStatus] = useState("trial");
  const [trialEndsAt, setTrialEndsAt] = useState<string | null>(null);
  const [usageRows, setUsageRows] = useState<UsageRow[]>([]);
  const [teamCount, setTeamCount] = useState(0);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    try {
      const workspace = await ensureUserWorkspace(user);

      const [subscriptionRes, usageRes, profilesRes, invitesRes] = await Promise.all([
        supabase
          .from("subscriptions")
          .select("plan, status, trial_ends_at")
          .eq("tenant_id", workspace.tenantId)
          .maybeSingle(),
        supabase
          .from("usage_events")
          .select("metric_type, quantity")
          .eq("tenant_id", workspace.tenantId),
        supabase
          .from("profiles")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", workspace.tenantId),
        supabase
          .from("team_invitations")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", workspace.tenantId)
          .in("status", ["pending", "sent"]),
      ]);

      if (subscriptionRes.error) throw subscriptionRes.error;
      if (usageRes.error) throw usageRes.error;
      if (profilesRes.error) throw profilesRes.error;
      if (invitesRes.error) throw invitesRes.error;

      const sub = subscriptionRes.data as SubscriptionRow | null;
      setPlan((sub?.plan ?? "starter").toLowerCase());
      setStatus(sub?.status ?? "trial");
      setTrialEndsAt(sub?.trial_ends_at ?? null);
      setUsageRows((usageRes.data ?? []) as UsageRow[]);
      setTeamCount((profilesRes.count ?? 0) + (invitesRes.count ?? 0));
    } catch (error) {
      toast({
        title: "Could not load usage",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast, user]);

  useEffect(() => {
    void load();
  }, [load]);

  const metrics = useMemo(() => {
    const limits = LIMITS_BY_PLAN[plan] ?? LIMITS_BY_PLAN.starter;

    const apiCalls = usageRows
      .filter((row) => /(api|query)/i.test(row.metric_type))
      .reduce((sum, row) => sum + Number(row.quantity ?? 0), 0);

    const aiInferences = usageRows
      .filter((row) => /(ai|inference|message)/i.test(row.metric_type))
      .reduce((sum, row) => sum + Number(row.quantity ?? 0), 0);

    const storageGbRaw = usageRows
      .filter((row) => /storage_gb/i.test(row.metric_type))
      .reduce((sum, row) => sum + Number(row.quantity ?? 0), 0);

    const storageMbRaw = usageRows
      .filter((row) => /storage_mb/i.test(row.metric_type))
      .reduce((sum, row) => sum + Number(row.quantity ?? 0), 0);

    const storageGb = storageGbRaw > 0 ? storageGbRaw : Number((storageMbRaw / 1024).toFixed(2));

    return [
      {
        metric: "API Calls",
        value: apiCalls.toLocaleString(),
        limit: limits.apiCalls.toLocaleString(),
        percent: clampPercent(apiCalls, limits.apiCalls),
      },
      {
        metric: "AI Inferences",
        value: aiInferences.toLocaleString(),
        limit: limits.aiInferences.toLocaleString(),
        percent: clampPercent(aiInferences, limits.aiInferences),
      },
      {
        metric: "Storage",
        value: `${storageGb.toLocaleString()} GB`,
        limit: `${limits.storageGb.toLocaleString()} GB`,
        percent: clampPercent(storageGb, limits.storageGb),
      },
      {
        metric: "Team Members",
        value: teamCount.toLocaleString(),
        limit: limits.teamMembers.toLocaleString(),
        percent: clampPercent(teamCount, limits.teamMembers),
      },
    ];
  }, [plan, teamCount, usageRows]);

  const trialText = useMemo(() => {
    if (!trialEndsAt) return "Billing cycle active";
    const days = differenceInCalendarDays(new Date(trialEndsAt), new Date());
    if (days <= 0) return "Trial ended";
    return `Trial ends in ${days} day${days === 1 ? "" : "s"}`;
  }, [trialEndsAt]);

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Usage & Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">Monitor your resource consumption.</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading billing data...
          </div>
        ) : (
          <>
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold capitalize">{plan} Plan</h2>
                <p className="text-sm text-slate-500">{trialText}</p>
              </div>
              <span className="rounded-full bg-violet-100 px-3 py-1 text-sm font-medium capitalize text-violet-700">
                {status}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              {loading
                ? Array.from({ length: 4 }).map((_, idx) => (
                    <div key={idx}>
                      <Skeleton className="mb-2 h-4 w-28" />
                      <Skeleton className="h-2 w-full" />
                    </div>
                  ))
                : metrics.map((item) => (
                    <div key={item.metric}>
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-sm font-medium">{item.metric}</span>
                        <span className="text-xs text-slate-500">
                          {item.value} / {item.limit}
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-gradient-to-r from-violet-600 to-purple-600" style={{ width: `${item.percent}%` }} />
                      </div>
                    </div>
                  ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
