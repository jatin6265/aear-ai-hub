import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Crown, Loader2, Sparkles } from "lucide-react";
import { motion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdge } from "@/lib/edge-invoke";
import { cn } from "@/lib/utils";

type BillingCycle = "monthly" | "annual";
type PlanCode = "starter" | "pro" | "business" | "enterprise";

type PlanOption = {
  code: PlanCode;
  name: string;
  description: string | null;
  badge: string | null;
  monthlyPriceCents: number | null;
  annualPriceCents: number | null;
  current: boolean;
  selectable: boolean;
  features: string[];
};

type OptionsPayload = {
  currentPlan: PlanCode;
  currentBillingCycle: BillingCycle;
  annualDiscountCallout: string;
  plans: PlanOption[];
};

type PreviewPayload = {
  requiresSales: boolean;
  message?: string;
  currentPlan: PlanCode;
  targetPlan: PlanCode;
  billingCycle: BillingCycle;
  newPlanPriceCents: number;
  prorationCreditCents: number;
  dueTodayCents: number;
  nextRenewalAmountCents: number;
  nextRenewalDate: string;
  gainedFeatures: string[];
};

type ApplyPayload = {
  fromPlan: PlanCode;
  toPlan: PlanCode;
  billingCycle: BillingCycle;
  dueTodayCents: number;
  nextRenewalAmountCents: number;
  nextRenewalDate: string;
  newlyUnlockedFeatures: string[];
};

type DowngradeImpactPayload = {
  fromPlan: PlanCode;
  toPlan: PlanCode;
  lostFeatures: string[];
  retentionInfo: string;
};

const PLAN_RANK: Record<PlanCode, number> = {
  starter: 1,
  pro: 2,
  business: 3,
  enterprise: 4,
};

const EMPTY_OPTIONS: OptionsPayload = {
  currentPlan: "starter",
  currentBillingCycle: "monthly",
  annualDiscountCallout: "Save $600/year with annual billing",
  plans: [],
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizePlan(value: unknown): PlanCode {
  const plan = String(value ?? "").trim().toLowerCase();
  if (plan === "pro" || plan === "business" || plan === "enterprise") return plan;
  return "starter";
}

function normalizeCycle(value: unknown): BillingCycle {
  return String(value ?? "").trim().toLowerCase() === "annual" ? "annual" : "monthly";
}

function normalizeOptions(value: unknown): OptionsPayload {
  const raw = asRecord(value);
  if (!raw) return EMPTY_OPTIONS;

  const plans = Array.isArray(raw.plans)
    ? raw.plans
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          return {
            code: normalizePlan(row.code),
            name: String(row.name ?? ""),
            description: row.description ? String(row.description) : null,
            badge: row.badge ? String(row.badge) : null,
            monthlyPriceCents: row.monthlyPriceCents === null ? null : Number(row.monthlyPriceCents ?? 0),
            annualPriceCents: row.annualPriceCents === null ? null : Number(row.annualPriceCents ?? 0),
            current: row.current === true,
            selectable: row.selectable === true,
            features: Array.isArray(row.features) ? row.features.map((f) => String(f ?? "")).filter(Boolean) : [],
          } satisfies PlanOption;
        })
        .filter((item): item is PlanOption => Boolean(item))
    : [];

  return {
    currentPlan: normalizePlan(raw.currentPlan),
    currentBillingCycle: normalizeCycle(raw.currentBillingCycle),
    annualDiscountCallout: String(raw.annualDiscountCallout ?? "Save $600/year with annual billing"),
    plans,
  };
}

function normalizePreview(value: unknown): PreviewPayload | null {
  const row = asRecord(value);
  if (!row) return null;
  return {
    requiresSales: row.requiresSales === true,
    message: row.message ? String(row.message) : undefined,
    currentPlan: normalizePlan(row.currentPlan),
    targetPlan: normalizePlan(row.targetPlan),
    billingCycle: normalizeCycle(row.billingCycle),
    newPlanPriceCents: Number(row.newPlanPriceCents ?? 0) || 0,
    prorationCreditCents: Number(row.prorationCreditCents ?? 0) || 0,
    dueTodayCents: Number(row.dueTodayCents ?? 0) || 0,
    nextRenewalAmountCents: Number(row.nextRenewalAmountCents ?? 0) || 0,
    nextRenewalDate: String(row.nextRenewalDate ?? ""),
    gainedFeatures: Array.isArray(row.gainedFeatures) ? row.gainedFeatures.map((v) => String(v ?? "")).filter(Boolean) : [],
  };
}

function normalizeApply(value: unknown): ApplyPayload | null {
  const row = asRecord(value);
  if (!row) return null;
  return {
    fromPlan: normalizePlan(row.fromPlan),
    toPlan: normalizePlan(row.toPlan),
    billingCycle: normalizeCycle(row.billingCycle),
    dueTodayCents: Number(row.dueTodayCents ?? 0) || 0,
    nextRenewalAmountCents: Number(row.nextRenewalAmountCents ?? 0) || 0,
    nextRenewalDate: String(row.nextRenewalDate ?? ""),
    newlyUnlockedFeatures: Array.isArray(row.newlyUnlockedFeatures) ? row.newlyUnlockedFeatures.map((v) => String(v ?? "")).filter(Boolean) : [],
  };
}

function normalizeDowngrade(value: unknown): DowngradeImpactPayload | null {
  const row = asRecord(value);
  if (!row) return null;
  return {
    fromPlan: normalizePlan(row.fromPlan),
    toPlan: normalizePlan(row.toPlan),
    lostFeatures: Array.isArray(row.lostFeatures) ? row.lostFeatures.map((v) => String(v ?? "")).filter(Boolean) : [],
    retentionInfo: String(row.retentionInfo ?? "Your data is safe. Some features will be disabled."),
  };
}

function formatMoney(cents: number | null) {
  if (cents === null) return "Custom";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(cents / 100);
}

function formatDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "N/A";
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function ConfettiBurst() {
  const particles = useMemo(
    () =>
      Array.from({ length: 28 }).map((_, index) => ({
        id: index,
        left: `${Math.random() * 100}%`,
        delay: Math.random() * 0.6,
        duration: 1.4 + Math.random() * 0.8,
        rotate: Math.random() * 320 - 160,
      })),
    [],
  );

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {particles.map((particle) => (
        <motion.span
          key={particle.id}
          className="absolute top-0 h-2 w-2 rounded-sm bg-violet-500"
          style={{ left: particle.left }}
          initial={{ y: -20, opacity: 0, rotate: 0 }}
          animate={{ y: 220, opacity: [0, 1, 1, 0], rotate: particle.rotate }}
          transition={{ delay: particle.delay, duration: particle.duration, ease: "easeOut" }}
        />
      ))}
    </div>
  );
}

export default function BillingUpgrade() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [options, setOptions] = useState<OptionsPayload>(EMPTY_OPTIONS);
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("monthly");
  const [selectedPlan, setSelectedPlan] = useState<PlanCode>("pro");
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyPayload | null>(null);
  const [processing, setProcessing] = useState(false);
  const [downgradeOpen, setDowngradeOpen] = useState(false);
  const [downgradeImpact, setDowngradeImpact] = useState<DowngradeImpactPayload | null>(null);
  const [cardNumber, setCardNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");

  const fetchOptions = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await invokeEdge("billing-plan-change", {
        body: { operation: "get_options" },
      });
      if (error) throw error;

      const payload = normalizeOptions(asRecord(data)?.payload);
      setOptions(payload);
      setBillingCycle(payload.currentBillingCycle || "monthly");

      const firstSelectable = payload.plans.find((plan) => !plan.current && plan.selectable);
      if (firstSelectable) setSelectedPlan(firstSelectable.code);
    } catch (error) {
      toast({
        title: "Could not load plans",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void fetchOptions();
  }, [fetchOptions]);

  const currentPlan = options.currentPlan;
  const isDowngrade = PLAN_RANK[selectedPlan] < PLAN_RANK[currentPlan];
  const selectedPlanRecord = options.plans.find((plan) => plan.code === selectedPlan) ?? null;
  const selectedPrice = billingCycle === "annual" ? selectedPlanRecord?.annualPriceCents : selectedPlanRecord?.monthlyPriceCents;
  const cardReady = cardNumber.replace(/\s/g, "").length >= 12 && expiry.trim().length >= 4 && cvc.trim().length >= 3;

  const proGains = useMemo(() => {
    const pro = options.plans.find((plan) => plan.code === "pro");
    const current = options.plans.find((plan) => plan.code === currentPlan);
    if (!pro) return [];
    if (!current) return pro.features.slice(0, 6);
    return pro.features.filter((feature) => !current.features.includes(feature)).slice(0, 6);
  }, [options.plans, currentPlan]);

  const handlePreview = async () => {
    if (!selectedPlan) return;

    setProcessing(true);
    try {
      const { data, error } = await invokeEdge("billing-plan-change", {
        body: {
          operation: "preview_change",
          targetPlan: selectedPlan,
          billingCycle,
        },
      });
      if (error) throw error;

      const payload = normalizePreview(asRecord(data)?.payload);
      if (!payload) throw new Error("Invalid preview response");
      if (payload.requiresSales) {
        toast({
          title: "Enterprise requires sales",
          description: payload.message ?? "Please contact sales for Enterprise plans.",
        });
        return;
      }
      setPreview(payload);
      setStep(2);
    } catch (error) {
      toast({
        title: "Could not prepare order",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setProcessing(false);
    }
  };

  const handleApplyChange = async (changeType: "upgrade" | "downgrade") => {
    setProcessing(true);
    try {
      const { data, error } = await invokeEdge("billing-plan-change", {
        body: {
          operation: "apply_change",
          targetPlan: selectedPlan,
          billingCycle,
          paymentReference: changeType === "upgrade" ? `pm_demo_${Date.now()}` : "",
          changeType,
        },
      });
      if (error) throw error;

      const payload = normalizeApply(asRecord(data)?.payload);
      if (!payload) throw new Error("Invalid apply response");
      setApplyResult(payload);
      setStep(3);
    } catch (error) {
      toast({
        title: "Plan change failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setProcessing(false);
      setDowngradeOpen(false);
    }
  };

  const openDowngradeWarning = async () => {
    setProcessing(true);
    try {
      const { data, error } = await invokeEdge("billing-plan-change", {
        body: {
          operation: "get_downgrade_impact",
          targetPlan: selectedPlan,
        },
      });
      if (error) throw error;
      setDowngradeImpact(normalizeDowngrade(asRecord(data)?.payload));
      setDowngradeOpen(true);
    } catch (error) {
      toast({
        title: "Could not load downgrade impact",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Plan Upgrade</h1>
          <p className="mt-1 text-sm text-slate-600">Choose a plan, review order details, and complete securely.</p>
        </div>
        <Button variant="outline" asChild>
          <Link to="/dashboard/billing">Back to Billing</Link>
        </Button>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-3 gap-3 text-xs sm:text-sm">
          {[
            { id: 1, label: "Choose Plan" },
            { id: 2, label: "Review Order" },
            { id: 3, label: "Success" },
          ].map((item) => (
            <div key={item.id} className="flex items-center gap-2">
              <span
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold",
                  step >= item.id ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-500",
                )}
              >
                {item.id}
              </span>
              <span className={step >= item.id ? "font-semibold text-slate-900" : "text-slate-500"}>{item.label}</span>
            </div>
          ))}
        </div>
      </div>

      {step === 1 ? (
        <section className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Step 1 - Choose Plan</h2>
            <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-1">
              <button
                type="button"
                onClick={() => setBillingCycle("monthly")}
                className={cn(
                  "rounded-full px-4 py-1.5 text-xs font-medium transition",
                  billingCycle === "monthly" ? "bg-violet-600 text-white" : "text-slate-600",
                )}
              >
                Monthly
              </button>
              <button
                type="button"
                onClick={() => setBillingCycle("annual")}
                className={cn(
                  "rounded-full px-4 py-1.5 text-xs font-medium transition",
                  billingCycle === "annual" ? "bg-violet-600 text-white" : "text-slate-600",
                )}
              >
                Annual
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            {options.annualDiscountCallout}
          </div>

          <div className="grid gap-4 md:grid-cols-4">
            {loading
              ? Array.from({ length: 4 }).map((_, index) => <Skeleton key={`plan-skel-${index}`} className="h-48 w-full rounded-xl" />)
              : options.plans.map((plan) => {
                  const price = billingCycle === "annual" ? plan.annualPriceCents : plan.monthlyPriceCents;
                  const selected = selectedPlan === plan.code;
                  const disabled = !plan.selectable && !plan.current;

                  return (
                    <button
                      key={plan.code}
                      type="button"
                      onClick={() => {
                        if (disabled) return;
                        setSelectedPlan(plan.code);
                      }}
                      disabled={disabled}
                      className={cn(
                        "rounded-xl border p-4 text-left transition",
                        selected ? "border-violet-500 bg-violet-50" : "border-slate-200 bg-white hover:border-slate-300",
                        disabled ? "cursor-not-allowed opacity-60" : "",
                      )}
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-base font-semibold text-slate-900">{plan.name}</p>
                        {plan.current ? <Badge className="border-0 bg-slate-900 text-white">Current</Badge> : null}
                      </div>
                      <p className="text-2xl font-bold text-slate-900">{formatMoney(price)}</p>
                      <p className="text-xs text-slate-500">{price === null ? "Custom contract" : billingCycle === "annual" ? "per year billed annually" : "per month"}</p>
                      {plan.badge ? <p className="mt-2 text-xs text-violet-700">{plan.badge}</p> : null}
                    </button>
                  );
                })}
          </div>

          <div className="rounded-xl border border-violet-200 bg-violet-50 p-4">
            <p className="text-sm font-semibold text-violet-900">What you gain by upgrading to Pro:</p>
            <ul className="mt-2 space-y-1">
              {proGains.length > 0 ? (
                proGains.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-violet-900">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))
              ) : (
                <li className="text-sm text-violet-800">Pro includes higher limits, approvals, and faster support.</li>
              )}
            </ul>
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            {isDowngrade ? (
              <Button variant="destructive" onClick={openDowngradeWarning} disabled={processing || selectedPlan === currentPlan}>
                {processing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Continue to Downgrade
              </Button>
            ) : (
              <Button onClick={handlePreview} disabled={processing || selectedPlan === currentPlan || !selectedPrice}>
                {processing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Continue
              </Button>
            )}
          </div>
        </section>
      ) : null}

      {step === 2 && preview ? (
        <section className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Step 2 - Review Order</h2>
            <div className="mt-4 space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-600">New Plan</span>
                <span className="font-medium text-slate-900">
                  {preview.targetPlan.toUpperCase()} - {formatMoney(preview.newPlanPriceCents)}
                  {preview.billingCycle === "annual" ? "/year" : "/month"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Prorated credit</span>
                <span className="font-medium text-emerald-700">-{formatMoney(preview.prorationCreditCents)}</span>
              </div>
              <div className="flex items-center justify-between border-t border-slate-200 pt-3">
                <span className="text-slate-700">Due today</span>
                <span className="text-lg font-bold text-slate-900">{formatMoney(preview.dueTodayCents)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Next renewal</span>
                <span className="text-slate-900">
                  Full {formatMoney(preview.nextRenewalAmountCents)}
                  {preview.billingCycle === "annual" ? "/year" : "/month"} on {formatDate(preview.nextRenewalDate)}
                </span>
              </div>
            </div>

            <div className="mt-5 rounded-xl border border-violet-200 bg-violet-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-violet-900">Unlocked after upgrade</p>
              <ul className="mt-2 space-y-1">
                {(preview.gainedFeatures.length > 0 ? preview.gainedFeatures : ["Higher limits and expanded governance controls"]).map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-violet-900">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h3 className="text-base font-semibold text-slate-900">Stripe payment element</h3>
            <p className="mt-1 text-sm text-slate-600">Secure card form for completing your upgrade.</p>

            <div className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">Card Number</label>
                <Input
                  value={cardNumber}
                  onChange={(event) => setCardNumber(event.target.value)}
                  placeholder="4242 4242 4242 4242"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">Expiry</label>
                  <Input value={expiry} onChange={(event) => setExpiry(event.target.value)} placeholder="MM/YY" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">CVC</label>
                  <Input value={cvc} onChange={(event) => setCvc(event.target.value)} placeholder="123" />
                </div>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setStep(1)} disabled={processing}>
                Back
              </Button>
              <Button onClick={() => void handleApplyChange("upgrade")} disabled={processing || !cardReady}>
                {processing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Complete Upgrade
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {step === 3 ? (
        <section className="relative overflow-hidden rounded-2xl border border-violet-200 bg-white p-8 shadow-sm">
          <ConfettiBurst />
          <div className="relative z-10 mx-auto max-w-2xl text-center">
            <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="inline-flex rounded-full bg-violet-100 p-3 text-violet-700">
              <Sparkles className="h-6 w-6" />
            </motion.div>
            <h2 className="mt-3 text-2xl font-bold text-slate-900">
              You're now on {applyResult?.toPlan ? `${applyResult.toPlan.toUpperCase()}!` : "your new plan!"}
            </h2>
            <p className="mt-2 text-sm text-slate-600">Your subscription was updated successfully.</p>

            <div className="mx-auto mt-5 max-w-xl rounded-xl border border-slate-200 bg-slate-50 p-4 text-left">
              <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Crown className="h-4 w-4 text-violet-600" />
                Newly unlocked features
              </p>
              <ul className="space-y-1">
                {(applyResult?.newlyUnlockedFeatures?.length ? applyResult.newlyUnlockedFeatures : ["Higher limits and advanced governance options"]).map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-slate-700">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-6">
              <Button onClick={() => navigate("/dashboard")}>Start exploring</Button>
            </div>
          </div>
        </section>
      ) : null}

      <AlertDialog open={downgradeOpen} onOpenChange={setDowngradeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Features you'll lose</AlertDialogTitle>
            <AlertDialogDescription>
              Downgrading disables higher-tier capabilities for this workspace.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3">
            <ul className="space-y-1">
              {(downgradeImpact?.lostFeatures?.length ? downgradeImpact.lostFeatures : ["Some advanced features will be disabled"]).map((feature) => (
                <li key={feature} className="text-sm text-slate-700">
                  - {feature}
                </li>
              ))}
            </ul>
            <p className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
              {downgradeImpact?.retentionInfo || "Your data is safe. Some features will be disabled."}
            </p>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleApplyChange("downgrade");
              }}
              className="bg-red-600 hover:bg-red-700"
            >
              Yes, downgrade my plan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
