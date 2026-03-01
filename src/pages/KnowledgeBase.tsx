import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  BookOpenText,
  Bot,
  Database,
  FileText,
  LayoutList,
  Link2,
  Loader2,
  Network,
  RotateCcw,
  Search,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdge } from "@/lib/edge-invoke";
import type { Database as SupabaseDatabase } from "@/integrations/supabase/types";
import { cn } from "@/lib/utils";

type KnowledgeChip = "all" | "tables" | "documents" | "entities" | "relationships";
type EntityTypeBadge = "Master Data" | "Transaction" | "Log" | "Config";
type SensitivityBadge = "Contains PII" | "Financial" | "Safe";

type GraphNode = { id: string; name: string; group: string; sourceKind: string; rowCount: number; sensitivity: string };
type GraphEdge = { source: string; target: string; type: string; label: string | null };
type GraphData  = { nodes: GraphNode[]; edges: GraphEdge[] };

type KnowledgeEntityRow =
  SupabaseDatabase["public"]["Functions"]["get_knowledge_entities"]["Returns"][number];
type KnowledgeStatsRow =
  SupabaseDatabase["public"]["Functions"]["get_knowledge_stats"]["Returns"][number];
type KnowledgeRecentQueryRow =
  SupabaseDatabase["public"]["Functions"]["get_knowledge_recent_queries"]["Returns"][number];

type KnowledgeEntityCard = {
  id: string;
  connectionId: string | null;
  connectionName: string;
  name: string;
  entityType: EntityTypeBadge;
  description: string;
  keyFields: string[];
  sensitivity: SensitivityBadge;
  rowCount: number;
  lastUpdated: string;
  embeddingCoverage: number;
  sourceKind: string;
  relationshipCount: number;
};

type KnowledgeStats = {
  totalEntities: number;
  embeddingsVectors: number;
  documentsIndexed: number;
  coveragePct: number;
  storageGb: number;
};

const CHIP_OPTIONS: Array<{ value: KnowledgeChip; label: string }> = [
  { value: "all", label: "All" },
  { value: "tables", label: "Tables" },
  { value: "documents", label: "Documents" },
  { value: "entities", label: "Entities" },
  { value: "relationships", label: "Relationships" },
];

const FALLBACK_RECENT_QUERIES = [
  "What is total revenue this month?",
  "List customers with overdue invoices",
];

function applyKnowledgeChipFilter(items: KnowledgeEntityCard[], chip: KnowledgeChip) {
  if (chip === "all") return items;
  if (chip === "documents") return items.filter((item) => item.sourceKind === "document");
  if (chip === "relationships") return items.filter((item) => item.relationshipCount > 0);
  if (chip === "tables" || chip === "entities") {
    return items.filter((item) => item.sourceKind !== "document");
  }
  return items;
}

function formatRelativeTime(value: string) {
  const now = Date.now();
  const then = new Date(value).getTime();
  const diffMs = now - then;
  if (diffMs < 60_000) return "Just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} min ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)} hr ago`;
  return `${Math.floor(diffMs / 86_400_000)} days ago`;
}

function mapEntityType(group: string): EntityTypeBadge {
  const value = group.toLowerCase();
  if (value === "master_data") return "Master Data";
  if (value === "transactions") return "Transaction";
  if (value === "logs") return "Log";
  return "Config";
}

function mapSensitivity(value: string): SensitivityBadge {
  const normalized = value.toLowerCase();
  if (normalized === "pii") return "Contains PII";
  if (normalized === "financial") return "Financial";
  return "Safe";
}

function entityTypeClass(value: EntityTypeBadge) {
  if (value === "Master Data") return "bg-blue-100 text-blue-700";
  if (value === "Transaction") return "bg-emerald-100 text-emerald-700";
  if (value === "Log") return "bg-amber-100 text-amber-700";
  return "bg-violet-100 text-violet-700";
}

function sensitivityClass(value: SensitivityBadge) {
  if (value === "Contains PII") return "bg-rose-100 text-rose-700";
  if (value === "Financial") return "bg-amber-100 text-amber-700";
  return "bg-slate-100 text-slate-700";
}

function entityIcon(entity: KnowledgeEntityCard) {
  if (entity.sourceKind === "document") return FileText;
  if (entity.relationshipCount > 0) return Link2;
  if (entity.entityType === "Config") return Bot;
  return Database;
}

// ── Org Graph SVG Visualization ───────────────────────────────────────────────
const GROUP_COLORS: Record<string, { fill: string; stroke: string; text: string }> = {
  master_data:  { fill: "#dbeafe", stroke: "#3b82f6", text: "#1e40af" },
  transactions: { fill: "#d1fae5", stroke: "#10b981", text: "#065f46" },
  logs:         { fill: "#fef3c7", stroke: "#f59e0b", text: "#92400e" },
  config:       { fill: "#ede9fe", stroke: "#7c3aed", text: "#4c1d95" },
};

function nodeColor(group: string) {
  return GROUP_COLORS[group] ?? { fill: "#f1f5f9", stroke: "#94a3b8", text: "#334155" };
}

function circleLayout(count: number, cx: number, cy: number, r: number) {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });
}

function OrgGraph({ data, loading }: { data: GraphData | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex h-[420px] items-center justify-center rounded-2xl border border-slate-200 bg-white">
        <Loader2 className="h-8 w-8 animate-spin text-violet-600" />
      </div>
    );
  }

  if (!data || data.nodes.length === 0) {
    return (
      <div className="flex h-[420px] items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white text-center">
        <div>
          <Network className="mx-auto h-10 w-10 text-slate-300" />
          <p className="mt-3 text-sm font-medium text-slate-500">No entity relationships found</p>
          <p className="mt-1 text-xs text-slate-400">Sync a connection to discover schema relationships.</p>
        </div>
      </div>
    );
  }

  const W = 680; const H = 420; const CX = W / 2; const CY = H / 2;
  const R = Math.min(CX - 80, CY - 60, 160 + data.nodes.length * 2);
  const positions = circleLayout(data.nodes.length, CX, CY, R);
  const posMap: Record<string, { x: number; y: number }> = {};
  data.nodes.forEach((n, i) => { posMap[n.id] = positions[i]; });

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-700">
          Organizational Data Graph — {data.nodes.length} entities, {data.edges.length} relationships
        </p>
        <div className="flex gap-3 text-xs text-slate-500">
          {Object.entries(GROUP_COLORS).map(([group, c]) => (
            <span key={group} className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full border" style={{ background: c.fill, borderColor: c.stroke }} />
              {group.replace("_", " ")}
            </span>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible" style={{ maxHeight: 380 }}>
        {/* Edges */}
        {data.edges.map((e, i) => {
          const s = posMap[e.source]; const t = posMap[e.target];
          if (!s || !t) return null;
          return (
            <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y}
              stroke="#cbd5e1" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.7} />
          );
        })}
        {/* Nodes */}
        {data.nodes.map((n, i) => {
          const pos = positions[i]; const c = nodeColor(n.group);
          const label = n.name.length > 14 ? n.name.slice(0, 13) + "…" : n.name;
          return (
            <g key={n.id} transform={`translate(${pos.x},${pos.y})`}>
              <circle r={18} fill={c.fill} stroke={c.stroke} strokeWidth={1.5} />
              <text y={32} textAnchor="middle" fontSize={9} fill={c.text} fontWeight={500}>{label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function KnowledgeBase() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [tenantId, setTenantId] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [activeChip, setActiveChip] = useState<KnowledgeChip>("all");
  const [readyForSearch, setReadyForSearch] = useState(false);
  const latestRequestIdRef = useRef(0);

  const [entities, setEntities] = useState<KnowledgeEntityCard[]>([]);
  const [stats, setStats] = useState<KnowledgeStats>({
    totalEntities: 0,
    embeddingsVectors: 0,
    documentsIndexed: 0,
    coveragePct: 0,
    storageGb: 0,
  });
  const [recentQueries, setRecentQueries] = useState<
    Array<{ id: string; content: string; createdAt: string }>
  >([]);
  const [reindexing, setReindexing] = useState(false);
  const [graphMode, setGraphMode] = useState(false);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, 260);

    return () => window.clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    if (user) return;
    setTenantId(null);
    setReadyForSearch(false);
    setEntities([]);
    setRecentQueries([]);
    setStats({
      totalEntities: 0,
      embeddingsVectors: 0,
      documentsIndexed: 0,
      coveragePct: 0,
      storageGb: 0,
    });
  }, [user]);

  const loadKnowledge = useCallback(
    async (
      workspaceTenantId: string,
      query: string,
      chip: KnowledgeChip,
      silent = false,
    ) => {
      const requestId = latestRequestIdRef.current + 1;
      latestRequestIdRef.current = requestId;

      if (!silent) setInitialLoading(true);
      else setSearchLoading(true);

      const [entitiesResponse, statsResponse, recentQueriesResponse] = await Promise.all([
        supabase.rpc("get_knowledge_entities", {
          p_query: query ? query : null,
          p_filter: chip,
          p_limit: 200,
        }),
        supabase.rpc("get_knowledge_stats"),
        supabase.rpc("get_knowledge_recent_queries", {
          p_limit: 8,
        }),
      ]);

      let mappedEntities: KnowledgeEntityCard[] = [];
      let nextStats: KnowledgeStats = {
        totalEntities: 0,
        embeddingsVectors: 0,
        documentsIndexed: 0,
        coveragePct: 0,
        storageGb: 0,
      };
      let nextRecentQueries: Array<{ id: string; content: string; createdAt: string }> = [];

      const rpcFailed = Boolean(entitiesResponse.error || statsResponse.error || recentQueriesResponse.error);
      if (!rpcFailed) {
        const entityRows = (entitiesResponse.data ?? []) as KnowledgeEntityRow[];
        mappedEntities = entityRows.map((entity) => ({
          id: entity.entity_id,
          connectionId: entity.connection_id,
          connectionName: entity.connection_name,
          name: entity.entity_name,
          entityType: mapEntityType(entity.entity_group),
          description: entity.description,
          keyFields: entity.key_fields.slice(0, 4),
          sensitivity: mapSensitivity(entity.sensitivity),
          rowCount: Number(entity.row_count ?? 0),
          lastUpdated: entity.last_updated,
          embeddingCoverage: Number(entity.embedding_coverage ?? 0),
          sourceKind: entity.source_kind,
          relationshipCount: entity.relationship_count ?? 0,
        }));

        const statsRow = ((statsResponse.data ?? [])[0] as KnowledgeStatsRow | undefined) ?? null;
        nextStats = statsRow
          ? {
              totalEntities: Number(statsRow.total_entities ?? 0),
              embeddingsVectors: Number(statsRow.embeddings_vectors ?? 0),
              documentsIndexed: Number(statsRow.documents_indexed ?? 0),
              coveragePct: Number(statsRow.coverage_pct ?? 0),
              storageGb: Number(statsRow.storage_gb ?? 0),
            }
          : {
              totalEntities: mappedEntities.length,
              embeddingsVectors: 0,
              documentsIndexed: 0,
              coveragePct:
                mappedEntities.length > 0
                  ? Math.round(
                      mappedEntities.reduce((sum, entity) => sum + entity.embeddingCoverage, 0) /
                        mappedEntities.length,
                    )
                  : 0,
              storageGb: 0,
            };

        const recentRows = (recentQueriesResponse.data ?? []) as KnowledgeRecentQueryRow[];
        nextRecentQueries =
          recentRows.length > 0
            ? recentRows.map((item) => ({
                id: item.id,
                content: item.content,
                createdAt: item.created_at,
              }))
            : [];
      } else {
        const [connectionsResponse, entitiesFallbackResponse, relationshipsResponse, docsResponse, chunksResponse] = await Promise.all([
          supabase.from("api_connections").select("id,name").eq("tenant_id", workspaceTenantId),
          supabase
            .from("connection_entities")
            .select("id,connection_id,name,entity_group,description,metadata,sensitivity,row_count,embedding_coverage,source_kind,updated_at")
            .eq("tenant_id", workspaceTenantId)
            .order("updated_at", { ascending: false })
            .limit(300),
          supabase
            .from("connection_relationships")
            .select("source_entity_id,target_entity_id")
            .eq("tenant_id", workspaceTenantId)
            .limit(1000),
          supabase
            .from("knowledge_documents")
            .select("id,title,file_name,status,indexed_at,created_at")
            .eq("tenant_id", workspaceTenantId)
            .order("created_at", { ascending: false })
            .limit(200),
          supabase
            .from("knowledge_document_chunks")
            .select("id", { count: "exact", head: true })
            .eq("tenant_id", workspaceTenantId)
            .not("embedded_at", "is", null),
        ]);

        const connectionNameById = new Map<string, string>();
        for (const row of connectionsResponse.data ?? []) {
          connectionNameById.set(String(row.id), String(row.name ?? "Connection"));
        }

        const relationshipCountByEntity = new Map<string, number>();
        for (const row of relationshipsResponse.data ?? []) {
          const sourceId = String(row.source_entity_id ?? "");
          const targetId = String(row.target_entity_id ?? "");
          if (sourceId) relationshipCountByEntity.set(sourceId, (relationshipCountByEntity.get(sourceId) ?? 0) + 1);
          if (targetId) relationshipCountByEntity.set(targetId, (relationshipCountByEntity.get(targetId) ?? 0) + 1);
        }

        const queryLower = query.trim().toLowerCase();
        mappedEntities = (entitiesFallbackResponse.data ?? [])
          .map((entity) => {
            const metadata = entity.metadata && typeof entity.metadata === "object"
              ? (entity.metadata as Record<string, unknown>)
              : {};
            const keyFields = Array.isArray(metadata?.top_fields)
              ? metadata.top_fields.map((value) => String(value)).filter(Boolean).slice(0, 4)
              : [];
            return {
              id: String(entity.id),
              connectionId: entity.connection_id ? String(entity.connection_id) : null,
              connectionName: connectionNameById.get(String(entity.connection_id ?? "")) ?? "Connection",
              name: String(entity.name ?? "Entity"),
              entityType: mapEntityType(String(entity.entity_group ?? "config")),
              description: String(entity.description ?? "Indexed from connected data source."),
              keyFields,
              sensitivity: mapSensitivity(String(entity.sensitivity ?? "normal")),
              rowCount: Number(entity.row_count ?? 0),
              lastUpdated: String(entity.updated_at ?? new Date().toISOString()),
              embeddingCoverage: Number(entity.embedding_coverage ?? 0),
              sourceKind: String(entity.source_kind ?? "table"),
              relationshipCount: relationshipCountByEntity.get(String(entity.id)) ?? 0,
            } satisfies KnowledgeEntityCard;
          })
          .filter((entity) => {
            if (!queryLower) return true;
            const text = `${entity.name} ${entity.description} ${entity.keyFields.join(" ")} ${entity.connectionName}`.toLowerCase();
            return text.includes(queryLower);
          });

        mappedEntities = applyKnowledgeChipFilter(mappedEntities, chip);

        const indexedDocuments = (docsResponse.data ?? []).filter((row) => String(row.status ?? "").toLowerCase() === "indexed");
        const documentsIndexed = indexedDocuments.length;
        const embeddingsVectors = Number(chunksResponse.count ?? 0);
        const averageCoverage =
          mappedEntities.length > 0
            ? Math.round(mappedEntities.reduce((sum, entity) => sum + entity.embeddingCoverage, 0) / mappedEntities.length)
            : 0;

        nextStats = {
          totalEntities: mappedEntities.length,
          embeddingsVectors,
          documentsIndexed,
          coveragePct: averageCoverage,
          storageGb: Math.max(0, Number((embeddingsVectors * 0.0000012).toFixed(2))),
        };

        const sessionsResponse = await supabase
          .from("chat_sessions")
          .select("id")
          .eq("tenant_id", workspaceTenantId)
          .order("updated_at", { ascending: false })
          .limit(25);
        const sessionIds = (sessionsResponse.data ?? []).map((row) => String(row.id));
        if (sessionIds.length > 0) {
          const recentMessages = await supabase
            .from("chat_messages")
            .select("id,content,created_at")
            .eq("role", "user")
            .in("session_id", sessionIds)
            .order("created_at", { ascending: false })
            .limit(8);
          nextRecentQueries = (recentMessages.data ?? []).map((item) => ({
            id: String(item.id),
            content: String(item.content ?? ""),
            createdAt: String(item.created_at ?? new Date().toISOString()),
          }));
        }
      }

      if (nextRecentQueries.length === 0) {
        nextRecentQueries = FALLBACK_RECENT_QUERIES.map((queryItem, index) => ({
          id: `fallback-query-${index}`,
          content: queryItem,
          createdAt: new Date(Date.now() - (index + 1) * 15 * 60 * 1000).toISOString(),
        }));
      }

      if (latestRequestIdRef.current !== requestId) {
        return;
      }

      setEntities(mappedEntities);
      setStats(nextStats);
      setRecentQueries(nextRecentQueries);

      if (!silent) setInitialLoading(false);
      else setSearchLoading(false);
      setTenantId(workspaceTenantId);
    },
    [],
  );

  useEffect(() => {
    if (!user) return;
    let active = true;

    const bootstrap = async () => {
      try {
        const workspace = await ensureUserWorkspace(user);
        if (!active) return;
        await loadKnowledge(workspace.tenantId, "", "all", false);
        if (!active) return;
        setReadyForSearch(true);
      } catch (error) {
        if (!active) return;
        setInitialLoading(false);
        setSearchLoading(false);
        toast({
          title: "Could not load knowledge base",
          description:
            error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        });
      }
    };

    void bootstrap();
    return () => {
      active = false;
    };
  }, [loadKnowledge, toast, user]);

  useEffect(() => {
    if (!user || !tenantId || !readyForSearch) return;
    let active = true;

    const refresh = async () => {
      try {
        await loadKnowledge(tenantId, debouncedSearch, activeChip, true);
      } catch (error) {
        if (!active) return;
        setSearchLoading(false);
        toast({
          title: "Search refresh failed",
          description:
            error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        });
      }
    };

    void refresh();
    return () => {
      active = false;
    };
  }, [activeChip, debouncedSearch, loadKnowledge, readyForSearch, tenantId, toast, user]);

  useEffect(() => {
    if (!tenantId) return;

    let channel: RealtimeChannel | null = null;
    channel = supabase
      .channel(`knowledge-base-${tenantId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "connection_entities",
          filter: `tenant_id=eq.${tenantId}`,
        },
        () => {
          void loadKnowledge(tenantId, debouncedSearch, activeChip, true);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "knowledge_documents",
          filter: `tenant_id=eq.${tenantId}`,
        },
        () => {
          void loadKnowledge(tenantId, debouncedSearch, activeChip, true);
        },
      )
      .subscribe();

    return () => {
      if (channel) void supabase.removeChannel(channel);
    };
  }, [activeChip, debouncedSearch, loadKnowledge, tenantId]);

  // Load org graph when user switches to graph mode
  useEffect(() => {
    if (!graphMode || !tenantId || graphData) return;
    let active = true;
    setGraphLoading(true);
    void supabase.rpc("get_entity_relationship_graph", { p_tenant_id: tenantId }).then(({ data, error }) => {
      if (!active) return;
      if (!error && data && typeof data === "object") {
        const raw = data as Record<string, unknown>;
        setGraphData({
          nodes: Array.isArray(raw.nodes) ? (raw.nodes as GraphNode[]) : [],
          edges: Array.isArray(raw.edges) ? (raw.edges as GraphEdge[]) : [],
        });
      }
      setGraphLoading(false);
    }).catch(() => { if (active) setGraphLoading(false); });
    return () => { active = false; };
  }, [graphMode, tenantId, graphData]);

  const handleReindex = async () => {
    if (!tenantId || reindexing) return;
    setReindexing(true);
    try {
      const { data, error } = await invokeEdge("knowledge-reindex-dispatch", {
        body: {
          force: true,
          limit: 2000,
        },
      });
      if (error) throw error;

      const queuedCount = Number(data?.queuedCount ?? 0);
      const scannedCount = Number(data?.scannedCount ?? 0);
      const coveragePct = data?.health?.coveragePct;

      toast({
        title: queuedCount > 0 ? "Embedding reindex queued" : "Reindex check completed",
        description:
          queuedCount > 0
            ? `${queuedCount} chunks queued (${scannedCount} scanned).${typeof coveragePct === "number" ? ` Current coverage: ${coveragePct}%.` : ""}`
            : "No stale chunks detected.",
      });

      await loadKnowledge(tenantId, debouncedSearch, activeChip, true);
    } catch (error) {
      toast({
        title: "Could not queue reindex",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setReindexing(false);
    }
  };

  const hasEmptyResults = !initialLoading && entities.length === 0;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              Knowledge Base
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              What the AI currently knows about your organization&apos;s connected
              data.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleReindex()}
            disabled={initialLoading || reindexing || !tenantId}
          >
            {reindexing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCcw className="h-4 w-4" />
            )}
            Reindex Embeddings
          </Button>
        </div>

        <div className="mt-4 space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search across all your knowledge..."
              className="h-11 pl-9"
            />
            {searchLoading && (
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {CHIP_OPTIONS.map((chip) => (
              <button
                key={chip.value}
                type="button"
                onClick={() => { setActiveChip(chip.value); setGraphMode(false); }}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  !graphMode && activeChip === chip.value
                    ? "border-violet-500 bg-violet-100 text-violet-700"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100",
                )}
              >
                {chip.label}
              </button>
            ))}
            <div className="ml-auto flex rounded-lg border border-slate-200 bg-white p-0.5">
              <button
                type="button"
                onClick={() => setGraphMode(false)}
                className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition-colors flex items-center gap-1.5",
                  !graphMode ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900")}
              >
                <LayoutList className="h-3.5 w-3.5" /> List
              </button>
              <button
                type="button"
                onClick={() => setGraphMode(true)}
                className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition-colors flex items-center gap-1.5",
                  graphMode ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900")}
              >
                <Network className="h-3.5 w-3.5" /> Graph
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <div>
          {graphMode ? (
            <OrgGraph data={graphData} loading={graphLoading} />
          ) : initialLoading ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <article
                  key={index}
                  className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                >
                  <Skeleton className="h-5 w-2/3" />
                  <Skeleton className="mt-3 h-4 w-full" />
                  <Skeleton className="mt-2 h-4 w-5/6" />
                  <Skeleton className="mt-4 h-20 w-full" />
                </article>
              ))}
            </div>
          ) : hasEmptyResults ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center shadow-sm">
              <div className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-full bg-violet-100 text-violet-700">
                <BookOpenText className="h-6 w-6" />
              </div>
              <h2 className="mt-4 text-xl font-semibold text-slate-900">
                No matching knowledge found
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                Try a broader search, switch filters, or sync your connections
                to index more data.
              </p>
              <div className="mt-5 inline-flex flex-col items-start rounded-lg bg-slate-50 px-4 py-3 text-left text-xs text-slate-600">
                <span>
                  Tip: search by field names like `customer_id` or
                  `invoice_status`.
                </span>
                <span>
                  Tip: filter to `Relationships` to find cross-entity links
                  quickly.
                </span>
              </div>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {entities.map((entity) => {
                const Icon = entityIcon(entity);
                const queryPrompt = `Using ${entity.name}${
                  entity.connectionName
                    ? ` from ${entity.connectionName}`
                    : ""
                }, summarize key insights and anomalies.`;

                return (
                  <article
                    key={entity.id}
                    className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-start gap-2">
                        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-900">
                            {entity.name}
                          </p>
                          <p className="text-xs text-slate-500">
                            {entity.connectionName}
                          </p>
                        </div>
                      </div>
                      <Badge
                        className={cn(
                          "border-0 text-[11px]",
                          entityTypeClass(entity.entityType),
                        )}
                      >
                        {entity.entityType}
                      </Badge>
                    </div>

                    <p className="mt-3 text-sm text-slate-600">
                      {entity.description}
                    </p>

                    <div className="mt-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        Key Fields
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {entity.keyFields.length > 0 ? (
                          entity.keyFields.map((field) => (
                            <span
                              key={field}
                              className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700"
                            >
                              {field}
                            </span>
                          ))
                        ) : (
                          <span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700">
                            No key fields indexed
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-between">
                      <Badge
                        className={cn(
                          "border-0 text-[11px]",
                          sensitivityClass(entity.sensitivity),
                        )}
                      >
                        {entity.sensitivity}
                      </Badge>
                      <span className="text-xs text-slate-500">
                        {entity.relationshipCount} relationships
                      </span>
                    </div>

                    <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-slate-500">
                          Rows
                        </p>
                        <p className="text-xs font-semibold text-slate-800">
                          {entity.rowCount.toLocaleString()}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-slate-500">
                          Updated
                        </p>
                        <p className="text-xs font-semibold text-slate-800">
                          {formatRelativeTime(entity.lastUpdated)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-slate-500">
                          Coverage
                        </p>
                        <p className="text-xs font-semibold text-slate-800">
                          {Math.round(entity.embeddingCoverage)}%
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        asChild
                        size="sm"
                        className="bg-violet-600 text-white hover:bg-violet-700"
                      >
                        <Link
                          to={`/dashboard/chat?q=${encodeURIComponent(
                            queryPrompt,
                          )}`}
                        >
                          Query this
                        </Link>
                      </Button>

                      {entity.connectionId ? (
                        <Button asChild size="sm" variant="outline">
                          <Link to={`/dashboard/connections/${entity.connectionId}`}>
                            View in Schema
                          </Link>
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" disabled>
                          View in Schema
                        </Button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
              Stats
            </h2>
            {initialLoading ? (
              <div className="mt-3 space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-6 w-full" />
              </div>
            ) : (
              <div className="mt-3 space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Total entities indexed</span>
                  <span className="font-semibold text-slate-900">
                    {stats.totalEntities}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Embeddings</span>
                  <span className="font-semibold text-slate-900">
                    {stats.embeddingsVectors.toLocaleString()} vectors
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Documents</span>
                  <span className="font-semibold text-slate-900">
                    {stats.documentsIndexed.toLocaleString()} pages
                  </span>
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-slate-500">Coverage</span>
                    <span className="font-semibold text-slate-900">
                      {stats.coveragePct}%
                    </span>
                  </div>
                  <Progress
                    value={stats.coveragePct}
                    className="h-2 bg-slate-200 [&>div]:bg-violet-600"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Storage used</span>
                  <span className="font-semibold text-slate-900">
                    {stats.storageGb.toFixed(2)} GB
                  </span>
                </div>
              </div>
            )}
          </article>

          <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
              Recently Asked About This Data
            </h2>
            {initialLoading ? (
              <div className="mt-3 space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : recentQueries.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                No recent queries yet.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {recentQueries.map((query) => (
                  <Link
                    key={query.id}
                    to={`/dashboard/chat?q=${encodeURIComponent(query.content)}`}
                    className="block rounded-lg border border-slate-200 px-3 py-2 transition-colors hover:bg-slate-50"
                  >
                    <p className="line-clamp-2 text-sm text-slate-800">
                      {query.content}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {formatRelativeTime(query.createdAt)}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </article>

          {!initialLoading && stats.coveragePct < 65 && (
            <article className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              <div className="inline-flex items-center gap-2 font-medium">
                <ShieldAlert className="h-4 w-4" />
                Coverage tip
              </div>
              <p className="mt-2">
                Embedding coverage is low. Sync key connections to improve answer
                quality.
              </p>
              <Button
                asChild
                size="sm"
                variant="outline"
                className="mt-3 border-amber-300 bg-white/70 hover:bg-white"
              >
                <Link to="/dashboard/connections">
                  <Sparkles className="h-4 w-4" />
                  Review Connections
                </Link>
              </Button>
            </article>
          )}
        </aside>
      </section>
    </div>
  );
}
