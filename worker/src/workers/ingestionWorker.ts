import { createHash } from 'node:crypto';
import { getQueueService, QUEUES } from '../lib/queue';
import { getSupabaseService } from '../lib/supabase';
import { getEmbedder } from '../pipeline/embedder';
import { CHUNK_CONFIG, EMBEDDING_MODEL } from '../lib/ai-config';

type IngestionJobData = {
  tenant_id: string;
  source_kind: string;
  source_id?: string;
  content?: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export function startIngestionWorker() {
  const queueService = getQueueService();
  const ingestionQueue = queueService.getQueue(QUEUES.INGESTION);

  ingestionQueue.process(async (job) => {
    const data = (job.data ?? {}) as IngestionJobData;
    const normalized = normalizeIngestionJob(data);
    const supabase = getSupabaseService();
    const embedder = getEmbedder();

    try {
      console.log(`Ingesting content for tenant ${normalized.tenantId}, source ${normalized.sourceId}`);

      const chunks = chunkTextByTokenWindow(
        normalized.content,
        CHUNK_CONFIG.sizeTokens,
        CHUNK_CONFIG.overlapTokens,
      );
      const dedupedChunks = dedupeChunks(chunks).map((chunk, index, all) => ({
        content: chunk.content,
        metadata: {
          ...normalized.metadata,
          chunk_index: index,
          chunk_total: all.length,
          content_hash: chunk.hash,
          embedding_model: EMBEDDING_MODEL,
        },
      }));

      if (dedupedChunks.length === 0) {
        throw new Error('No chunks generated after normalization/deduplication');
      }

      await embedder.processBatch(
        normalized.tenantId,
        normalized.sourceKind,
        normalized.sourceId,
        dedupedChunks,
      );

      await supabase.getClient().from('context_events').insert({
        tenant_id: normalized.tenantId,
        source_type: normalized.sourceKind,
        source_id: normalized.sourceId,
        event_type: 'ingested',
        content: `Ingested ${dedupedChunks.length} chunks into semantic memory`,
        metadata: {
          ...normalized.metadata,
          chunk_count: dedupedChunks.length,
          embedding_model: EMBEDDING_MODEL,
          chunk_config: CHUNK_CONFIG,
        },
      });

      return { success: true, chunks: dedupedChunks.length };
    } catch (err) {
      console.error(`Ingestion failed for job ${job.id}:`, err);
      throw err;
    }
  });
}

function chunkTextByTokenWindow(text: string, sizeTokens: number, overlapTokens: number): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const tokens = normalized.split(' ');
  const step = Math.max(1, sizeTokens - overlapTokens);
  const chunks: string[] = [];
  let start = 0;
  while (start < tokens.length) {
    const chunk = tokens.slice(start, start + sizeTokens).join(' ').trim();
    if (chunk.length > 0) chunks.push(chunk);
    start += step;
  }
  return chunks;
}

function dedupeChunks(chunks: string[]): Array<{ content: string; hash: string }> {
  const seen = new Set<string>();
  const unique: Array<{ content: string; hash: string }> = [];
  for (const chunk of chunks) {
    const hash = createHash('sha256').update(chunk).digest('hex');
    if (seen.has(hash)) continue;
    seen.add(hash);
    unique.push({ content: chunk, hash });
  }
  return unique;
}

function normalizeIngestionJob(data: IngestionJobData): {
  tenantId: string;
  sourceKind: string;
  sourceId: string;
  content: string;
  metadata: Record<string, unknown>;
} {
  const tenantId = String(data.tenant_id ?? '').trim();
  const sourceKind = String(data.source_kind ?? 'unknown').trim() || 'unknown';
  const sourceId = String(data.source_id ?? data.payload?.source_id ?? 'unknown').trim() || 'unknown';
  const rawContent =
    typeof data.content === 'string'
      ? data.content
      : typeof data.payload?.content === 'string'
      ? String(data.payload?.content)
      : JSON.stringify(data.payload ?? {});
  const content = rawContent.replace(/\s+/g, ' ').trim();

  if (!tenantId) {
    throw new Error('ingestion job missing tenant_id');
  }
  if (!content) {
    throw new Error('ingestion job missing content');
  }

  const metadata = {
    ...(isRecord(data.payload?.metadata) ? (data.payload?.metadata as Record<string, unknown>) : {}),
    ...(isRecord(data.metadata) ? data.metadata : {}),
    source_kind: sourceKind,
    source_id: sourceId,
    normalized_at: new Date().toISOString(),
    pipeline_version: 'phase1-v1',
  };

  return { tenantId, sourceKind, sourceId, content, metadata };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
