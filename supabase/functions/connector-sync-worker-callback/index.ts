import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getServiceClient, requireWorkerToken } from "../_shared/service.ts";

type SyncEntity = {
  name: string;
  sourceKind?: string;
  entityGroup?: string;
  rowCount?: number;
  riskLevel?: string;
  sensitivity?: string;
  description?: string;
  embeddingCoverage?: number;
  columns?: Array<{
    name: string;
    dataType?: string;
    nullable?: boolean;
    sensitivity?: string;
    sampleValue?: string;
  }>;
};

type SyncRelationship = {
  sourceName: string;
  targetName: string;
  relationType?: string;
  label?: string;
};

function normalizeStatus(value: string) {
  const status = value.trim().toLowerCase();
  if (["queued", "running", "success", "error", "cancelled", "dead_letter"].includes(status)) return status;
  return "error";
}

function clampProgress(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, value));
}

function retryDelaySeconds(attemptCount: number) {
  const exponential = 30 * Math.pow(2, Math.max(0, attemptCount - 1));
  return Math.min(900, Math.round(exponential));
}

function normalizeResultPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function resolveStage(resultPayload: Record<string, unknown>, status: string) {
  const stage = resultPayload.stage;
  if (typeof stage === "string" && stage.trim().length > 0) return stage.trim();
  if (status === "running") return "connection_verified";
  if (status === "success") return "schema_bootstrapped";
  if (status === "error") return "schema_discovery_failed";
  return "schema_discovery_started";
}

function normalizeSyncFrequency(value: unknown) {
  const normalized = String(value ?? "hourly").trim().toLowerCase();
  if (normalized === "realtime") return "realtime";
  if (normalized === "5m" || normalized === "5min") return "5min";
  if (normalized === "daily") return "daily";
  return "hourly";
}

function computeNextSyncAt(syncFrequency: string, baseIso: string) {
  const baseMs = new Date(baseIso).getTime();
  const startMs = Number.isFinite(baseMs) ? baseMs : Date.now();
  const intervalMs =
    syncFrequency === "realtime"
      ? 60_000
      : syncFrequency === "5min"
        ? 5 * 60_000
        : syncFrequency === "daily"
          ? 24 * 60 * 60_000
          : 60 * 60_000;
  return new Date(startMs + intervalMs).toISOString();
}

function computeSyncLagSeconds(lastSyncedAt: unknown, nowIso: string) {
  const lastSyncedValue = typeof lastSyncedAt === "string" ? lastSyncedAt : null;
  if (!lastSyncedValue) return 0;

  const lastSyncedMs = new Date(lastSyncedValue).getTime();
  const nowMs = new Date(nowIso).getTime();
  if (!Number.isFinite(lastSyncedMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.floor((nowMs - lastSyncedMs) / 1000));
}

function safeSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "entity";
}

function normalizeEntitySourceKind(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "endpoint") return "endpoint";
  if (normalized === "document") return "document";
  // Persist non-SQL connector entities using the existing relational-compatible kind.
  if (["collection", "sheet", "view", "dataset", "entity", "object", "table"].includes(normalized)) {
    return "table";
  }
  return "table";
}

function estimateTokenCount(content: string) {
  return Math.max(1, Math.ceil(content.length / 4));
}

function buildEntityKnowledgeText(connectionName: string, entity: SyncEntity) {
  const name = String(entity.name ?? "").trim() || "entity";
  const sourceKind = String(entity.sourceKind ?? "table");
  const rowCount = Number(entity.rowCount ?? 0);
  const group = String(entity.entityGroup ?? "master_data");
  const sensitivity = String(entity.sensitivity ?? "normal");
  const riskLevel = String(entity.riskLevel ?? "low");
  const description = String(entity.description ?? `Discovered entity ${name}`);
  const columns = Array.isArray(entity.columns) ? entity.columns : [];

  const columnSummary = columns
    .slice(0, 20)
    .map((column) => {
      const colName = String(column?.name ?? "").trim();
      if (!colName) return null;
      const dataType = String(column?.dataType ?? "text").trim() || "text";
      const nullable = column?.nullable === false ? "NOT NULL" : "NULLABLE";
      const sensitivityLabel = String(column?.sensitivity ?? "normal").trim() || "normal";
      return `- ${colName} (${dataType}, ${nullable}, sensitivity=${sensitivityLabel})`;
    })
    .filter((line): line is string => Boolean(line));

  const sections = [
    `Connection: ${connectionName}`,
    `Entity: ${name}`,
    `Source kind: ${sourceKind}`,
    `Entity group: ${group}`,
    `Estimated rows: ${Number.isFinite(rowCount) ? rowCount : 0}`,
    `Sensitivity: ${sensitivity}`,
    `Risk level: ${riskLevel}`,
    "",
    `Description: ${description}`,
  ];

  if (columnSummary.length > 0) {
    sections.push("", "Columns:", ...columnSummary);
  }

  return sections.join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const workerAuth = requireWorkerToken(req);
  if (!workerAuth.ok) return workerAuth.response;

  const service = getServiceClient();
  if (!service.ok) return service.response;

  let jobId = "";
  let workerId = "";
  let status = "error";
  let progress = 0;
  let errorMessage: string | null = null;
  let resultPayload: Record<string, unknown> = {};
  let entities: SyncEntity[] = [];
  let relationships: SyncRelationship[] = [];

  try {
    const body = await req.json();
    jobId = String(body?.jobId ?? "").trim();
    workerId = String(body?.workerId ?? "connector-worker").trim();
    status = normalizeStatus(String(body?.status ?? "error"));
    progress = Number(body?.progress ?? (status === "success" ? 100 : status === "running" ? 50 : 0));
    errorMessage = body?.error ? String(body.error) : null;
    resultPayload = normalizeResultPayload(body?.result);
    entities = Array.isArray(body?.schema?.entities) ? body.schema.entities : [];
    relationships = Array.isArray(body?.schema?.relationships) ? body.schema.relationships : [];
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!jobId) return errorResponse(400, "jobId is required");

  const { data: job, error: jobError } = await service.supabase
    .from("connector_jobs")
    .select("id, tenant_id, connection_id, status, attempt_count, max_attempts, result, started_at, created_at")
    .eq("id", jobId)
    .maybeSingle();

  if (jobError) return errorResponse(400, "Could not load connector job", jobError.message);
  if (!job) return errorResponse(404, "Connector job not found");

  const { data: connection, error: connectionError } = await service.supabase
    .from("api_connections")
    .select("id, tenant_id, name, type, sync_frequency, last_synced_at")
    .eq("id", job.connection_id)
    .eq("tenant_id", job.tenant_id)
    .maybeSingle();

  if (connectionError) return errorResponse(400, "Could not load connection for sync callback", connectionError.message);
  if (!connection) return errorResponse(404, "Connection not found for sync callback");

  const syncFrequency = normalizeSyncFrequency(connection.sync_frequency);

  const now = new Date().toISOString();

  const nextAttemptCount = status === "error" ? Number(job.attempt_count ?? 0) + 1 : Number(job.attempt_count ?? 0);
  const maxAttempts = Number(job.max_attempts ?? 5);
  const shouldRetry = status === "error" && nextAttemptCount < maxAttempts;
  const finalStatus = shouldRetry ? "queued" : status === "error" && nextAttemptCount >= maxAttempts ? "dead_letter" : status;
  const retryAt = shouldRetry
    ? new Date(Date.now() + retryDelaySeconds(nextAttemptCount) * 1000).toISOString()
    : null;
  const currentResult = normalizeResultPayload(job.result);
  const mergedResult: Record<string, unknown> = {
    ...currentResult,
    ...resultPayload,
  };
  const stage = resolveStage(mergedResult, status);
  mergedResult.stage = stage;

  const progressValue = clampProgress(progress, status === "success" ? 100 : status === "running" ? 50 : 0);
  let schemaEmptyOnSuccess = false;
  const terminalStatus = ["success", "cancelled", "dead_letter"].includes(finalStatus);
  const jobUpdate: Record<string, unknown> = {
    status: finalStatus,
    progress: finalStatus === "success" ? 100 : progressValue,
    worker_id: workerId || null,
    last_error: errorMessage,
    attempt_count: nextAttemptCount,
    result: mergedResult,
    updated_at: now,
  };
  if (job.status === "queued" || status === "running") {
    jobUpdate.started_at = job.started_at ?? now;
  }
  if (terminalStatus) {
    jobUpdate.finished_at = now;
  } else {
    jobUpdate.finished_at = null;
  }
  if (shouldRetry && retryAt) {
    jobUpdate.scheduled_at = retryAt;
    jobUpdate.started_at = null;
    jobUpdate.finished_at = null;
  }

  const { error: updateJobError } = await service.supabase
    .from("connector_jobs")
    .update(jobUpdate)
    .eq("id", job.id);

  if (updateJobError) return errorResponse(400, "Could not update connector job", updateJobError.message);

  const { data: runningSyncRun } = await service.supabase
    .from("connection_sync_runs")
    .select("id, started_at")
    .eq("tenant_id", job.tenant_id)
    .eq("connection_id", job.connection_id)
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const syncDetails = {
    ...mergedResult,
    stage,
    progress: finalStatus === "success" ? 100 : progressValue,
    job_id: job.id,
    worker_id: workerId,
    retry_scheduled_at: retryAt,
  };

  if (finalStatus === "running") {
    if (runningSyncRun?.id) {
      await service.supabase
        .from("connection_sync_runs")
        .update({
          details: syncDetails,
        })
        .eq("id", runningSyncRun.id);
    } else {
      await service.supabase.from("connection_sync_runs").insert({
        tenant_id: job.tenant_id,
        connection_id: job.connection_id,
        triggered_by: null,
        status: "running",
        started_at: job.started_at ?? now,
        details: syncDetails,
      });
    }
  }

  if (finalStatus === "running") {
    await service.supabase
      .from("api_connections")
      .update({
        status: "syncing",
        analysis_started_at: job.started_at ?? now,
        last_error: null,
      })
      .eq("id", job.connection_id)
      .eq("tenant_id", job.tenant_id);

    return jsonResponse(200, { ok: true, jobId: job.id, status: finalStatus });
  }

  if (status === "success" || status === "error" || status === "cancelled" || finalStatus === "dead_letter") {
    const startedAt = job.started_at ?? now;
    const startedMs = new Date(startedAt).getTime();
    const finishedMs = new Date(now).getTime();
    const durationMs = Number(mergedResult.durationMs ?? Math.max(1, finishedMs - startedMs));

    const { error: attemptError } = await service.supabase.from("connector_job_attempts").insert({
      job_id: job.id,
      tenant_id: job.tenant_id,
      worker_id: workerId,
      status: status === "success" ? "success" : status === "cancelled" ? "cancelled" : "error",
      started_at: startedAt,
      finished_at: now,
      duration_ms: Number.isFinite(durationMs) ? durationMs : null,
      error_message: errorMessage,
      details: syncDetails,
    });

    if (attemptError) {
      console.error("Could not persist connector attempt", attemptError.message);
    }
  }

  if (finalStatus === "success") {
    const entityMap = new Map<string, string>();
    let persistedEntityCount = 0;
    const entityInsertErrors: string[] = [];

    const { data: existingEntities } = await service.supabase
      .from("connection_entities")
      .select("id")
      .eq("tenant_id", job.tenant_id)
      .eq("connection_id", job.connection_id);

    const existingIds = (existingEntities ?? []).map((row) => row.id);
    if (existingIds.length > 0) {
      await service.supabase
        .from("connection_columns")
        .delete()
        .eq("tenant_id", job.tenant_id)
        .in("entity_id", existingIds);
    }

    await service.supabase
      .from("connection_relationships")
      .delete()
      .eq("tenant_id", job.tenant_id)
      .eq("connection_id", job.connection_id);

    await service.supabase
      .from("connection_entities")
      .delete()
      .eq("tenant_id", job.tenant_id)
      .eq("connection_id", job.connection_id);

    for (const entity of entities) {
      const name = String(entity.name ?? "").trim();
      if (!name) continue;

      const { data: insertedEntity, error: entityError } = await service.supabase
        .from("connection_entities")
        .insert({
          tenant_id: job.tenant_id,
          connection_id: job.connection_id,
          name,
          source_kind: normalizeEntitySourceKind(entity.sourceKind),
          entity_group: entity.entityGroup ?? "master_data",
          row_count: Number(entity.rowCount ?? 0),
          risk_level: entity.riskLevel ?? "low",
          sensitivity: entity.sensitivity ?? "normal",
          description: entity.description ?? null,
          embedding_coverage: Number(entity.embeddingCoverage ?? 0),
          metadata: {},
        })
        .select("id")
        .single();

      if (entityError) {
        console.error("Could not insert synced entity", entityError.message);
        entityInsertErrors.push(`${name}: ${entityError.message}`);
        continue;
      }

      entityMap.set(name, insertedEntity.id);
      persistedEntityCount += 1;

      const columns = Array.isArray(entity.columns) ? entity.columns : [];
      if (columns.length > 0) {
        const columnRows = columns
          .map((column, index) => ({
            tenant_id: job.tenant_id,
            entity_id: insertedEntity.id,
            name: String(column.name ?? "").trim(),
            data_type: column.dataType ?? "text",
            is_nullable: Boolean(column.nullable ?? true),
            sensitivity: column.sensitivity ?? "normal",
            position_index: index + 1,
            sample_value: column.sampleValue ?? null,
          }))
          .filter((column) => column.name.length > 0);

        if (columnRows.length > 0) {
          const { error: columnsError } = await service.supabase
            .from("connection_columns")
            .insert(columnRows);
          if (columnsError) {
            console.error("Could not insert synced columns", columnsError.message);
          }
        }
      }
    }

    if (relationships.length > 0 && entityMap.size > 0) {
      const relationshipRows = relationships
        .map((relationship) => {
          const sourceId = entityMap.get(String(relationship.sourceName ?? "").trim());
          const targetId = entityMap.get(String(relationship.targetName ?? "").trim());
          if (!sourceId || !targetId) return null;
          return {
            tenant_id: job.tenant_id,
            connection_id: job.connection_id,
            source_entity_id: sourceId,
            target_entity_id: targetId,
            relation_type: relationship.relationType ?? "foreign_key",
            label: relationship.label ?? `${relationship.sourceName} -> ${relationship.targetName}`,
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);

      if (relationshipRows.length > 0) {
        const { error: relError } = await service.supabase
          .from("connection_relationships")
          .insert(relationshipRows);
        if (relError) {
          console.error("Could not insert synced relationships", relError.message);
        }
      }
    }

    let generatedSchemaDocuments = 0;
    let queuedEmbeddingJobs = 0;
    const schemaPathPrefix = `connector-schema/${job.connection_id}/`;

    const { data: existingSchemaDocs } = await service.supabase
      .from("knowledge_documents")
      .select("id")
      .eq("tenant_id", job.tenant_id)
      .eq("source_type", "connection_schema")
      .like("storage_path", `${schemaPathPrefix}%`);

    const existingSchemaDocIds = (existingSchemaDocs ?? []).map((row) => row.id);
    if (existingSchemaDocIds.length > 0) {
      await service.supabase
        .from("knowledge_documents")
        .delete()
        .eq("tenant_id", job.tenant_id)
        .in("id", existingSchemaDocIds);
    }

    const knowledgeDocRows = entities
      .map((entity) => {
        const entityName = String(entity.name ?? "").trim();
        if (!entityName) return null;
        const entityId = entityMap.get(entityName);
        if (!entityId) return null;

        const excerpt = String(entity.description ?? `Discovered entity ${entityName}`).slice(0, 400);
        const fileStem = `${safeSlug(String(connection.name ?? "connection"))}-${safeSlug(entityName)}`;
        return {
          tenant_id: job.tenant_id,
          uploaded_by: null,
          title: `${connection.name} :: ${entityName}`,
          file_name: `${fileStem}.schema.md`,
          file_type: "schema",
          source_type: "connection_schema",
          storage_path: `${schemaPathPrefix}${entityId}.md`,
          external_url: `opsai://connections/${job.connection_id}/entities/${entityId}`,
          excerpt,
          status: "indexed",
          indexed_at: now,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    const chunkContentByPath = new Map<string, string>();
    for (const entity of entities) {
      const entityName = String(entity.name ?? "").trim();
      if (!entityName) continue;
      const entityId = entityMap.get(entityName);
      if (!entityId) continue;
      const storagePath = `${schemaPathPrefix}${entityId}.md`;
      chunkContentByPath.set(storagePath, buildEntityKnowledgeText(String(connection.name ?? "Connection"), entity));
    }

    if (knowledgeDocRows.length > 0) {
      const insertedDocs = await service.supabase
        .from("knowledge_documents")
        .insert(knowledgeDocRows)
        .select("id, storage_path");

      if (insertedDocs.error) {
        console.error("Could not insert schema knowledge documents", insertedDocs.error.message);
      } else {
        generatedSchemaDocuments = insertedDocs.data?.length ?? 0;
        const chunkRows = (insertedDocs.data ?? [])
          .map((doc) => {
            const storagePath = String(doc.storage_path ?? "");
            const content = chunkContentByPath.get(storagePath);
            if (!content) return null;
            return {
              tenant_id: job.tenant_id,
              document_id: doc.id,
              chunk_index: 0,
              content,
              token_count: estimateTokenCount(content),
              embedding_state: "pending",
            };
          })
          .filter((row): row is NonNullable<typeof row> => row !== null);

        if (chunkRows.length > 0) {
          const insertedChunks = await service.supabase
            .from("knowledge_document_chunks")
            .insert(chunkRows)
            .select("id, document_id");

          if (insertedChunks.error) {
            console.error("Could not insert schema knowledge chunks", insertedChunks.error.message);
          } else {
            const queuedRows = (insertedChunks.data ?? []).map((chunk) => ({
              tenant_id: job.tenant_id,
              source_type: "knowledge_chunk",
              source_id: chunk.id,
              status: "queued",
              priority: 58,
              embedding_model: "text-embedding-3-small",
              vector_dimensions: 1536,
              idempotency_key: `connector-schema:${job.connection_id}:chunk:${chunk.id}`,
              payload: {
                source: "connector-sync-worker-callback",
                connection_id: job.connection_id,
                document_id: chunk.document_id,
                stage: "schema_bootstrapped",
              },
              created_by: null,
            }));

            if (queuedRows.length > 0) {
              const queueEmbeddings = await service.supabase
                .from("embedding_jobs")
                .insert(queuedRows)
                .select("id");

              if (queueEmbeddings.error) {
                if (queueEmbeddings.error.code === "23505") {
                  // Treat duplicate idempotency rows as already queued.
                  queuedEmbeddingJobs = queuedRows.length;
                } else {
                  console.error("Could not queue schema embedding jobs", queueEmbeddings.error.message);
                }
              } else {
                queuedEmbeddingJobs = queueEmbeddings.data?.length ?? queuedRows.length;
              }
            }
          }
        }
      }
    }

    const tablesCount = persistedEntityCount;
    const entitiesCount = persistedEntityCount;
    const hasDiscoveredSchema = entitiesCount > 0;
    schemaEmptyOnSuccess = !hasDiscoveredSchema;

    syncDetails.generated_documents = generatedSchemaDocuments;
    syncDetails.embedding_jobs_queued = queuedEmbeddingJobs;
    syncDetails.discovered_entities = entitiesCount;
    syncDetails.discovered_entities_payload = entities.length;
    if (entityInsertErrors.length > 0) {
      syncDetails.entity_insert_errors = entityInsertErrors.slice(0, 5);
    }
    if (schemaEmptyOnSuccess) {
      const insertHint =
        entityInsertErrors.length > 0
          ? ` First insert error: ${entityInsertErrors[0]}`
          : "";
      syncDetails.warning = `Schema discovery completed but persisted zero entities.${insertHint}`;
      syncDetails.stage = "schema_empty";
    }

    await service.supabase
      .from("api_connections")
      .update({
        status: hasDiscoveredSchema ? "active" : "pending",
        health: hasDiscoveredSchema ? "healthy" : "degraded",
        schema_detected: hasDiscoveredSchema,
        schema_tables_count: tablesCount,
        schema_entities_count: entitiesCount,
        analysis_completed_at: now,
        last_synced_at: now,
        next_sync_at: computeNextSyncAt(syncFrequency, now),
        sync_lag_seconds: 0,
        embeddings_indexed: queuedEmbeddingJobs,
        last_error: hasDiscoveredSchema ? null : "Schema discovery returned zero entities. Check connector permissions/visibility.",
      })
      .eq("id", job.connection_id)
      .eq("tenant_id", job.tenant_id);

    await service.supabase
      .from("connection_entities")
      .update({
        embedding_coverage: queuedEmbeddingJobs > 0 ? 50 : 0,
      })
      .eq("tenant_id", job.tenant_id)
      .eq("connection_id", job.connection_id);

    await service.supabase.rpc("regenerate_agents_for_tenant", {
      p_tenant_id: job.tenant_id,
      p_force: false,
    });

    const predictiveRefresh = await service.supabase.rpc("refresh_predictive_insights_for_tenant", {
      p_tenant_id: job.tenant_id,
      p_force: false,
    });
    if (predictiveRefresh.error) {
      console.error("predictive refresh failed", predictiveRefresh.error.message);
    }
  }

  const resolvedSyncStatus =
    schemaEmptyOnSuccess
      ? "error"
      : finalStatus === "success"
      ? "success"
      : finalStatus === "cancelled"
        ? "cancelled"
        : shouldRetry
          ? "error"
          : "error";
  const resolvedLatencyMs = Number.isFinite(Number(mergedResult.durationMs))
    ? Number(mergedResult.durationMs)
    : null;

  if (runningSyncRun?.id) {
    await service.supabase
      .from("connection_sync_runs")
      .update({
        status: resolvedSyncStatus,
        finished_at: now,
        latency_ms: resolvedLatencyMs,
        error_message: schemaEmptyOnSuccess
          ? "Schema discovery returned zero entities"
          : finalStatus === "success"
            ? null
            : errorMessage ?? "Sync failed",
        details: syncDetails,
      })
      .eq("id", runningSyncRun.id);
  } else {
    await service.supabase.from("connection_sync_runs").insert({
      tenant_id: job.tenant_id,
      connection_id: job.connection_id,
      triggered_by: null,
      status: resolvedSyncStatus,
      started_at: job.started_at ?? now,
      finished_at: now,
      latency_ms: resolvedLatencyMs,
      error_message: schemaEmptyOnSuccess
        ? "Schema discovery returned zero entities"
        : finalStatus === "success"
          ? null
          : errorMessage ?? "Sync failed",
      details: syncDetails,
    });
  }

  if (shouldRetry) {
    await service.supabase
      .from("api_connections")
      .update({
        status: "pending",
        health: "degraded",
        next_sync_at: retryAt ?? computeNextSyncAt(syncFrequency, now),
        sync_lag_seconds: computeSyncLagSeconds(connection.last_synced_at, now),
        last_error: errorMessage ?? "Sync failed, retry queued",
      })
      .eq("id", job.connection_id)
      .eq("tenant_id", job.tenant_id);
  } else if (finalStatus === "error" || finalStatus === "dead_letter" || finalStatus === "cancelled") {
    await service.supabase
      .from("api_connections")
      .update({
        status: finalStatus === "cancelled" ? "pending" : "error",
        health: "degraded",
        next_sync_at: computeNextSyncAt(syncFrequency, now),
        sync_lag_seconds: computeSyncLagSeconds(connection.last_synced_at, now),
        last_error: errorMessage ?? "Sync failed",
      })
      .eq("id", job.connection_id)
      .eq("tenant_id", job.tenant_id);
  }

  await service.supabase.from("audit_logs").insert({
    tenant_id: job.tenant_id,
    user_id: null,
    action: "connector.sync.callback",
    resource: String(job.connection_id),
    status: finalStatus === "success" ? "success" : shouldRetry ? "retry_queued" : finalStatus,
    details: {
      jobId: job.id,
      workerId,
      status: finalStatus,
      stage,
      progress: finalStatus === "success" ? 100 : progressValue,
      retryAt,
      entityCount: entities.length,
      relationshipCount: relationships.length,
      error: errorMessage,
    },
  });

  return jsonResponse(200, {
    ok: true,
    jobId: job.id,
    status: finalStatus,
    retryAt,
  });
});
