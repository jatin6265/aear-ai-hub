import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  AlertTriangle,
  CreditCard,
  Download,
  Eye,
  FileText,
  Loader2,
} from "lucide-react";
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdge } from "@/lib/edge-invoke";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { cn } from "@/lib/utils";

type PlanPayload = {
  code: string;
  name: string;
  status: string;
  billingCycle: string;
  priceMonthlyCents: number | null;
  renewalDate: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  trialDaysRemaining: number | null;
};

type MeterPayload = {
  key: string;
  label: string;
  used: number;
  limit: number | null;
  unit: string;
  unlimited: boolean;
};

type TokenUsagePoint = {
  date: string;
  tokens: number;
};

type CostBreakdownPoint = {
  name: string;
  credits: number;
  costUsd: number;
};

type BillingAddress = {
  companyName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  stateRegion: string;
  postalCode: string;
  countryCode: string;
  taxNumber: string;
};

type PaymentMethod = {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  status: string;
};

type BillingPayload = {
  plan: PlanPayload;
  meters: MeterPayload[];
  charts: {
    tokenUsageByDay: TokenUsagePoint[];
    costBreakdown: CostBreakdownPoint[];
  };
  paymentMethod: PaymentMethod;
  billingAddress: BillingAddress;
};

type InvoiceStatus = "paid" | "pending" | "failed" | "void";

type InvoiceRow = {
  id: string;
  invoiceNumber: string;
  period: string;
  amountCents: number;
  currency: string;
  status: InvoiceStatus;
  invoiceDate: string | null;
  dueDate: string | null;
  paymentDate: string | null;
  pdfUrl: string | null;
};

type LatestFailedInvoice = {
  id: string;
  invoiceNumber: string;
  period: string;
  amountCents: number;
  currency: string;
};

type InvoiceHistoryPayload = {
  year: number;
  invoices: InvoiceRow[];
  latestFailed: LatestFailedInvoice | null;
  yearlyTotalSpentCents: number;
  downloadZipName: string;
};

type InvoiceLineItem = {
  label: string;
  amountCents: number;
};

type InvoiceDetailPayload = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string;
  status: InvoiceStatus;
  paymentDate: string | null;
  pdfUrl: string | null;
  billTo: BillingAddress;
  lineItems: InvoiceLineItem[];
};

const EMPTY_PAYLOAD: BillingPayload = {
  plan: {
    code: "starter",
    name: "Starter Plan",
    status: "trial",
    billingCycle: "monthly",
    priceMonthlyCents: 4900,
    renewalDate: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    trialEndsAt: null,
    trialDaysRemaining: null,
  },
  meters: [],
  charts: {
    tokenUsageByDay: [],
    costBreakdown: [],
  },
  paymentMethod: {
    brand: "visa",
    last4: "4242",
    expMonth: 12,
    expYear: new Date().getFullYear() + 3,
    status: "active",
  },
  billingAddress: {
    companyName: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    stateRegion: "",
    postalCode: "",
    countryCode: "US",
    taxNumber: "",
  },
};

const EMPTY_INVOICES: InvoiceHistoryPayload = {
  year: new Date().getFullYear(),
  invoices: [],
  latestFailed: null,
  yearlyTotalSpentCents: 0,
  downloadZipName: `aear-invoices-${new Date().getFullYear()}.zip`,
};

const COST_COLORS = ["#7c3aed", "#0ea5e9", "#f59e0b", "#ef4444"];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeInvoiceStatus(value: unknown): InvoiceStatus {
  const status = String(value ?? "").trim().toLowerCase();
  if (status === "paid" || status === "pending" || status === "failed" || status === "void") return status;
  return "pending";
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(value));
}

function formatCurrency(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDateLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return format(date, "MMM d");
}

function formatIsoDate(value: string | null) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return format(date, "MMM d, yyyy");
}

function formatMeterValue(meter: MeterPayload) {
  if (meter.unit === "GB") return `${meter.used.toFixed(1)} GB`;
  if (meter.unit === "tokens") return formatCompact(meter.used);
  return formatCount(meter.used);
}

function formatMeterLimit(meter: MeterPayload) {
  if (meter.unlimited || meter.limit === null) return "unlimited";
  if (meter.unit === "GB") return `${meter.limit.toFixed(1)} GB`;
  if (meter.unit === "tokens") return formatCompact(meter.limit);
  return formatCount(meter.limit);
}

function meterPercent(meter: MeterPayload) {
  if (meter.unlimited || meter.limit === null || meter.limit <= 0) return 42;
  return Math.max(0, Math.min(100, Math.round((meter.used / meter.limit) * 100)));
}

function normalizeBillingPayload(value: unknown): BillingPayload {
  const raw = asRecord(value);
  if (!raw) return EMPTY_PAYLOAD;

  const planRaw = asRecord(raw.plan);
  const chartsRaw = asRecord(raw.charts);
  const paymentRaw = asRecord(raw.paymentMethod);
  const billingAddressRaw = asRecord(raw.billingAddress);

  const meters = Array.isArray(raw.meters)
    ? raw.meters
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          return {
            key: String(row.key ?? ""),
            label: String(row.label ?? ""),
            used: toNumber(row.used),
            limit: row.limit === null || row.limit === undefined ? null : toNumber(row.limit),
            unit: String(row.unit ?? "count"),
            unlimited: row.unlimited === true,
          } satisfies MeterPayload;
        })
        .filter((item): item is MeterPayload => Boolean(item) && item.key.length > 0)
    : [];

  const tokenUsageByDay = Array.isArray(chartsRaw?.tokenUsageByDay)
    ? chartsRaw.tokenUsageByDay
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          return {
            date: String(row.date ?? ""),
            tokens: toNumber(row.tokens),
          } satisfies TokenUsagePoint;
        })
        .filter((item): item is TokenUsagePoint => Boolean(item) && item.date.length > 0)
    : [];

  const costBreakdown = Array.isArray(chartsRaw?.costBreakdown)
    ? chartsRaw.costBreakdown
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          return {
            name: String(row.name ?? "Unknown"),
            credits: toNumber(row.credits),
            costUsd: toNumber(row.costUsd),
          } satisfies CostBreakdownPoint;
        })
        .filter((item): item is CostBreakdownPoint => Boolean(item))
    : [];

  return {
    plan: {
      code: String(planRaw?.code ?? "starter"),
      name: String(planRaw?.name ?? "Starter Plan"),
      status: String(planRaw?.status ?? "trial"),
      billingCycle: String(planRaw?.billingCycle ?? "monthly"),
      priceMonthlyCents: planRaw?.priceMonthlyCents === null ? null : toNumber(planRaw?.priceMonthlyCents, 0),
      renewalDate: planRaw?.renewalDate ? String(planRaw.renewalDate) : null,
      currentPeriodStart: planRaw?.currentPeriodStart ? String(planRaw.currentPeriodStart) : null,
      currentPeriodEnd: planRaw?.currentPeriodEnd ? String(planRaw.currentPeriodEnd) : null,
      trialEndsAt: planRaw?.trialEndsAt ? String(planRaw.trialEndsAt) : null,
      trialDaysRemaining: planRaw?.trialDaysRemaining === null ? null : toNumber(planRaw?.trialDaysRemaining, 0),
    },
    meters,
    charts: {
      tokenUsageByDay,
      costBreakdown,
    },
    paymentMethod: {
      brand: String(paymentRaw?.brand ?? "visa"),
      last4: String(paymentRaw?.last4 ?? "4242"),
      expMonth: toNumber(paymentRaw?.expMonth, 12),
      expYear: toNumber(paymentRaw?.expYear, new Date().getFullYear() + 3),
      status: String(paymentRaw?.status ?? "active"),
    },
    billingAddress: {
      companyName: String(billingAddressRaw?.companyName ?? ""),
      addressLine1: String(billingAddressRaw?.addressLine1 ?? ""),
      addressLine2: String(billingAddressRaw?.addressLine2 ?? ""),
      city: String(billingAddressRaw?.city ?? ""),
      stateRegion: String(billingAddressRaw?.stateRegion ?? ""),
      postalCode: String(billingAddressRaw?.postalCode ?? ""),
      countryCode: String(billingAddressRaw?.countryCode ?? "US"),
      taxNumber: String(billingAddressRaw?.taxNumber ?? ""),
    },
  };
}

function normalizeInvoiceHistory(value: unknown): InvoiceHistoryPayload {
  const raw = asRecord(value);
  if (!raw) return EMPTY_INVOICES;

  const latestFailedRaw = asRecord(raw.latestFailed);

  const invoices = Array.isArray(raw.invoices)
    ? raw.invoices
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          return {
            id: String(row.id ?? ""),
            invoiceNumber: String(row.invoiceNumber ?? ""),
            period: String(row.period ?? "N/A"),
            amountCents: toNumber(row.amountCents),
            currency: String(row.currency ?? "usd"),
            status: normalizeInvoiceStatus(row.status),
            invoiceDate: row.invoiceDate ? String(row.invoiceDate) : null,
            dueDate: row.dueDate ? String(row.dueDate) : null,
            paymentDate: row.paymentDate ? String(row.paymentDate) : null,
            pdfUrl: row.pdfUrl ? String(row.pdfUrl) : null,
          } satisfies InvoiceRow;
        })
        .filter((item): item is InvoiceRow => Boolean(item) && item.id.length > 0)
    : [];

  return {
    year: toNumber(raw.year, new Date().getFullYear()),
    invoices,
    latestFailed: latestFailedRaw
      ? {
          id: String(latestFailedRaw.id ?? ""),
          invoiceNumber: String(latestFailedRaw.invoiceNumber ?? ""),
          period: String(latestFailedRaw.period ?? "N/A"),
          amountCents: toNumber(latestFailedRaw.amountCents),
          currency: String(latestFailedRaw.currency ?? "usd"),
        }
      : null,
    yearlyTotalSpentCents: toNumber(raw.yearlyTotalSpentCents),
    downloadZipName: String(raw.downloadZipName ?? `aear-invoices-${new Date().getFullYear()}.zip`),
  };
}

function normalizeInvoiceDetail(value: unknown): InvoiceDetailPayload | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const billToRaw = asRecord(raw.billTo);
  const lineItems = Array.isArray(raw.lineItems)
    ? raw.lineItems
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          return {
            label: String(row.label ?? ""),
            amountCents: toNumber(row.amountCents),
          } satisfies InvoiceLineItem;
        })
        .filter((item): item is InvoiceLineItem => Boolean(item) && item.label.length > 0)
    : [];

  return {
    id: String(raw.id ?? ""),
    invoiceNumber: String(raw.invoiceNumber ?? ""),
    invoiceDate: raw.invoiceDate ? String(raw.invoiceDate) : null,
    dueDate: raw.dueDate ? String(raw.dueDate) : null,
    currency: String(raw.currency ?? "usd"),
    status: normalizeInvoiceStatus(raw.status),
    paymentDate: raw.paymentDate ? String(raw.paymentDate) : null,
    pdfUrl: raw.pdfUrl ? String(raw.pdfUrl) : null,
    billTo: {
      companyName: String(billToRaw?.companyName ?? ""),
      addressLine1: String(billToRaw?.addressLine1 ?? ""),
      addressLine2: String(billToRaw?.addressLine2 ?? ""),
      city: String(billToRaw?.city ?? ""),
      stateRegion: String(billToRaw?.stateRegion ?? ""),
      postalCode: String(billToRaw?.postalCode ?? ""),
      countryCode: String(billToRaw?.countryCode ?? "US"),
      taxNumber: "",
    },
    lineItems,
  };
}

function invoiceStatusBadgeClass(status: InvoiceStatus) {
  if (status === "paid") return "border-0 bg-emerald-100 text-emerald-800";
  if (status === "failed") return "border-0 bg-red-100 text-red-800";
  if (status === "void") return "border-0 bg-slate-200 text-slate-700";
  return "border-0 bg-amber-100 text-amber-800";
}

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9-_]/g, "_");
}

function triggerDownloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function Billing() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<BillingPayload>(EMPTY_PAYLOAD);
  const [invoiceHistory, setInvoiceHistory] = useState<InvoiceHistoryPayload>(EMPTY_INVOICES);
  const [invoiceDetailOpen, setInvoiceDetailOpen] = useState(false);
  const [invoiceDetailLoading, setInvoiceDetailLoading] = useState(false);
  const [invoiceDetail, setInvoiceDetail] = useState<InvoiceDetailPayload | null>(null);
  const [retryingInvoiceId, setRetryingInvoiceId] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    try {
      await ensureUserWorkspace(user);

      const [dashboardRes, invoiceRes] = await Promise.all([
        invokeEdge("tenant-billing-dashboard", {
          body: { windowDays: 30 },
        }),
        invokeEdge("billing-invoices", {
          body: { operation: "get_payload", year: new Date().getFullYear() },
        }),
      ]);

      if (dashboardRes.error) throw dashboardRes.error;
      setPayload(normalizeBillingPayload(asRecord(dashboardRes.data)?.payload));

      if (invoiceRes.error) {
        toast({
          title: "Could not load invoices",
          description: invoiceRes.error.message,
          variant: "destructive",
        });
      } else {
        setInvoiceHistory(normalizeInvoiceHistory(asRecord(invoiceRes.data)?.payload));
      }
    } catch (error) {
      toast({
        title: "Could not load billing dashboard",
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

  const trialBanner = useMemo(() => {
    const remaining = payload.plan.trialDaysRemaining;
    if (remaining === null || remaining <= 0) return null;
    if (!["trial", "trialing"].includes(payload.plan.status)) return null;
    return `Free trial ends in ${remaining} day${remaining === 1 ? "" : "s"}. Add payment method to continue.`;
  }, [payload.plan.status, payload.plan.trialDaysRemaining]);

  const planPriceText = useMemo(() => {
    if (payload.plan.priceMonthlyCents === null) return "Custom";
    return `${formatCurrency(payload.plan.priceMonthlyCents / 100)}/mo`;
  }, [payload.plan.priceMonthlyCents]);

  const renewalText = useMemo(() => {
    return payload.plan.renewalDate ? `Renews ${formatIsoDate(payload.plan.renewalDate)}` : "Renewal date pending";
  }, [payload.plan.renewalDate]);

  const totalCost = useMemo(
    () => payload.charts.costBreakdown.reduce((sum, item) => sum + item.costUsd, 0),
    [payload.charts.costBreakdown],
  );

  const failedInvoiceText = useMemo(() => {
    if (!invoiceHistory.latestFailed) return null;
    return `Payment failed for ${invoiceHistory.latestFailed.period}. Update your payment method.`;
  }, [invoiceHistory.latestFailed]);

  const openInvoiceDetail = async (invoiceId: string) => {
    setInvoiceDetailOpen(true);
    setInvoiceDetailLoading(true);
    setInvoiceDetail(null);
    try {
      const { data, error } = await invokeEdge("billing-invoices", {
        body: { operation: "get_invoice_detail", invoiceId },
      });
      if (error) throw error;
      const detail = normalizeInvoiceDetail(asRecord(data)?.payload);
      if (!detail) throw new Error("Invalid invoice detail payload");
      setInvoiceDetail(detail);
    } catch (error) {
      setInvoiceDetailOpen(false);
      toast({
        title: "Could not load invoice detail",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setInvoiceDetailLoading(false);
    }
  };

  const handleRetryPayment = async (invoiceId: string) => {
    setRetryingInvoiceId(invoiceId);
    try {
      const { error } = await invokeEdge("billing-invoices", {
        body: { operation: "retry_payment", invoiceId },
      });
      if (error) throw error;
      toast({
        title: "Retry requested",
        description: "Payment retry has been queued.",
      });
      await load();
    } catch (error) {
      toast({
        title: "Could not retry payment",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setRetryingInvoiceId(null);
    }
  };

  const downloadPdf = (invoice: InvoiceRow | InvoiceDetailPayload) => {
    if (!invoice.pdfUrl) {
      toast({
        title: "PDF unavailable",
        description: "This invoice does not have a PDF URL yet.",
        variant: "destructive",
      });
      return;
    }
    window.open(invoice.pdfUrl, "_blank", "noopener,noreferrer");
  };

  const downloadInvoicesZip = async () => {
    if (invoiceHistory.invoices.length === 0) {
      toast({
        title: "No invoices available",
        description: "There are no invoices to download for this year.",
      });
      return;
    }

    setDownloadingZip(true);
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();

      const csvHeader = "invoice_number,period,amount_cents,status,invoice_date,due_date,pdf_url";
      const csvRows = invoiceHistory.invoices.map((invoice) =>
        [
          invoice.invoiceNumber,
          invoice.period,
          invoice.amountCents,
          invoice.status,
          invoice.invoiceDate ?? "",
          invoice.dueDate ?? "",
          invoice.pdfUrl ?? "",
        ]
          .map((value) => `"${String(value).replace(/"/g, '""')}"`)
          .join(","),
      );
      zip.file("invoice-summary.csv", [csvHeader, ...csvRows].join("\n"));

      for (const invoice of invoiceHistory.invoices) {
        const baseName = safeFileName(`${invoice.invoiceNumber}-${invoice.period}`);
        if (!invoice.pdfUrl) {
          zip.file(`${baseName}.txt`, "PDF URL not available for this invoice.");
          continue;
        }
        try {
          const response = await fetch(invoice.pdfUrl);
          if (!response.ok) throw new Error(`Failed with status ${response.status}`);
          const blob = await response.blob();
          zip.file(`${baseName}.pdf`, blob);
        } catch {
          zip.file(`${baseName}.txt`, `Could not fetch PDF. URL: ${invoice.pdfUrl}`);
        }
      }

      const blob = await zip.generateAsync({ type: "blob" });
      triggerDownloadBlob(blob, invoiceHistory.downloadZipName || `aear-invoices-${invoiceHistory.year}.zip`);
    } catch (error) {
      toast({
        title: "ZIP download failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setDownloadingZip(false);
    }
  };

  return (
    <div className="space-y-6 pb-8">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Subscription & Usage</h1>
        <p className="mt-1 text-sm text-slate-600">Monitor your current plan, consumption, and payment details.</p>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        {loading ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-semibold text-slate-900">{payload.plan.name}</h2>
                  <Badge className="border-0 bg-violet-100 text-violet-800">{payload.plan.name}</Badge>
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  {planPriceText} · {renewalText}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button className="bg-violet-600 hover:bg-violet-700" asChild>
                  <Link to="/dashboard/billing/upgrade">Upgrade Plan</Link>
                </Button>
                <Button variant="outline" asChild>
                  <Link to="/dashboard/billing/upgrade">Manage Subscription</Link>
                </Button>
              </div>
            </div>

            {trialBanner ? (
              <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{trialBanner}</span>
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4">
          <h3 className="text-base font-semibold text-slate-900">Usage Meters</h3>
          <p className="text-sm text-slate-600">Current billing period consumption against your plan limits.</p>
        </div>
        <div className="space-y-4">
          {loading
            ? Array.from({ length: 5 }).map((_, index) => <Skeleton key={`meter-${index}`} className="h-16 w-full" />)
            : payload.meters.map((meter) => {
                const percent = meterPercent(meter);
                const nearLimit = !meter.unlimited && percent >= 80 && percent < 100;
                const hardLimit = !meter.unlimited && percent >= 100;
                const barClass = meter.unlimited
                  ? "bg-blue-500"
                  : hardLimit
                    ? "bg-red-500"
                    : nearLimit
                      ? "bg-amber-500"
                      : "bg-emerald-500";

                return (
                  <div key={meter.key} className="space-y-2">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-sm font-medium text-slate-800">{meter.label}</p>
                      <div className="flex items-center gap-2">
                        <p className="text-xs text-slate-600">
                          {formatMeterValue(meter)} / {formatMeterLimit(meter)} used ({meter.unlimited ? "∞" : `${percent}%`})
                        </p>
                        {nearLimit ? <Badge className="border-0 bg-amber-100 text-amber-900">Approaching limit</Badge> : null}
                        {hardLimit ? <Badge className="border-0 bg-red-100 text-red-900">Upgrade to continue</Badge> : null}
                      </div>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                      <div className={cn("h-full rounded-full transition-all", barClass)} style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                );
              })}
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-semibold text-slate-900">Token usage by day</h3>
          <p className="mb-3 text-sm text-slate-600">Last 30 days</p>
          {loading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={payload.charts.tokenUsageByDay}>
                  <XAxis dataKey="date" tickFormatter={formatDateLabel} tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(value: number) => formatCompact(value)} tick={{ fontSize: 11 }} />
                  <Tooltip
                    formatter={(value: number) => [`${formatCount(value)} tokens`, "Usage"]}
                    labelFormatter={(label: string) => formatDateLabel(label)}
                  />
                  <Bar dataKey="tokens" fill="#7c3aed" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-semibold text-slate-900">Cost breakdown</h3>
          <p className="mb-3 text-sm text-slate-600">LLM / Storage / Executions / Overages</p>
          {loading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <div className="grid h-64 grid-cols-1 gap-4 md:grid-cols-[1fr_180px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={payload.charts.costBreakdown} dataKey="costUsd" nameKey="name" outerRadius={84} innerRadius={52}>
                    {payload.charts.costBreakdown.map((item, index) => (
                      <Cell key={`${item.name}-${index}`} fill={COST_COLORS[index % COST_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number) => formatCurrency(value)} />
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-2 self-center text-sm">
                {payload.charts.costBreakdown.map((item, index) => (
                  <div key={item.name} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-slate-700">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COST_COLORS[index % COST_COLORS.length] }} />
                      {item.name}
                    </span>
                    <span className="font-medium text-slate-900">{formatCurrency(item.costUsd)}</span>
                  </div>
                ))}
                <div className="pt-2 text-xs text-slate-500">Total estimated: {formatCurrency(totalCost)}</div>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Invoice History</h3>
            <p className="text-sm text-slate-600">Invoices for {invoiceHistory.year}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void downloadInvoicesZip()}
            disabled={loading || downloadingZip || invoiceHistory.invoices.length === 0}
          >
            {downloadingZip ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Download all invoices as ZIP
          </Button>
        </div>

        {failedInvoiceText ? (
          <div className="mb-4 flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-red-900">{failedInvoiceText}</p>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => invoiceHistory.latestFailed && void handleRetryPayment(invoiceHistory.latestFailed.id)}
                disabled={retryingInvoiceId === invoiceHistory.latestFailed?.id}
              >
                {retryingInvoiceId === invoiceHistory.latestFailed?.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Retry Payment
              </Button>
              <Button variant="link" size="sm" asChild>
                <a href="mailto:support@aear.ai">Contact Support</a>
              </Button>
            </div>
          </div>
        ) : null}

        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[760px] border-collapse">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Invoice #</th>
                <th className="px-3 py-2 font-medium">Period</th>
                <th className="px-3 py-2 font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 5 }).map((_, index) => (
                  <tr key={`invoice-skel-${index}`} className="border-t border-slate-100">
                    <td className="px-3 py-3"><Skeleton className="h-4 w-32" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-4 w-20" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-5 w-16 rounded-full" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-8 w-24" /></td>
                  </tr>
                ))
              ) : invoiceHistory.invoices.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-slate-500">
                    No invoices available for {invoiceHistory.year}.
                  </td>
                </tr>
              ) : (
                invoiceHistory.invoices.map((invoice) => (
                  <tr key={invoice.id} className="border-t border-slate-100">
                    <td className="px-3 py-3 text-sm font-medium text-slate-900">{invoice.invoiceNumber}</td>
                    <td className="px-3 py-3 text-sm text-slate-700">{invoice.period}</td>
                    <td className="px-3 py-3 text-sm text-slate-700">{formatCurrency(invoice.amountCents / 100, invoice.currency)}</td>
                    <td className="px-3 py-3 text-sm">
                      <Badge className={invoiceStatusBadgeClass(invoice.status)}>
                        {invoice.status === "paid" ? "Paid" : invoice.status === "failed" ? "Failed" : invoice.status === "void" ? "Void" : "Pending"}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-sm text-slate-700">{formatIsoDate(invoice.invoiceDate)}</td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" onClick={() => downloadPdf(invoice)} title="Download PDF">
                          <Download className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void openInvoiceDetail(invoice.id)}>
                          <Eye className="mr-1 h-4 w-4" />
                          View
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-col gap-2 border-t border-slate-200 pt-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="font-semibold text-slate-900">
            {invoiceHistory.year} Total Spent: {formatCurrency(invoiceHistory.yearlyTotalSpentCents / 100)}
          </p>
          <p className="text-xs text-slate-500">Includes paid invoices only.</p>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-900">Payment Method</h3>
            <Button variant="outline" size="sm">
              Update Payment Method
            </Button>
          </div>
          {loading ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <>
              <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="rounded-md bg-white p-2 text-slate-700 shadow-sm">
                  <CreditCard className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-medium capitalize text-slate-900">
                    {payload.paymentMethod.brand} ending in {payload.paymentMethod.last4}
                  </p>
                  <p className="text-xs text-slate-600">
                    Expires {String(payload.paymentMethod.expMonth).padStart(2, "0")}/{payload.paymentMethod.expYear}
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="mt-3 text-xs font-medium text-violet-700 underline underline-offset-4"
              >
                Add Backup Card
              </button>
            </>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-900">Billing Address</h3>
            <Button variant="outline" size="sm">
              Edit
            </Button>
          </div>
          {loading ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <div className="space-y-1 text-sm text-slate-700">
              <p className="font-medium text-slate-900">{payload.billingAddress.companyName || "Company name not set"}</p>
              <p>{payload.billingAddress.addressLine1 || "Address line 1 not set"}</p>
              {payload.billingAddress.addressLine2 ? <p>{payload.billingAddress.addressLine2}</p> : null}
              <p>
                {[payload.billingAddress.city, payload.billingAddress.stateRegion, payload.billingAddress.postalCode]
                  .filter(Boolean)
                  .join(", ") || "City/State/Postal not set"}
              </p>
              <p>{payload.billingAddress.countryCode || "US"}</p>
              <p className="pt-1 text-xs text-slate-500">VAT/GST: {payload.billingAddress.taxNumber || "Not provided"}</p>
            </div>
          )}
        </div>
      </section>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Refreshing billing metrics...
        </div>
      ) : null}

      <Dialog open={invoiceDetailOpen} onOpenChange={setInvoiceDetailOpen}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Invoice Detail</DialogTitle>
            <DialogDescription>Full invoice preview and line items.</DialogDescription>
          </DialogHeader>

          {invoiceDetailLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : invoiceDetail ? (
            <div className="space-y-5">
              <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="flex items-center gap-2 text-base font-semibold text-slate-900">
                    <FileText className="h-4 w-4 text-violet-600" />
                    AEAR
                  </p>
                  <p className="mt-2 text-sm text-slate-700">Invoice {invoiceDetail.invoiceNumber}</p>
                  <p className="text-xs text-slate-600">Invoice date: {formatIsoDate(invoiceDetail.invoiceDate)}</p>
                  <p className="text-xs text-slate-600">Due date: {formatIsoDate(invoiceDetail.dueDate)}</p>
                </div>
                <Badge className={invoiceStatusBadgeClass(invoiceDetail.status)}>
                  {invoiceDetail.status === "paid"
                    ? "Paid"
                    : invoiceDetail.status === "failed"
                      ? "Failed"
                      : invoiceDetail.status === "void"
                        ? "Void"
                        : "Pending"}
                </Badge>
              </div>

              <div className="rounded-xl border border-slate-200 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Bill to</p>
                <div className="mt-1 text-sm text-slate-700">
                  <p className="font-medium text-slate-900">{invoiceDetail.billTo.companyName || "Company name not set"}</p>
                  <p>{invoiceDetail.billTo.addressLine1 || "Address line 1 not set"}</p>
                  {invoiceDetail.billTo.addressLine2 ? <p>{invoiceDetail.billTo.addressLine2}</p> : null}
                  <p>
                    {[invoiceDetail.billTo.city, invoiceDetail.billTo.stateRegion, invoiceDetail.billTo.postalCode]
                      .filter(Boolean)
                      .join(", ") || "City/State/Postal not set"}
                  </p>
                  <p>{invoiceDetail.billTo.countryCode || "US"}</p>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full min-w-[520px] border-collapse">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Line Item</th>
                      <th className="px-3 py-2 font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoiceDetail.lineItems.map((item) => (
                      <tr key={item.label} className="border-t border-slate-100">
                        <td className="px-3 py-2 text-sm text-slate-700">{item.label}</td>
                        <td className="px-3 py-2 text-sm font-medium text-slate-900">
                          {formatCurrency(item.amountCents / 100, invoiceDetail.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700 sm:flex-row sm:items-center sm:justify-between">
                <p>
                  Payment status:{" "}
                  <span className="font-semibold text-slate-900">
                    {invoiceDetail.status === "paid"
                      ? "Paid"
                      : invoiceDetail.status === "failed"
                        ? "Failed"
                        : invoiceDetail.status === "void"
                          ? "Void"
                          : "Pending"}
                  </span>
                </p>
                <p>Payment date: {formatIsoDate(invoiceDetail.paymentDate)}</p>
              </div>

              <div className="flex justify-end">
                <Button onClick={() => downloadPdf(invoiceDetail)}>
                  <Download className="mr-2 h-4 w-4" />
                  Download PDF
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-600">Invoice detail is unavailable.</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

