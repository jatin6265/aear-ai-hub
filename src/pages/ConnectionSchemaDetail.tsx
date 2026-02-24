import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ensureUserWorkspace } from "@/lib/auth-provisioning";
import { invokeEdge } from "@/lib/edge-invoke";
import { supabase } from "@/integrations/supabase/client";
import type { Database as SupabaseDatabase } from "@/integrations/supabase/types";
import { cn } from "@/lib/utils";

type ApiConnectionRow = SupabaseDatabase["public"]["Tables"]["api_connections"]["Row"];
type AuditLogRow = Pick<
  SupabaseDatabase["public"]["Tables"]["audit_logs"]["Row"],
  "id" | "action" | "resource" | "status" | "risk_level" | "created_at" | "details"
>;

type SyncFrequency = "realtime" | "5min" | "hourly" | "daily";
type RiskBadge = "Low" | "Medium" | "High";
type Sensitivity = "PII" | "Financial" | "Normal";
type EntityGroup = "Master Data" | "Transactions" | "Logs" | "Config";

type SchemaColumn = {
  name: string;
  type: string;
  nullable: boolean;
  sensitivity: Sensitivity;
};

type SchemaEntity = {
  id: string;
  name: string;
  group: EntityGroup;
  risk: RiskBadge;
  rowCount: number;
  columns: SchemaColumn[];
  description: string;
  sampleRows: Array<Record<string, string>>;
  relationships: string[];
};

type BackendEntityRow = {
  id: string;
  name: string;
  entity_group: string;
  row_count: number | null;
  risk_level: string | null;
  sensitivity: string | null;
  description: string | null;
};

type BackendColumnRow = {
  entity_id: string;
  name: string;
  data_type: string;
  is_nullable: boolean;
  sensitivity: string | null;
  sample_value: string | null;
  position_index: number | null;
};

type BackendRelationshipRow = {
  source_entity_id: string;
  target_entity_id: string;
};

type BackendSyncRunRow = {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
  details: SupabaseDatabase["public"]["Tables"]["connection_sync_runs"]["Row"]["details"];
};

const DISCOVERY_STEPS = [
  "Connection verified",
  "Reading schema structure",
  "Classifying entities",
  "Building knowledge graph",
  "Generating embeddings",
  "Creating AI agents",
] as const;

const DISCOVERY_STAGE_INDEX: Record<string, number> = {
  schema_discovery_started: 0,
  connection_verified: 0,
  reading_schema_structure: 1,
  classifying_entities: 2,
  building_knowledge_graph: 3,
  generating_embeddings: 4,
  creating_ai_agents: 5,
  openapi_discovery: 5,
  schema_bootstrapped: 5,
};

const GROUP_COLORS: Record<EntityGroup, string> = {
  "Master Data": "#60A5FA",
  Transactions: "#34D399",
  Logs: "#F59E0B",
  Config: "#A78BFA",
};

function isMissingSchemaObjectError(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  const code = String(error.code ?? "").trim();
  const message = String(error.message ?? "").toLowerCase();
  return (
    code === "42703" ||
    code === "PGRST204" ||
    code === "42P01" ||
    message.includes("column") && message.includes("does not exist") ||
    message.includes("relation") && message.includes("does not exist")
  );
}

function maskValue(value: string, sensitivity: Sensitivity) {
  if (sensitivity === "Normal") return value;
  if (value.includes("@")) {
    const [left, right] = value.split("@");
    return `${left.slice(0, 2)}***@${right}`;
  }
  if (value.length <= 4) return "***";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function riskBadgeClass(risk: RiskBadge) {
  if (risk === "High") return "bg-rose-100 text-rose-700";
  if (risk === "Medium") return "bg-amber-100 text-amber-700";
  return "bg-emerald-100 text-emerald-700";
}

function sensitivityBadgeClass(sensitivity: Sensitivity) {
  if (sensitivity === "PII") return "bg-rose-100 text-rose-700";
  if (sensitivity === "Financial") return "bg-amber-100 text-amber-700";
  return "bg-slate-100 text-slate-700";
}

function mapGroup(value: string | null): EntityGroup {
  const normalized = (value ?? "").toLowerCase();
  if (normalized === "master_data") return "Master Data";
  if (normalized === "transactions") return "Transactions";
  if (normalized === "logs") return "Logs";
  return "Config";
}

function mapRisk(value: string | null): RiskBadge {
  const normalized = (value ?? "").toLowerCase();
  if (normalized === "high") return "High";
  if (normalized === "medium") return "Medium";
  return "Low";
}

function mapSensitivity(value: string | null): Sensitivity {
  const normalized = (value ?? "").toLowerCase();
  if (normalized === "pii") return "PII";
  if (normalized === "financial") return "Financial";
  return "Normal";
}

function formatRelativeTime(value: string) {
  const now = Date.now();
  const then = new Date(value).getTime();
  const diff = now - then;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
  return `${Math.floor(diff / 86_400_000)} days ago`;
}

function connectionErrorMessage(connection: ApiConnectionRow, logs: AuditLogRow[]) {
  if (connection.status.toLowerCase() !== "error") return null;
  if (connection.last_error) return connection.last_error;
  const errorLog = logs.find((log) => log.status?.toLowerCase() === "error" || log.risk_level?.toLowerCase() === "high");
  if (!errorLog) return "Connection health degraded. Review credentials and endpoint access.";

  const details = errorLog.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const candidate = (details as Record<string, unknown>).error;
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return `Latest issue detected during ${errorLog.action.replaceAll("_", " ")}.`;
}

function RelationshipMap({ entities }: { entities: SchemaEntity[] }) {
  const { nodes, edges } = useMemo(() => {
    const grouped = new Map<EntityGroup, SchemaEntity[]>();
    entities.forEach((entity) => {
      const items = grouped.get(entity.group) ?? [];
      items.push(entity);
      grouped.set(entity.group, items);
    });

    const groupOrder: EntityGroup[] = ["Master Data", "Transactions", "Logs", "Config"];
    const graphNodes: Node[] = [];
    const entityNameToNodeId = new Map<string, string>();
    const graphEdges: Edge[] = [];

    groupOrder.forEach((group, groupIndex) => {
      const items = grouped.get(group) ?? [];
      items.forEach((entity, index) => {
        const nodeId = entity.id;
        entityNameToNodeId.set(entity.name, nodeId);
        graphNodes.push({
          id: nodeId,
          position: {
            x: 30 + groupIndex * 260,
            y: 25 + index * 130,
          },
          draggable: false,
          selectable: false,
          style: {
            width: 220,
            borderRadius: 12,
            border: `2px solid ${GROUP_COLORS[group]}`,
            background: "#ffffff",
            padding: 0,
            boxShadow: "0 2px 10px rgba(15,23,42,0.08)",
          },
          data: {
            label: (
              <div className="px-3 py-2.5">
                <p className="truncate text-xs font-semibold text-slate-900">{entity.name}</p>
                <p className="text-[11px] text-slate-600">{group}</p>
                <p className="text-[10px] text-slate-500">{entity.rowCount.toLocaleString()} rows</p>
              </div>
            ),
          },
        });
      });
    });

    entities.forEach((entity) => {
      const sourceNodeId = entityNameToNodeId.get(entity.name);
      if (!sourceNodeId) return;
      entity.relationships.forEach((targetName) => {
        const targetNodeId = entityNameToNodeId.get(targetName);
        if (!targetNodeId) return;
        graphEdges.push({
          id: `${sourceNodeId}__${targetNodeId}`,
          source: sourceNodeId,
          target: targetNodeId,
          markerEnd: { type: MarkerType.ArrowClosed, color: "#94A3B8" },
          style: { stroke: "#94A3B8", strokeWidth: 1.6 },
          animated: false,
        });
      });
    });

    return { nodes: graphNodes, edges: graphEdges };
  }, [entities]);

  return (
    <div className="relative rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Entity Relationship Map</p>
          <p className="text-xs text-slate-500">Pan and zoom to inspect relationships between detected entities.</p>
        </div>
        <p className="text-xs text-slate-500">Powered by React Flow</p>
      </div>

      <div className="h-[430px] overflow-hidden bg-slate-50">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          minZoom={0.45}
          maxZoom={1.8}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Background color="#E2E8F0" gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-slate-200 px-4 py-3 text-xs">
        {(["Master Data", "Transactions", "Logs", "Config"] as EntityGroup[]).map((group) => (
          <span key={group} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: GROUP_COLORS[group] }} />
            {group}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function ConnectionSchemaDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [connection, setConnection] = useState<ApiConnectionRow | null>(null);
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [entityRows, setEntityRows] = useState<BackendEntityRow[]>([]);
  const [columnRows, setColumnRows] = useState<BackendColumnRow[]>([]);
  const [relationshipRows, setRelationshipRows] = useState<BackendRelationshipRow[]>([]);
  const [syncRunRows, setSyncRunRows] = useState<BackendSyncRunRow[]>([]);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [syncFrequency, setSyncFrequency] = useState<SyncFrequency>("realtime");
  const [syncing, setSyncing] = useState(false);
  const [etaSeconds, setEtaSeconds] = useState(240);

  const loadDetails = useCallback(async (silent = false) => {
    if (!user || !id) return;
    if (!silent) setLoading(true);

    const workspace = await ensureUserWorkspace(user);
    const currentTenantId = workspace.tenantId;
    setTenantId(currentTenantId);

    const connectionExtended = await supabase
      .from("api_connections")
      .select(
        "id, tenant_id, name, type, base_url, status, schema_detected, last_synced_at, created_at, health, last_error, sync_frequency, analysis_started_at, analysis_completed_at",
      )
      .eq("tenant_id", currentTenantId)
      .eq("id", id)
      .maybeSingle();

    let connectionResponse = connectionExtended;
    if (connectionExtended.error && isMissingSchemaObjectError(connectionExtended.error)) {
      const legacyConnection = await supabase
        .from("api_connections")
        .select("id, tenant_id, name, type, base_url, status, schema_detected, last_synced_at, created_at, last_error")
        .eq("tenant_id", currentTenantId)
        .eq("id", id)
        .maybeSingle();
      if (!legacyConnection.error && legacyConnection.data) {
        connectionResponse = {
          ...legacyConnection,
          data: {
            ...legacyConnection.data,
            health: "healthy",
            sync_frequency: "hourly",
            analysis_started_at: null,
            analysis_completed_at: null,
          },
        };
      }
    }

    const [logsResponse, entitiesResponse, relationshipsResponse, syncRunsResponse] = await Promise.all([
      supabase
        .from("audit_logs")
        .select("id, action, resource, status, risk_level, created_at, details")
        .eq("tenant_id", currentTenantId)
        .order("created_at", { ascending: false })
        .limit(120),
      supabase
        .from("connection_entities")
        .select("id, name, entity_group, row_count, risk_level, sensitivity, description")
        .eq("tenant_id", currentTenantId)
        .eq("connection_id", id)
        .order("name", { ascending: true }),
      supabase
        .from("connection_relationships")
        .select("source_entity_id, target_entity_id")
        .eq("tenant_id", currentTenantId)
        .eq("connection_id", id),
      supabase
        .from("connection_sync_runs")
        .select("id, status, started_at, finished_at, error_message, details")
        .eq("tenant_id", currentTenantId)
        .eq("connection_id", id)
        .order("started_at", { ascending: false })
        .limit(10),
    ]);

    if (connectionResponse.error) throw connectionResponse.error;
    if (logsResponse.error) throw logsResponse.error;
    if (entitiesResponse.error && !isMissingSchemaObjectError(entitiesResponse.error)) throw entitiesResponse.error;
    if (relationshipsResponse.error && !isMissingSchemaObjectError(relationshipsResponse.error)) throw relationshipsResponse.error;
    if (syncRunsResponse.error && !isMissingSchemaObjectError(syncRunsResponse.error)) throw syncRunsResponse.error;
    if (!connectionResponse.data) throw new Error("Connection not found.");

    const entities = (entitiesResponse.data ?? []) as BackendEntityRow[];
    const entityIds = entities.map((entity) => entity.id);

    let columns: BackendColumnRow[] = [];
    if (entityIds.length > 0) {
      const columnsResponse = await supabase
        .from("connection_columns")
        .select("entity_id, name, data_type, is_nullable, sensitivity, sample_value, position_index")
        .eq("tenant_id", currentTenantId)
        .in("entity_id", entityIds)
        .order("position_index", { ascending: true });

      if (columnsResponse.error && !isMissingSchemaObjectError(columnsResponse.error)) throw columnsResponse.error;
      columns = (columnsResponse.data ?? []) as BackendColumnRow[];
    }

    const conn = connectionResponse.data as ApiConnectionRow;
    const normalizedFrequency = (conn.sync_frequency ?? "hourly").toLowerCase();
    if (["realtime", "5min", "hourly", "daily"].includes(normalizedFrequency)) {
      setSyncFrequency(normalizedFrequency as SyncFrequency);
    } else {
      setSyncFrequency("hourly");
    }

    const hasDiscoveredEntities = entities.length > 0;
    if (!hasDiscoveredEntities && conn.analysis_started_at) {
      const elapsedSeconds = Math.max(
        0,
        Math.floor((Date.now() - new Date(conn.analysis_started_at).getTime()) / 1000),
      );
      setEtaSeconds(Math.max(30, 240 - elapsedSeconds));
    } else if (hasDiscoveredEntities) {
      setEtaSeconds(0);
    }

    const name = conn.name.toLowerCase();
    const base = (conn.base_url ?? "").toLowerCase();
    const filteredLogs = ((logsResponse.data ?? []) as AuditLogRow[]).filter((log) => {
      const resource = log.resource.toLowerCase();
      return resource.includes(name) || (base && resource.includes(base));
    });

    setConnection(conn);
    setLogs(filteredLogs);
    setEntityRows(entities);
    setColumnRows(columns);
    setRelationshipRows((relationshipsResponse.data ?? []) as BackendRelationshipRow[]);
    setSyncRunRows((syncRunsResponse.data ?? []) as BackendSyncRunRow[]);
    if (!silent) setLoading(false);
  }, [id, user]);

  useEffect(() => {
    if (!user || !id) return;
    let active = true;

    const run = async () => {
      try {
        await loadDetails();
      } catch (error) {
        if (!active) return;
        toast({
          title: "Could not load schema view",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        });
        navigate("/dashboard/connections", { replace: true });
      }
    };

    void run();

    return () => {
      active = false;
    };
  }, [id, loadDetails, navigate, toast, user]);

  useEffect(() => {
    if (!tenantId || !id) return;

    let channel: RealtimeChannel | null = null;
    channel = supabase
      .channel(`connection-detail-${tenantId}-${id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "api_connections",
          filter: `id=eq.${id}`,
        },
        () => {
          void loadDetails(true);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "connection_entities",
          filter: `connection_id=eq.${id}`,
        },
        () => {
          void loadDetails(true);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "connection_columns",
          filter: `tenant_id=eq.${tenantId}`,
        },
        () => {
          void loadDetails(true);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "connection_relationships",
          filter: `connection_id=eq.${id}`,
        },
        () => {
          void loadDetails(true);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "connection_sync_runs",
          filter: `connection_id=eq.${id}`,
        },
        () => {
          void loadDetails(true);
        },
      )
      .subscribe();

    return () => {
      if (channel) void supabase.removeChannel(channel);
    };
  }, [id, loadDetails, tenantId]);

  useEffect(() => {
    if (!connection || entityRows.length > 0) return;

    const timer = window.setInterval(() => {
      setEtaSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [connection, entityRows.length]);

  const schemaEntities = useMemo(() => {
    if (!connection || entityRows.length === 0) return [];

    const entitiesById = new Map(entityRows.map((entity) => [entity.id, entity]));
    const validEntityIds = new Set(entityRows.map((entity) => entity.id));
    const scopedColumns = columnRows.filter((column) => validEntityIds.has(column.entity_id));

    const columnsByEntity = new Map<string, BackendColumnRow[]>();
    scopedColumns.forEach((column) => {
      const current = columnsByEntity.get(column.entity_id) ?? [];
      current.push(column);
      columnsByEntity.set(column.entity_id, current);
    });

    const relationshipsByEntity = new Map<string, string[]>();
    relationshipRows.forEach((relation) => {
      const current = relationshipsByEntity.get(relation.source_entity_id) ?? [];
      current.push(relation.target_entity_id);
      relationshipsByEntity.set(relation.source_entity_id, current);
    });

    return entityRows.map((entity) => {
      const backendColumns = (columnsByEntity.get(entity.id) ?? []).sort(
        (a, b) => (a.position_index ?? 0) - (b.position_index ?? 0),
      );

      const columns: SchemaColumn[] = backendColumns.map((column) => ({
        name: column.name,
        type: column.data_type,
        nullable: column.is_nullable,
        sensitivity: mapSensitivity(column.sensitivity),
      }));

      const sampleRows = Array.from({ length: 3 }).map((_, rowIndex) => {
        const row: Record<string, string> = {};
        columns.forEach((column, idx) => {
          const source = backendColumns[idx]?.sample_value ?? `${column.name}_${rowIndex + 1}`;
          row[column.name] = maskValue(source, column.sensitivity);
        });
        return row;
      });

      const targetNames = (relationshipsByEntity.get(entity.id) ?? [])
        .map((targetId) => entitiesById.get(targetId)?.name)
        .filter(Boolean) as string[];

      return {
        id: entity.id,
        name: entity.name,
        group: mapGroup(entity.entity_group),
        risk: mapRisk(entity.risk_level),
        rowCount: Number(entity.row_count ?? 0),
        columns: columns.length > 0 ? columns : [{ name: "id", type: "uuid", nullable: false, sensitivity: "Normal" }],
        description: entity.description ?? "No description available yet.",
        sampleRows:
          sampleRows.length > 0
            ? sampleRows
            : [{ id: "sample_1" }, { id: "sample_2" }, { id: "sample_3" }],
        relationships: targetNames,
      } as SchemaEntity;
    });
  }, [columnRows, connection, entityRows, relationshipRows]);

  useEffect(() => {
    if (schemaEntities.length === 0) {
      setSelectedEntityId(null);
      return;
    }
    const selectedStillExists = selectedEntityId
      ? schemaEntities.some((entity) => entity.id === selectedEntityId)
      : false;
    if (!selectedEntityId || !selectedStillExists) {
      setSelectedEntityId(schemaEntities[0].id);
    }
  }, [schemaEntities, selectedEntityId]);

  const selectedEntity = useMemo(
    () => schemaEntities.find((entity) => entity.id === selectedEntityId) ?? null,
    [schemaEntities, selectedEntityId],
  );

  const groupedEntities = useMemo(() => {
    const groups: Record<EntityGroup, SchemaEntity[]> = {
      "Master Data": [],
      Transactions: [],
      Logs: [],
      Config: [],
    };
    schemaEntities.forEach((entity) => {
      groups[entity.group].push(entity);
    });
    return groups;
  }, [schemaEntities]);

  const errorMessage = connection ? connectionErrorMessage(connection, logs) : null;
  const latestSyncRun = syncRunRows[0] ?? null;
  const latestSyncStatus = latestSyncRun?.status?.toLowerCase() ?? null;
  const latestSyncStage = useMemo(() => {
    if (!latestSyncRun?.details || Array.isArray(latestSyncRun.details)) return null;
    const stage = (latestSyncRun.details as Record<string, unknown>).stage;
    return typeof stage === "string" ? stage : null;
  }, [latestSyncRun?.details]);
  const hasSchemaEntities = schemaEntities.length > 0;
  const effectiveConnectionState = useMemo(() => {
    const status = connection?.status.toLowerCase() ?? "unknown";
    if (latestSyncStatus === "running") return "syncing";
    if (latestSyncStatus === "queued") return "pending";
    if (latestSyncStatus === "error" || latestSyncStatus === "cancelled" || latestSyncStatus === "dead_letter") {
      return "error";
    }
    if (status === "error") return "error";
    if (hasSchemaEntities) return "active";
    if (status === "active" && !hasSchemaEntities) return "pending";
    return status;
  }, [connection?.status, hasSchemaEntities, latestSyncStatus]);
  const discoveryIndex = useMemo(() => {
    if (hasSchemaEntities) return DISCOVERY_STEPS.length - 1;
    if (latestSyncStatus === "success") return DISCOVERY_STEPS.length - 1;
    if (latestSyncStage && latestSyncStage in DISCOVERY_STAGE_INDEX) {
      return DISCOVERY_STAGE_INDEX[latestSyncStage];
    }
    return 0;
  }, [hasSchemaEntities, latestSyncStage, latestSyncStatus]);
  const discoveryStalled = useMemo(() => {
    if (hasSchemaEntities || !latestSyncRun) return false;
    if (!latestSyncStatus || !["running", "queued", "pending"].includes(latestSyncStatus)) return false;
    const startedAt = new Date(latestSyncRun.started_at).getTime();
    if (Number.isNaN(startedAt)) return false;
    return Date.now() - startedAt > 12 * 60 * 1000;
  }, [hasSchemaEntities, latestSyncRun, latestSyncStatus]);

  const syncLogs = useMemo(() => {
    const fromAudit = logs.filter((log) => {
      const action = log.action.toLowerCase();
      return action.includes("sync") || action.includes("schema") || action.includes("ingest");
    });

    const fromRuns: AuditLogRow[] = syncRunRows.map((run) => ({
      id: `sync-${run.id}`,
      action: "sync.run",
      resource: connection?.name ?? "connection",
      status: run.status,
      risk_level: run.status.toLowerCase() === "error" ? "high" : "low",
      created_at: run.finished_at ?? run.started_at,
      details: run.error_message ? { error: run.error_message } : null,
    }));

    return [...fromRuns, ...fromAudit]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 10);
  }, [connection?.name, logs, syncRunRows]);

  const handleSyncFrequencyChange = async (value: SyncFrequency) => {
    if (!tenantId || !connection) return;

    const previous = syncFrequency;
    setSyncFrequency(value);

    const { error } = await supabase
      .from("api_connections")
      .update({ sync_frequency: value })
      .eq("tenant_id", tenantId)
      .eq("id", connection.id);

    if (error) {
      setSyncFrequency(previous);
      toast({
        title: "Could not update frequency",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    setConnection((prev) => (prev ? { ...prev, sync_frequency: value } : prev));
    toast({
      title: "Sync frequency updated",
      description: `Connection will sync ${value === "5min" ? "every 5 min" : value}.`,
    });
  };

  const runSyncNow = async () => {
    if (!connection) return;
    setSyncing(true);
    try {
      setConnection((prev) => (prev ? { ...prev, status: "syncing" } : prev));
      setEtaSeconds(240);

      const dispatch = await invokeEdge("connector-sync-dispatch", {
        body: {
          connectionId: connection.id,
          jobType: "schema_discovery",
          triggerReason: "schema_detail_sync_now",
          priority: 70,
          idempotencyKey: `${connection.id}:schema_detail:${Date.now()}`,
        },
      });

      let queued = dispatch.error === null && dispatch.data?.jobId;
      if (dispatch.error) {
        const fallback = await invokeEdge("run-schema-discovery", {
          body: { connectionId: connection.id },
        });
        if (fallback.error) throw fallback.error;
        queued = Boolean(fallback.data?.jobId);
      }
      if (queued) {
        toast({
          title: "Sync queued",
          description: `Background job started (${dispatch.data?.jobId ?? "queued"}).`,
        });
      }

      await loadDetails(true);

      toast({
        title: queued ? "Sync started" : "Sync completed",
        description: queued
          ? "Schema discovery is running in background."
          : "Schema discovery and indexing updated successfully.",
      });
    } catch (error) {
      toast({
        title: "Sync failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
    }
  };

  if (loading || !connection) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-5 w-72" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/dashboard/connections">Connections</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>
            <ChevronRight />
          </BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>{connection.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <section
        className={cn(
          "rounded-xl border px-4 py-3",
          effectiveConnectionState === "active" && "border-emerald-200 bg-emerald-50 text-emerald-800",
          effectiveConnectionState === "error" && "border-rose-200 bg-rose-50 text-rose-800",
          effectiveConnectionState !== "active" &&
            effectiveConnectionState !== "error" &&
            "border-amber-200 bg-amber-50 text-amber-800",
        )}
      >
        <div className="flex items-start gap-2">
          {effectiveConnectionState === "error" ? (
            <AlertCircle className="mt-0.5 h-4 w-4" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4" />
          )}
          <div>
            <p className="text-sm font-semibold">
              {effectiveConnectionState === "active" && "Connection healthy"}
              {effectiveConnectionState === "error" && "Connection error detected"}
              {effectiveConnectionState !== "active" &&
                effectiveConnectionState !== "error" &&
                "Connection setup in progress"}
            </p>
            <p className="mt-1 text-sm">
              {effectiveConnectionState === "active" && "Schema sync and ingestion are operating normally."}
              {effectiveConnectionState === "error" && (errorMessage ?? "Unknown connection error.")}
              {effectiveConnectionState !== "active" &&
                effectiveConnectionState !== "error" &&
                "Initial verification is still running."}
            </p>
          </div>
        </div>
      </section>

      {!hasSchemaEntities && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Discovery Progress</h2>
              <p className="mt-1 text-sm text-slate-500">Initial schema analysis is currently running for this connection.</p>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-3 py-1 text-xs font-medium text-violet-700">
              <Clock3 className="h-3.5 w-3.5" />~{Math.max(1, Math.ceil(etaSeconds / 60))} minutes remaining
            </span>
          </div>

          <div className="mt-5 grid gap-3">
            {DISCOVERY_STEPS.map((step, index) => {
              const done = index < discoveryIndex;
              const active = index === discoveryIndex;
              return (
                <div key={step} className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2">
                  {done ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : active ? (
                    <Loader2 className="h-4 w-4 animate-spin text-violet-600" />
                  ) : (
                    <span className="h-4 w-4 rounded-full border border-slate-300" />
                  )}
                  <p className={cn("text-sm", done ? "text-slate-800" : active ? "text-violet-700" : "text-slate-500")}>{step}</p>
                </div>
              );
            })}
          </div>

          {discoveryStalled && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Discovery appears stalled. Check that the connector worker is running and that
              `connector-sync-worker-callback` is deployed with valid secrets.
            </div>
          )}
        </section>
      )}

      {hasSchemaEntities && (
        <section className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Schema Browser</h3>
              <ScrollArea className="mt-3 h-[520px] pr-3">
                <div className="space-y-4">
                  {(["Master Data", "Transactions", "Logs", "Config"] as EntityGroup[]).map((group) => (
                    <div key={group}>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{group}</p>
                      <div className="mt-2 space-y-2">
                        {groupedEntities[group].map((entity) => (
                          <button
                            key={entity.id}
                            type="button"
                            onClick={() => setSelectedEntityId(entity.id)}
                            className={cn(
                              "w-full rounded-lg border p-2 text-left transition-colors",
                              selectedEntityId === entity.id ? "border-violet-400 bg-violet-50" : "border-slate-200 hover:bg-slate-50",
                            )}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <p className="truncate text-sm font-medium text-slate-800">{entity.name}</p>
                              <Badge className={cn("border-0 text-[10px]", riskBadgeClass(entity.risk))}>{entity.risk}</Badge>
                            </div>
                            <p className="mt-1 text-xs text-slate-500">{entity.rowCount.toLocaleString()} rows</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {schemaEntities.length === 0 && (
                    <div className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500">
                      No entities detected yet. Run sync to refresh schema discovery.
                    </div>
                  )}
                </div>
              </ScrollArea>
            </article>

            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              {selectedEntity ? (
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-semibold text-slate-900">{selectedEntity.name}</h3>
                      <p className="mt-1 text-sm text-slate-500">{selectedEntity.description}</p>
                    </div>
                    <Badge className={cn("border-0", riskBadgeClass(selectedEntity.risk))}>{selectedEntity.risk} Risk</Badge>
                  </div>

                  <div className="rounded-lg border border-slate-200">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Column</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Nullable</TableHead>
                          <TableHead>Sensitivity</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selectedEntity.columns.map((column) => (
                          <TableRow key={column.name}>
                            <TableCell className="font-mono text-xs">{column.name}</TableCell>
                            <TableCell>{column.type}</TableCell>
                            <TableCell>{column.nullable ? "Yes" : "No"}</TableCell>
                            <TableCell>
                              <Badge className={cn("border-0", sensitivityBadgeClass(column.sensitivity))}>{column.sensitivity}</Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sample Data Preview</p>
                    <div className="mt-2 rounded-md border border-slate-200">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {selectedEntity.columns.map((column) => (
                              <TableHead key={column.name} className="text-xs">{column.name}</TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {selectedEntity.sampleRows.slice(0, 3).map((row, index) => (
                            <TableRow key={index}>
                              {selectedEntity.columns.map((column) => (
                                <TableCell key={column.name} className="text-xs">{row[column.name] ?? "-"}</TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>

                  <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-800">
                    <span className="font-semibold">RACI suggestion:</span> Recommended:{" "}
                    {selectedEntity.risk === "High"
                      ? "Finance Manager as Responsible, CFO as Accountable"
                      : selectedEntity.risk === "Medium"
                        ? "Operations Lead as Responsible, COO as Accountable"
                        : "Data Analyst as Responsible, Data Director as Accountable"}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-500">Select an entity from the left panel.</p>
              )}
            </article>
          </div>

          <RelationshipMap entities={schemaEntities} />

          <section className="grid gap-6 lg:grid-cols-[320px_1fr]">
            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Sync Settings</h3>
              <div className="mt-3 space-y-3">
                <div className="space-y-2">
                  <p className="text-xs text-slate-500">Frequency</p>
                  <Select value={syncFrequency} onValueChange={(value) => void handleSyncFrequencyChange(value as SyncFrequency)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="realtime">Real-time</SelectItem>
                      <SelectItem value="5min">Every 5 min</SelectItem>
                      <SelectItem value="hourly">Hourly</SelectItem>
                      <SelectItem value="daily">Daily</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={() => void runSyncNow()} disabled={syncing} className="w-full bg-violet-600 text-white hover:bg-violet-700">
                  {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Sync Now
                </Button>
                <p className="text-xs text-slate-500">Last synced: {connection.last_synced_at ? formatRelativeTime(connection.last_synced_at) : "Never"}</p>
              </div>
            </article>

            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Sync History</h3>
              <div className="mt-3 space-y-2">
                {syncLogs.length > 0 ? (
                  syncLogs.map((log) => (
                    <div key={log.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-800">{log.action.replaceAll(".", " ").replaceAll("_", " ")}</p>
                        <p className="text-xs text-slate-500">{log.resource}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <Badge
                          className={cn(
                            "border-0",
                            log.status?.toLowerCase() === "success" && "bg-emerald-100 text-emerald-700",
                            log.status?.toLowerCase() === "error" && "bg-rose-100 text-rose-700",
                            log.status?.toLowerCase() !== "success" && log.status?.toLowerCase() !== "error" && "bg-slate-100 text-slate-700",
                          )}
                        >
                          {log.status ?? "logged"}
                        </Badge>
                        <p className="mt-1 text-xs text-slate-500">{formatRelativeTime(log.created_at)}</p>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg border border-dashed border-slate-300 px-3 py-5 text-center text-sm text-slate-500">
                    No sync logs yet.
                  </div>
                )}
              </div>
            </article>
          </section>
        </section>
      )}

      {!hasSchemaEntities && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="inline-flex items-start gap-2 text-sm text-slate-600">
            <ShieldCheck className="mt-0.5 h-4 w-4 text-violet-600" />
            Schema browser, relationship map, and column sensitivity analysis will appear once initial discovery completes.
          </div>
        </section>
      )}
    </div>
  );
}
