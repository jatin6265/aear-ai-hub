import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Check, CheckCircle2 } from "lucide-react";
import { Link } from "react-router-dom";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdge } from "@/lib/edge-invoke";
import { cn } from "@/lib/utils";

type BillingInterval = "monthly" | "annual";
type PlanCode = "starter" | "pro" | "business" | "enterprise";

type PricingPlan = {
  code: PlanCode;
  name: string;
  description: string;
  badge: string | null;
  badgeTone: "neutral" | "popular" | "highlight";
  ctaLabel: string;
  ctaVariant: "primary" | "outline";
  highlighted: boolean;
  priceCents: number | null;
  priceDisplay: string;
  periodLabel: string;
  features: string[];
};

type ComparisonRow = {
  featureKey: string;
  category: string;
  featureName: string;
  starter: string;
  pro: string;
  business: string;
  enterprise: string;
};

type PricingFaq = {
  question: string;
  answer: string;
  sortOrder: number;
};

type PricingPayload = {
  billingInterval: BillingInterval;
  annualSavingsPct: number;
  plans: PricingPlan[];
  comparisonRows: ComparisonRow[];
  faq: PricingFaq[];
};

const EMPTY_PAYLOAD: PricingPayload = {
  billingInterval: "monthly",
  annualSavingsPct: 20,
  plans: [],
  comparisonRows: [],
  faq: [],
};

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

function normalizePayload(value: unknown): PricingPayload {
  const raw = asRecord(value);
  if (!raw) return EMPTY_PAYLOAD;

  const plans = Array.isArray(raw.plans)
    ? raw.plans
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;

          const code = String(row.code ?? "").trim().toLowerCase();
          if (code !== "starter" && code !== "pro" && code !== "business" && code !== "enterprise") return null;

          return {
            code,
            name: String(row.name ?? ""),
            description: String(row.description ?? ""),
            badge: row.badge ? String(row.badge) : null,
            badgeTone: (["neutral", "popular", "highlight"].includes(String(row.badgeTone ?? "").toLowerCase())
              ? String(row.badgeTone).toLowerCase()
              : "neutral") as PricingPlan["badgeTone"],
            ctaLabel: String(row.ctaLabel ?? "Start Free Trial"),
            ctaVariant: String(row.ctaVariant ?? "primary").toLowerCase() === "outline" ? "outline" : "primary",
            highlighted: row.highlighted === true,
            priceCents: row.priceCents === null ? null : Number(row.priceCents ?? 0),
            priceDisplay: String(row.priceDisplay ?? "Custom"),
            periodLabel: String(row.periodLabel ?? ""),
            features: Array.isArray(row.features)
              ? row.features.map((feature) => String(feature ?? "")).filter((feature) => feature.trim().length > 0)
              : [],
          } satisfies PricingPlan;
        })
        .filter((plan): plan is PricingPlan => Boolean(plan))
    : [];

  const comparisonRows = Array.isArray(raw.comparisonRows)
    ? raw.comparisonRows
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          return {
            featureKey: String(row.featureKey ?? ""),
            category: String(row.category ?? ""),
            featureName: String(row.featureName ?? ""),
            starter: String(row.starter ?? "-"),
            pro: String(row.pro ?? "-"),
            business: String(row.business ?? "-"),
            enterprise: String(row.enterprise ?? "-"),
          } satisfies ComparisonRow;
        })
        .filter((row): row is ComparisonRow => Boolean(row) && row.featureKey.trim().length > 0)
    : [];

  const faq = Array.isArray(raw.faq)
    ? raw.faq
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          return {
            question: String(row.question ?? ""),
            answer: String(row.answer ?? ""),
            sortOrder: Number(row.sortOrder ?? 0) || 0,
          } satisfies PricingFaq;
        })
        .filter((item): item is PricingFaq => Boolean(item) && item.question.trim().length > 0)
        .sort((a, b) => a.sortOrder - b.sortOrder)
    : [];

  return {
    billingInterval: String(raw.billingInterval ?? "monthly").toLowerCase() === "annual" ? "annual" : "monthly",
    annualSavingsPct: Number(raw.annualSavingsPct ?? 20) || 20,
    plans,
    comparisonRows,
    faq,
  };
}

function renderComparisonValue(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "yes" || normalized === "included" || normalized === "true") {
    return <CheckCircle2 className="mx-auto h-4 w-4 text-emerald-600" />;
  }
  if (normalized === "no" || normalized === "false" || normalized === "-") {
    return <span className="text-slate-400">-</span>;
  }
  return <span className="text-xs text-slate-700">{value}</span>;
}

function badgeClass(tone: PricingPlan["badgeTone"]) {
  if (tone === "highlight") return "border-0 bg-violet-100 text-violet-800";
  if (tone === "popular") return "border-0 bg-blue-100 text-blue-800";
  return "border-0 bg-slate-200 text-slate-700";
}

export default function PricingPage() {
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [interval, setInterval] = useState<BillingInterval>("monthly");
  const [payload, setPayload] = useState<PricingPayload>(EMPTY_PAYLOAD);

  const load = useCallback(
    async (nextInterval: BillingInterval) => {
      setLoading(true);
      try {
        const { data, error } = await invokeEdge("public-pricing", {
          body: {
            billingInterval: nextInterval,
          },
          requireAuth: false,
        });

        if (error) throw error;

        const nextPayload = normalizePayload((asRecord(data)?.payload as unknown) ?? null);
        setPayload(nextPayload);
      } catch (error) {
        toast({
          title: "Could not load pricing",
          description: normalizeError(error),
          variant: "destructive",
        });
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load(interval);
  }, [interval, load]);

  const groupedRows = useMemo(() => {
    const map = new Map<string, ComparisonRow[]>();
    payload.comparisonRows.forEach((row) => {
      if (!map.has(row.category)) map.set(row.category, []);
      map.get(row.category)?.push(row);
    });
    return Array.from(map.entries());
  }, [payload.comparisonRows]);

  const onIntervalChange = (next: BillingInterval) => {
    if (next === interval) return;
    setInterval(next);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-7xl px-6 py-14 lg:py-20">
        <header className="text-center">
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">Simple, transparent pricing</h1>
          <p className="mt-3 text-sm text-slate-600 sm:text-base">Billed monthly. Annual saves 20%.</p>

          <div className="mt-6 inline-flex rounded-full border border-slate-200 bg-white p-1 shadow-sm">
            <button
              type="button"
              onClick={() => onIntervalChange("monthly")}
              className={cn(
                "rounded-full px-5 py-2 text-sm font-medium transition",
                interval === "monthly" ? "bg-violet-600 text-white" : "text-slate-600 hover:bg-slate-100",
              )}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => onIntervalChange("annual")}
              className={cn(
                "rounded-full px-5 py-2 text-sm font-medium transition",
                interval === "annual" ? "bg-violet-600 text-white" : "text-slate-600 hover:bg-slate-100",
              )}
            >
              Annual
            </button>
          </div>
        </header>

        <section className="mt-12 grid gap-5 lg:grid-cols-4">
          {loading
            ? Array.from({ length: 4 }).map((_, index) => <Skeleton key={`plan-skeleton-${index}`} className="h-[470px] rounded-2xl" />)
            : payload.plans.map((plan) => (
                <article
                  key={plan.code}
                  className={cn(
                    "flex h-full flex-col rounded-2xl border bg-white p-6 shadow-sm",
                    plan.highlighted ? "border-violet-500 ring-1 ring-violet-200" : "border-slate-200",
                  )}
                >
                  <div className="mb-4 flex min-h-8 items-center">
                    {plan.badge ? <Badge className={badgeClass(plan.badgeTone)}>{plan.badge}</Badge> : null}
                  </div>

                  <h2 className="text-xl font-bold text-slate-900">{plan.name.toUpperCase()}</h2>
                  <div className="mt-3 flex items-end gap-1">
                    <span className="text-4xl font-extrabold tracking-tight">{plan.priceDisplay}</span>
                    {plan.periodLabel ? <span className="pb-1 text-xs text-slate-500">{plan.periodLabel}</span> : null}
                  </div>
                  {plan.description ? <p className="mt-2 min-h-10 text-sm text-slate-600">{plan.description}</p> : <div className="mt-2 min-h-10" />}

                  <ul className="mt-4 flex-1 space-y-2.5">
                    {plan.features.map((feature) => (
                      <li key={`${plan.code}-${feature}`} className="flex items-start gap-2 text-sm text-slate-700">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>

                  {plan.code === "enterprise" ? (
                    <Button variant="outline" className="mt-6 border-slate-300" asChild>
                      <a href="mailto:sales@aear.ai">Contact Sales</a>
                    </Button>
                  ) : (
                    <Button className="mt-6 bg-violet-600 hover:bg-violet-700" asChild>
                      <Link to="/auth/signup">Start Free Trial</Link>
                    </Button>
                  )}
                </article>
              ))}
        </section>

        <section className="mt-14 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <h3 className="text-2xl font-bold tracking-tight">Feature Comparison</h3>
          <p className="mt-1 text-sm text-slate-600">Compare capabilities across plans.</p>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[920px] border-collapse text-left">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="sticky left-0 z-10 bg-white px-3 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Feature</th>
                  <th className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wide text-slate-500">Starter</th>
                  <th className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wide text-slate-500">Pro</th>
                  <th className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wide text-slate-500">Business</th>
                  <th className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wide text-slate-500">Enterprise</th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 16 }).map((_, index) => (
                      <tr key={`comparison-skeleton-${index}`} className="border-b border-slate-100">
                        <td className="px-3 py-3"><Skeleton className="h-4 w-40" /></td>
                        <td className="px-3 py-3"><Skeleton className="mx-auto h-4 w-20" /></td>
                        <td className="px-3 py-3"><Skeleton className="mx-auto h-4 w-20" /></td>
                        <td className="px-3 py-3"><Skeleton className="mx-auto h-4 w-20" /></td>
                        <td className="px-3 py-3"><Skeleton className="mx-auto h-4 w-20" /></td>
                      </tr>
                    ))
                  : groupedRows.map(([category, rows]) => (
                      <Fragment key={`cat-${category}`}>
                        <tr className="border-y border-slate-200 bg-slate-50">
                          <td colSpan={5} className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                            {category}
                          </td>
                        </tr>
                        {rows.map((row) => (
                          <tr key={row.featureKey} className="border-b border-slate-100">
                            <td className="sticky left-0 bg-white px-3 py-3 text-sm text-slate-800">{row.featureName}</td>
                            <td className="px-3 py-3 text-center">{renderComparisonValue(row.starter)}</td>
                            <td className="px-3 py-3 text-center">{renderComparisonValue(row.pro)}</td>
                            <td className="px-3 py-3 text-center">{renderComparisonValue(row.business)}</td>
                            <td className="px-3 py-3 text-center">{renderComparisonValue(row.enterprise)}</td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mx-auto mt-14 max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-2xl font-bold tracking-tight">Frequently Asked Questions</h3>
          <p className="mt-1 text-sm text-slate-600">Answers to common pricing and billing questions.</p>

          <Accordion type="single" collapsible className="mt-4">
            {loading
              ? Array.from({ length: 6 }).map((_, index) => (
                  <div key={`faq-skeleton-${index}`} className="border-b border-slate-200 py-4">
                    <Skeleton className="h-4 w-[75%]" />
                  </div>
                ))
              : payload.faq.map((item, index) => (
                  <AccordionItem key={`${item.question}-${index}`} value={`faq-${index}`}>
                    <AccordionTrigger className="text-left text-sm font-semibold text-slate-800 no-underline hover:no-underline">
                      {item.question}
                    </AccordionTrigger>
                    <AccordionContent className="text-sm leading-relaxed text-slate-600">{item.answer}</AccordionContent>
                  </AccordionItem>
                ))}
          </Accordion>
        </section>
      </div>
    </div>
  );
}
