import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, CheckCircle2, Loader2, Plug, Star } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { formatEdgeFunctionError, sanitizeConnectionErrorMessage } from "@/lib/edge-function-error";
import { invokeEdge } from "@/lib/edge-invoke";
import { cn } from "@/lib/utils";

type Tier = "free" | "pro_plus" | "enterprise";

type IntegrationItem = {
  id: string;
  code: string;
  name: string;
  category: string;
  description: string;
  connectionType: "rest_api" | "oauth" | "webhook" | "hybrid";
  rating: number;
  reviews: number;
  teamsUsed: number;
  accessTier: Tier;
  installed: boolean;
  logoText: string;
  lastSyncedAt: string | null;
  installedAt: string | null;
  activeQueriesToday: number;
  docsUrl: string | null;
};

type CategoryItem = {
  key: string;
  label: string;
  count: number;
};

type MarketplacePayload = {
  summary: {
    total: number;
    installed: number;
    featured: number;
  };
  categories: CategoryItem[];
  featured: IntegrationItem[];
  integrations: IntegrationItem[];
};

const FALLBACK_CATEGORIES: CategoryItem[] = [
  { key: "all", label: "All", count: 0 },
  { key: "crm", label: "CRM", count: 0 },
  { key: "erp", label: "ERP", count: 0 },
  { key: "ticketing", label: "Ticketing", count: 0 },
  { key: "communication", label: "Communication", count: 0 },
  { key: "analytics", label: "Analytics", count: 0 },
  { key: "finance", label: "Finance", count: 0 },
  { key: "hr", label: "HR", count: 0 },
  { key: "ecommerce", label: "eCommerce", count: 0 },
];

const EMPTY_PAYLOAD: MarketplacePayload = {
  summary: {
    total: 0,
    installed: 0,
    featured: 0,
  },
  categories: FALLBACK_CATEGORIES,
  featured: [],
  integrations: [],
};

type TabMode = "all" | "installed";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Please try again.";
}

async function normalizeInvokeError(error: unknown, functionName: string) {
  const parsed = await formatEdgeFunctionError(error, { functionName });
  const fallback = normalizeError(error);
  return sanitizeConnectionErrorMessage(parsed || fallback);
}

function normalizeItem(value: unknown): IntegrationItem | null {
  const row = asRecord(value);
  if (!row) return null;

  const id = String(row.id ?? "").trim();
  const code = String(row.code ?? "").trim();
  const name = String(row.name ?? "").trim();
  if (!id || !code || !name) return null;

  const tier = String(row.accessTier ?? "free").toLowerCase();
  const connectionType = String(row.connectionType ?? "rest_api").toLowerCase();

  return {
    id,
    code,
    name,
    category: String(row.category ?? "Other"),
    description: String(row.description ?? "Extend AEAR with this integration."),
    connectionType: (["rest_api", "oauth", "webhook", "hybrid"].includes(connectionType)
      ? connectionType
      : "rest_api") as IntegrationItem["connectionType"],
    rating: toNumber(row.rating, 4.5),
    reviews: Math.max(0, Math.floor(toNumber(row.reviews))),
    teamsUsed: Math.max(0, Math.floor(toNumber(row.teamsUsed))),
    accessTier: (["free", "pro_plus", "enterprise"].includes(tier) ? tier : "free") as Tier,
    installed: Boolean(row.installed),
    logoText: String(row.logoText ?? name[0] ?? "I").slice(0, 1).toUpperCase(),
    lastSyncedAt: row.lastSyncedAt ? String(row.lastSyncedAt) : null,
    installedAt: row.installedAt ? String(row.installedAt) : null,
    activeQueriesToday: Math.max(0, Math.floor(toNumber(row.activeQueriesToday))),
    docsUrl: row.docsUrl ? String(row.docsUrl) : null,
  };
}

function normalizePayload(value: unknown): MarketplacePayload {
  const raw = asRecord(value);
  if (!raw) return EMPTY_PAYLOAD;

  const summary = asRecord(raw.summary);

  const categories = Array.isArray(raw.categories)
    ? raw.categories
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const key = String(row.key ?? "").trim().toLowerCase();
          const label = String(row.label ?? "").trim();
          if (!key || !label) return null;
          return {
            key,
            label,
            count: Math.max(0, Math.floor(toNumber(row.count))),
          } satisfies CategoryItem;
        })
        .filter((item): item is CategoryItem => Boolean(item))
    : FALLBACK_CATEGORIES;

  const featured = Array.isArray(raw.featured)
    ? raw.featured.map(normalizeItem).filter((item): item is IntegrationItem => Boolean(item))
    : [];

  const integrations = Array.isArray(raw.integrations)
    ? raw.integrations.map(normalizeItem).filter((item): item is IntegrationItem => Boolean(item))
    : [];

  return {
    summary: {
      total: Math.max(0, Math.floor(toNumber(summary?.total))),
      installed: Math.max(0, Math.floor(toNumber(summary?.installed))),
      featured: Math.max(0, Math.floor(toNumber(summary?.featured))),
    },
    categories: categories.length > 0 ? categories : FALLBACK_CATEGORIES,
    featured,
    integrations,
  };
}

function tierLabel(tier: Tier) {
  if (tier === "pro_plus") return "Pro+";
  if (tier === "enterprise") return "Enterprise";
  return "Free";
}

function tierClass(tier: Tier) {
  if (tier === "enterprise") return "bg-amber-100 text-amber-800";
  if (tier === "pro_plus") return "bg-violet-100 text-violet-800";
  return "bg-emerald-100 text-emerald-800";
}

function connectionTypeLabel(type: IntegrationItem["connectionType"]) {
  if (type === "rest_api") return "REST API";
  if (type === "oauth") return "OAuth";
  if (type === "webhook") return "Webhook";
  return "Hybrid";
}

function logoColor(code: string) {
  const colors = [
    "from-violet-500 to-purple-600",
    "from-blue-500 to-cyan-600",
    "from-emerald-500 to-green-600",
    "from-amber-500 to-orange-600",
    "from-rose-500 to-pink-600",
    "from-indigo-500 to-blue-700",
  ];
  let hash = 0;
  for (let i = 0; i < code.length; i += 1) {
    hash = (hash << 5) - hash + code.charCodeAt(i);
    hash |= 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

function formatTeams(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function relativeTime(value: string | null) {
  if (!value) return "Not synced yet";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "Not synced yet";
  const diffMs = Date.now() - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

export default function Marketplace() {
  const { toast } = useToast();
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [tab, setTab] = useState<TabMode>("all");
  const [loading, setLoading] = useState(true);
  const [actionCode, setActionCode] = useState<string | null>(null);
  const [payload, setPayload] = useState<MarketplacePayload>(EMPTY_PAYLOAD);

  const loadPayload = useCallback(
    async (params?: { search?: string; category?: string; installedOnly?: boolean }) => {
      setLoading(true);
      try {
        const { data, error } = await invokeEdge("marketplace-directory", {
          body: {
            operation: "get_payload",
            search: params?.search ?? search,
            category: params?.category ?? activeCategory,
            installedOnly: params?.installedOnly ?? (tab === "installed"),
          },
        });

        if (error) throw error;
        const response = asRecord(data);
        setPayload(normalizePayload(response?.payload));
      } catch (error) {
        const description = await normalizeInvokeError(error, "marketplace-directory");
        toast({
          title: "Could not load marketplace",
          description,
          variant: "destructive",
        });
      } finally {
        setLoading(false);
      }
    },
    [activeCategory, search, tab, toast],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPayload();
    }, 220);

    return () => window.clearTimeout(timer);
  }, [activeCategory, loadPayload, search, tab]);

  const runAction = useCallback(
    async (operation: "install" | "configure" | "uninstall", integration: IntegrationItem) => {
      setActionCode(`${operation}:${integration.code}`);
      try {
        const { data, error } = await invokeEdge("marketplace-directory", {
          body: {
            operation,
            integrationCode: integration.code,
            search,
            category: activeCategory,
            installedOnly: tab === "installed",
          },
        });

        if (error) throw error;
        const response = asRecord(data);
        setPayload(normalizePayload(response?.payload));

        if (operation === "install") {
          toast({
            title: `${integration.name} installed`,
            description: "Opening connection setup flow.",
          });
          navigate(`/dashboard/connections?marketplace=${encodeURIComponent(integration.code)}`);
          return;
        }

        if (operation === "configure") {
          toast({
            title: `${integration.name} ready to configure`,
            description: "Opening connections page for setup and credentials.",
          });
          navigate(`/dashboard/connections?marketplace=${encodeURIComponent(integration.code)}`);
          return;
        }

        toast({
          title: `${integration.name} uninstalled`,
          description: "Integration removed from installed list.",
        });
      } catch (error) {
        const description = await normalizeInvokeError(error, "marketplace-directory");
        toast({
          title: `Could not ${operation} integration`,
          description,
          variant: "destructive",
        });
      } finally {
        setActionCode(null);
      }
    },
    [activeCategory, navigate, search, tab, toast],
  );

  const categories = useMemo(() => {
    const fromPayload = payload.categories.length > 0 ? payload.categories : FALLBACK_CATEGORIES;
    const hasAll = fromPayload.some((item) => item.key === "all");
    return hasAll ? fromPayload : [{ key: "all", label: "All", count: payload.summary.total }, ...fromPayload];
  }, [payload.categories, payload.summary.total]);

  const integrationsToRender = payload.integrations;
  const showFeatured = tab === "all" && activeCategory === "all" && search.trim().length === 0;

  return (
    <div className="space-y-6 animate-fade-in">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Integration Marketplace</h1>
        <p className="text-sm text-muted-foreground">Browse tools to extend AEAR&apos;s capabilities.</p>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="w-full lg:max-w-md">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search integrations..."
            />
          </div>

          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">
            <button
              type="button"
              onClick={() => setTab("all")}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition",
                tab === "all" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900",
              )}
            >
              All Integrations ({payload.summary.total})
            </button>
            <button
              type="button"
              onClick={() => setTab("installed")}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition",
                tab === "installed" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900",
              )}
            >
              Installed ({payload.summary.installed})
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {categories.map((category) => (
            <button
              key={category.key}
              type="button"
              onClick={() => setActiveCategory(category.key)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition",
                activeCategory === category.key
                  ? "border-violet-300 bg-violet-100 text-violet-800"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900",
              )}
            >
              {category.label}
              <span className="ml-1 text-[10px] text-slate-500">{category.count}</span>
            </button>
          ))}
        </div>
      </section>

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-44 w-full rounded-xl" />
          <Skeleton className="h-80 w-full rounded-xl" />
        </div>
      ) : (
        <>
          {showFeatured ? (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-slate-900">Featured Integrations</h2>
                <p className="text-xs text-slate-500">Top picks for fast enterprise onboarding</p>
              </div>

              <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
                {payload.featured.map((integration) => (
                  <article
                    key={`featured-${integration.id}`}
                    className="rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50 via-white to-indigo-50 p-4 shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className={cn("inline-flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br text-sm font-bold text-white", logoColor(integration.code))}>
                        {integration.logoText}
                      </div>
                      <Badge className={cn("border-0", tierClass(integration.accessTier))}>{tierLabel(integration.accessTier)}</Badge>
                    </div>
                    <h3 className="mt-3 text-base font-semibold text-slate-900">{integration.name}</h3>
                    <p className="mt-1 line-clamp-2 text-sm text-slate-600">{integration.description}</p>
                    <p className="mt-2 text-xs text-slate-500">{connectionTypeLabel(integration.connectionType)} • {integration.category}</p>
                    <Button
                      className="mt-4 w-full bg-violet-600 text-white hover:bg-violet-700"
                      disabled={actionCode === `install:${integration.code}`}
                      onClick={() => void runAction(integration.installed ? "configure" : "install", integration)}
                    >
                      {actionCode === `install:${integration.code}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                      {integration.installed ? "Configure" : "Install"}
                    </Button>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">
                {tab === "installed" ? "Installed Integrations" : "Integration Directory"}
              </h2>
              <p className="text-xs text-slate-500">{integrationsToRender.length} results</p>
            </div>

            {integrationsToRender.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-12 text-center">
                <p className="text-sm font-medium text-slate-700">No integrations found.</p>
                <p className="mt-1 text-xs text-slate-500">Try another search or category filter.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {integrationsToRender.map((integration) => {
                  const actionKeyInstall = `install:${integration.code}`;
                  const actionKeyConfigure = `configure:${integration.code}`;
                  const actionKeyUninstall = `uninstall:${integration.code}`;

                  return (
                    <article key={integration.id} className="flex h-full flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                      <div className="flex items-start justify-between gap-2">
                        <div className={cn("inline-flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br text-sm font-bold text-white", logoColor(integration.code))}>
                          {integration.logoText}
                        </div>
                        <Badge className={cn("border-0", tierClass(integration.accessTier))}>{tierLabel(integration.accessTier)}</Badge>
                      </div>

                      <h3 className="mt-3 text-base font-semibold text-slate-900">{integration.name}</h3>
                      <Badge variant="outline" className="mt-1 w-fit border-slate-300 text-slate-700">{integration.category}</Badge>
                      <p className="mt-2 line-clamp-3 text-sm text-slate-600">{integration.description}</p>

                      <div className="mt-3 space-y-1 text-xs text-slate-500">
                        <p>Connection: {connectionTypeLabel(integration.connectionType)}</p>
                        <div className="flex items-center gap-1">
                          <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                          <span>{integration.rating.toFixed(1)} ({integration.reviews} reviews)</span>
                        </div>
                        <p>Used by {formatTeams(integration.teamsUsed)} teams</p>
                      </div>

                      {tab === "installed" || integration.installed ? (
                        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                          <p>Last synced: {relativeTime(integration.lastSyncedAt)}</p>
                          <p>Active queries today: {integration.activeQueriesToday}</p>
                        </div>
                      ) : null}

                      <div className="mt-4 flex flex-wrap gap-2">
                        {tab === "installed" || integration.installed ? (
                          <>
                            <Button
                              size="sm"
                              className="bg-violet-600 text-white hover:bg-violet-700"
                              disabled={actionCode === actionKeyConfigure}
                              onClick={() => void runAction("configure", integration)}
                            >
                              {actionCode === actionKeyConfigure ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                              Configure
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-rose-200 text-rose-700 hover:bg-rose-50"
                              disabled={actionCode === actionKeyUninstall}
                              onClick={() => void runAction("uninstall", integration)}
                            >
                              {actionCode === actionKeyUninstall ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                              Uninstall
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            className="bg-violet-600 text-white hover:bg-violet-700"
                            disabled={actionCode === actionKeyInstall}
                            onClick={() => void runAction("install", integration)}
                          >
                            {actionCode === actionKeyInstall ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                            Install
                          </Button>
                        )}

                        {integration.docsUrl ? (
                          <Button size="sm" variant="outline" asChild>
                            <a href={integration.docsUrl} target="_blank" rel="noreferrer">Docs</a>
                          </Button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      <section className="rounded-xl border border-violet-200 bg-violet-50 p-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-violet-900">Building an integration?</p>
            <p className="text-xs text-violet-700">Submit it to our marketplace and extend AEAR for every workspace.</p>
          </div>
          <Button variant="outline" className="border-violet-300 bg-white text-violet-800 hover:bg-violet-100" asChild>
            <a href="mailto:integrations@aear.io?subject=AEAR%20Marketplace%20Submission">
              Submit your integration
              <ArrowRight className="h-4 w-4" />
            </a>
          </Button>
        </div>
      </section>

      {tab === "installed" && payload.summary.installed > 0 ? (
        <div className="inline-flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          <CheckCircle2 className="h-4 w-4" />
          {payload.summary.installed} integrations installed for this workspace.
        </div>
      ) : null}
    </div>
  );
}
