import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Check, CheckCircle2, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { invokeEdge } from "@/lib/edge-invoke";
import { cn } from "@/lib/utils";

// ─── Brand palette (sourced from OpsAI_Logo_01.svg) ──────────────────────────
const NAVY     = '#12294A';
const TEAL     = '#4FDEAA';
const NAVY2    = '#0d1f38';
const TEAL_DIM = '#0e9065';
// ─────────────────────────────────────────────────────────────────────────────

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
    return <CheckCircle2 className="mx-auto h-4 w-4" style={{ color: TEAL_DIM }} />;
  }
  if (normalized === "no" || normalized === "false" || normalized === "-") {
    return <span style={{ color: 'rgba(18,41,74,0.25)' }}>—</span>;
  }
  return <span className="text-xs" style={{ color: NAVY }}>{value}</span>;
}

function badgeStyle(tone: PricingPlan["badgeTone"]): React.CSSProperties {
  if (tone === "popular" || tone === "highlight") return { background: TEAL, color: NAVY, border: 0, fontWeight: 600 };
  return { background: 'rgba(18,41,74,0.08)', color: NAVY, border: 0 };
}

/**
 * OpsAI_Logo_01.svg inlined as a React component.
 * Uses a unique clipPath id so it doesn't conflict with LandingPage.
 */
function OpsAILogo({ height = 36, opsColor = '#ffffff' }: { height?: number; opsColor?: string }) {
  return (
    <svg
      viewBox="90 95 595 160"
      height={height}
      style={{ display: 'block', overflow: 'visible' }}
      aria-label="OpsAI"
    >
      <defs>
        <clipPath id="pricing-logo-teal-clip">
          <rect x="215" y="0" width="200" height="185" />
        </clipPath>
      </defs>
      <path d="M 200 100 A 100 100 0 1 0 300 200 L 260 200 A 60 60 0 1 1 200 140 Z" fill={opsColor} />
      <circle cx="200" cy="200" r="67.5" fill="none" stroke="#4FDEAA" strokeWidth="15" clipPath="url(#pricing-logo-teal-clip)" />
      <circle cx="200" cy="200" r="92.5" fill="none" stroke="#4FDEAA" strokeWidth="15" clipPath="url(#pricing-logo-teal-clip)" />
      <text x="340" y="242" fontFamily="Montserrat, Inter, system-ui, sans-serif" fontWeight="700" fontSize="130">
        <tspan fill={opsColor}>Ops</tspan>
        <tspan fill="#4FDEAA">AI</tspan>
      </text>
    </svg>
  );
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
          body: { billingInterval: nextInterval },
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
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', minHeight: '100vh', background: '#F0F9F5' }}>

      {/* ── Nav ─────────────────────────────────────────────────────────────── */}
      <nav
        className="fixed top-0 left-0 right-0 z-50 border-b"
        style={{
          background: 'rgba(18, 41, 74, 0.72)',
          backdropFilter: 'blur(20px) saturate(180%)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          borderColor: 'rgba(79,222,170,0.2)',
          boxShadow: '0 1px 40px rgba(18,41,74,0.6), inset 0 -1px 0 rgba(79,222,170,0.12)',
        }}
      >
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link to="/" style={{ display: 'flex', alignItems: 'center' }}>
            <OpsAILogo height={34} opsColor="#ffffff" />
          </Link>

          <div className="hidden md:flex items-center gap-8 text-sm" style={{ color: 'rgba(255,255,255,0.65)' }}>
            <Link to="/#features" className="transition-colors hover:text-white">Features</Link>
            <Link to="/#how-it-works" className="transition-colors hover:text-white">How it Works</Link>
            <Link to="/pricing" style={{ color: TEAL }}>Pricing</Link>
          </div>

          <div className="flex items-center gap-3">
            <Link to="/auth/login">
              <Button variant="ghost" size="sm"
                style={{ color: 'rgba(255,255,255,0.7)' }}
                className="hover:text-white hover:bg-white/5">
                Sign In
              </Button>
            </Link>
            <Link to="/auth/signup">
              <Button size="sm"
                style={{ background: TEAL, color: NAVY, fontWeight: 600, border: 'none' }}
                className="hover:opacity-90">
                Get Started
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* ── Hero / Header ───────────────────────────────────────────────────── */}
      <div className="pt-16" style={{ background: NAVY }}>
        <div className="max-w-7xl mx-auto px-6 py-20 text-center relative overflow-hidden">
          {/* Subtle glow */}
          <div className="absolute inset-0 pointer-events-none"
            style={{ background: `radial-gradient(ellipse at 50% 120%, ${TEAL}18, transparent 60%)` }} />

          <p className="relative text-sm font-semibold uppercase tracking-widest mb-4" style={{ color: TEAL }}>
            Pricing
          </p>
          <h1 className="relative text-4xl font-extrabold tracking-tight sm:text-5xl" style={{ color: '#ffffff' }}>
            Simple, transparent pricing
          </h1>
          <p className="relative mt-3 text-base" style={{ color: 'rgba(255,255,255,0.6)' }}>
            Start free. Scale as you grow. No hidden fees.
          </p>

          {/* Billing toggle */}
          <div className="relative mt-8 inline-flex rounded-full p-1"
            style={{
              background: 'rgba(255,255,255,0.07)',
              border: '1px solid rgba(79,222,170,0.25)',
            }}>
            <button
              type="button"
              onClick={() => onIntervalChange("monthly")}
              className="rounded-full px-6 py-2 text-sm font-medium transition-all"
              style={interval === "monthly"
                ? { background: TEAL, color: NAVY }
                : { color: 'rgba(255,255,255,0.6)', background: 'transparent' }}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => onIntervalChange("annual")}
              className="rounded-full px-6 py-2 text-sm font-medium transition-all"
              style={interval === "annual"
                ? { background: TEAL, color: NAVY }
                : { color: 'rgba(255,255,255,0.6)', background: 'transparent' }}
            >
              Annual{" "}
              <span className="ml-1 text-xs font-semibold" style={{ color: TEAL }}>
                Save 20%
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Content ─────────────────────────────────────────────────────────── */}
      <div className="max-w-7xl mx-auto px-6 pb-24">

        {/* ── Plan cards ──────────────────────────────────────────────────── */}
        <section className="-mt-6 grid gap-5 lg:grid-cols-4">
          {loading
            ? Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={`plan-skeleton-${index}`} className="h-[470px] rounded-2xl" />
              ))
            : payload.plans.map((plan) => (
                <article
                  key={plan.code}
                  className="flex h-full flex-col rounded-2xl bg-white p-6"
                  style={{
                    border: `1.5px solid ${plan.highlighted ? TEAL : '#ddeee8'}`,
                    boxShadow: plan.highlighted
                      ? `0 0 40px ${TEAL}22, 0 8px 32px rgba(0,0,0,0.08)`
                      : '0 4px 16px rgba(18,41,74,0.06)',
                  }}
                >
                  <div className="mb-4 flex min-h-8 items-center">
                    {plan.badge ? (
                      <Badge className="border-0 text-xs font-semibold" style={badgeStyle(plan.badgeTone)}>
                        {plan.badge}
                      </Badge>
                    ) : null}
                  </div>

                  <h2 className="text-xl font-bold" style={{ color: NAVY }}>{plan.name.toUpperCase()}</h2>

                  <div className="mt-3 flex items-end gap-1">
                    <span className="text-4xl font-extrabold tracking-tight" style={{ color: NAVY }}>
                      {plan.priceDisplay}
                    </span>
                    {plan.periodLabel ? (
                      <span className="pb-1 text-xs" style={{ color: '#4b6280' }}>{plan.periodLabel}</span>
                    ) : null}
                  </div>

                  {plan.description ? (
                    <p className="mt-2 min-h-10 text-sm" style={{ color: '#4b6280' }}>{plan.description}</p>
                  ) : (
                    <div className="mt-2 min-h-10" />
                  )}

                  <ul className="mt-4 flex-1 space-y-2.5">
                    {plan.features.map((feature) => (
                      <li key={`${plan.code}-${feature}`} className="flex items-start gap-2 text-sm" style={{ color: '#334e68' }}>
                        <Check className="mt-0.5 h-4 w-4 shrink-0" style={{ color: TEAL_DIM }} />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>

                  {plan.code === "enterprise" ? (
                    <a
                      href="mailto:sales@opsai.ai"
                      className="mt-6 flex items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold transition hover:opacity-80"
                      style={{ border: `1.5px solid ${NAVY}33`, color: NAVY, background: 'transparent' }}
                    >
                      Contact Sales
                    </a>
                  ) : (
                    <Link to="/auth/signup" className="mt-6 block">
                      <button
                        className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition hover:opacity-90"
                        style={plan.highlighted
                          ? { background: TEAL, color: NAVY, border: 'none', boxShadow: `0 0 20px ${TEAL}44` }
                          : { background: 'transparent', color: NAVY, border: `1.5px solid ${NAVY}33` }}
                      >
                        Start Free Trial
                      </button>
                    </Link>
                  )}
                </article>
              ))}
        </section>

        {/* ── Feature comparison ──────────────────────────────────────────── */}
        <section className="mt-20 rounded-2xl overflow-hidden shadow-sm"
          style={{ border: `1px solid #ddeee8`, background: '#ffffff' }}>
          <div className="px-6 pt-6 pb-5" style={{ borderBottom: '1px solid #ddeee8' }}>
            <h3 className="text-2xl font-bold tracking-tight" style={{ color: NAVY }}>Feature Comparison</h3>
            <p className="mt-1 text-sm" style={{ color: '#4b6280' }}>Compare capabilities across plans.</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] border-collapse text-left">
              <thead>
                <tr style={{ background: '#F0F9F5', borderBottom: `2px solid #ddeee8` }}>
                  <th className="sticky left-0 z-10 px-5 py-4 text-xs font-semibold uppercase tracking-wide"
                    style={{ background: '#F0F9F5', color: NAVY }}>
                    Feature
                  </th>
                  {['Starter', 'Pro', 'Business', 'Enterprise'].map((col) => (
                    <th key={col} className="px-4 py-4 text-center text-xs font-semibold uppercase tracking-wide"
                      style={{ color: NAVY }}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 16 }).map((_, index) => (
                      <tr key={`comparison-skeleton-${index}`} style={{ borderBottom: '1px solid #f0f4f8' }}>
                        <td className="px-5 py-3"><Skeleton className="h-4 w-40" /></td>
                        <td className="px-4 py-3"><Skeleton className="mx-auto h-4 w-20" /></td>
                        <td className="px-4 py-3"><Skeleton className="mx-auto h-4 w-20" /></td>
                        <td className="px-4 py-3"><Skeleton className="mx-auto h-4 w-20" /></td>
                        <td className="px-4 py-3"><Skeleton className="mx-auto h-4 w-20" /></td>
                      </tr>
                    ))
                  : groupedRows.map(([category, rows]) => (
                      <Fragment key={`cat-${category}`}>
                        <tr style={{ background: '#F7FBF9', borderTop: '1px solid #ddeee8', borderBottom: '1px solid #ddeee8' }}>
                          <td colSpan={5} className="px-5 py-2.5 text-xs font-semibold uppercase tracking-wide"
                            style={{ color: TEAL_DIM }}>
                            {category}
                          </td>
                        </tr>
                        {rows.map((row) => (
                          <tr key={row.featureKey} className="transition-colors"
                            style={{ borderBottom: '1px solid #f0f4f8' }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = '#F7FBF9')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                            <td className="sticky left-0 bg-white px-5 py-3 text-sm" style={{ color: NAVY }}>
                              {row.featureName}
                            </td>
                            <td className="px-4 py-3 text-center">{renderComparisonValue(row.starter)}</td>
                            <td className="px-4 py-3 text-center">{renderComparisonValue(row.pro)}</td>
                            <td className="px-4 py-3 text-center">{renderComparisonValue(row.business)}</td>
                            <td className="px-4 py-3 text-center">{renderComparisonValue(row.enterprise)}</td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── FAQ ─────────────────────────────────────────────────────────── */}
        <section className="mx-auto mt-16 max-w-3xl rounded-2xl p-8 shadow-sm"
          style={{ background: '#ffffff', border: '1px solid #ddeee8' }}>
          <h3 className="text-2xl font-bold tracking-tight" style={{ color: NAVY }}>
            Frequently Asked Questions
          </h3>
          <p className="mt-1 text-sm" style={{ color: '#4b6280' }}>
            Answers to common pricing and billing questions.
          </p>

          <Accordion type="single" collapsible className="mt-6">
            {loading
              ? Array.from({ length: 6 }).map((_, index) => (
                  <div key={`faq-skeleton-${index}`} className="border-b py-4" style={{ borderColor: '#ddeee8' }}>
                    <Skeleton className="h-4 w-[75%]" />
                  </div>
                ))
              : payload.faq.map((item, index) => (
                  <AccordionItem
                    key={`${item.question}-${index}`}
                    value={`faq-${index}`}
                    style={{ borderColor: '#ddeee8' }}
                  >
                    <AccordionTrigger
                      className="text-left text-sm font-semibold no-underline hover:no-underline"
                      style={{ color: NAVY }}
                    >
                      {item.question}
                    </AccordionTrigger>
                    <AccordionContent className="text-sm leading-relaxed" style={{ color: '#4b6280' }}>
                      {item.answer}
                    </AccordionContent>
                  </AccordionItem>
                ))}
          </Accordion>
        </section>

        {/* ── CTA strip ───────────────────────────────────────────────────── */}
        <section className="mt-16 rounded-2xl p-14 text-center relative overflow-hidden"
          style={{ background: NAVY }}>
          <div className="absolute inset-0 pointer-events-none"
            style={{ background: `radial-gradient(ellipse at 50% 0%, ${TEAL}18, transparent 65%)` }} />
          <h2 className="relative text-2xl sm:text-3xl font-bold mb-4" style={{ color: '#ffffff' }}>
            Ready to automate your enterprise?
          </h2>
          <p className="relative text-base mb-8" style={{ color: 'rgba(255,255,255,0.6)' }}>
            Join hundreds of teams using OpsAI to connect, govern, and execute with AI.
          </p>
          <Link to="/auth/signup">
            <button
              className="relative inline-flex items-center gap-2 px-8 py-3 rounded-lg font-semibold text-base transition hover:opacity-90"
              style={{
                background: TEAL,
                color: NAVY,
                border: 'none',
                boxShadow: `0 0 40px ${TEAL}44`,
              }}
            >
              Start Free Trial <ArrowRight className="w-4 h-4" />
            </button>
          </Link>
        </section>
      </div>

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <footer style={{ background: NAVY2, borderTop: '1px solid rgba(79,222,170,0.1)' }} className="py-10">
        <div className="max-w-7xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <OpsAILogo height={28} opsColor="#ffffff" />
          </div>
          <p className="text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>
            © 2026 OpsAI. All rights reserved.
          </p>
          <div className="flex gap-6 text-xs" style={{ color: 'rgba(255,255,255,0.45)' }}>
            <Link to="/legal/privacy" className="hover:text-white transition-colors">Privacy</Link>
            <Link to="/legal/terms" className="hover:text-white transition-colors">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
