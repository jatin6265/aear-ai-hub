import OpenAI from 'openai';
import { getSupabaseService } from '../lib/supabase';
import { EMBEDDING_MODEL } from '../lib/ai-config';

export type SearchResult = {
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  source_kind: string;
  source_id: string;
  occurred_at?: string | null;
};

export class Retriever {
  private openai: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is missing');
    }
    this.openai = new OpenAI({ apiKey });
  }

  /**
   * Hybrid retrieval across semantic memory + timeline memory.
   * Structured SQL memory stays in tool/routing layer.
   */
  async search(
    tenantId: string,
    query: string,
    options: { limit?: number; threshold?: number } = {}
  ): Promise<SearchResult[]> {
    const cleanQuery = query.replace(/\n/g, ' ').trim();
    const limit = Math.max(1, options.limit ?? 10);
    const threshold = options.threshold ?? 0.45;

    // Same embedding model for ingestion + query retrieval is mandatory.
    const embeddingResponse = await this.openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: cleanQuery,
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

    let semanticRows: SearchResult[] = [];
    let semanticError: Error | null = null;
    try {
      semanticRows = await this.searchSemanticMemory(tenantId, cleanQuery, queryEmbedding, limit, threshold);
    } catch (error) {
      semanticError = error instanceof Error ? error : new Error(String(error));
    }

    const [timelineRows, knowledgeRows] = await Promise.all([
      this.searchEventTimeline(tenantId, cleanQuery, Math.max(3, Math.floor(limit / 2))),
      semanticRows.length > 0
        ? Promise.resolve([])
        : this.searchKnowledgeFallback(tenantId, cleanQuery, queryEmbedding, Math.max(3, Math.floor(limit / 2))),
    ]);

    const merged = dedupeAndRank([...semanticRows, ...knowledgeRows, ...timelineRows], limit);
    if (merged.length === 0 && semanticError) {
      throw semanticError;
    }
    return merged;
  }

  private async searchSemanticMemory(
    tenantId: string,
    query: string,
    queryEmbedding: number[],
    limit: number,
    threshold: number
  ): Promise<SearchResult[]> {
    const supabase = getSupabaseService();
    const { data, error } = await supabase.getClient().rpc('hybrid_search', {
      p_query_embedding: queryEmbedding,
      p_tenant_id: tenantId,
      p_match_count: limit,
      p_similarity_threshold: threshold,
      p_query_text: query,
    });

    if (error) {
      throw new Error(`hybrid_search failed: ${error.message}`);
    }

    return (Array.isArray(data) ? data : []).map((row) => {
      const record = asRecord(row);
      return {
        content: String(record.content ?? ''),
        metadata: asRecord(record.metadata),
        similarity: Number(record.final_score ?? record.similarity ?? 0),
        source_kind: String(record.source_kind ?? 'semantic'),
        source_id: String(record.source_id ?? 'unknown'),
        occurred_at: typeof record.occurred_at === 'string' ? record.occurred_at : null,
      };
    }).filter((row) => row.content.length > 0);
  }

  private async searchEventTimeline(tenantId: string, query: string, limit: number): Promise<SearchResult[]> {
    const supabase = getSupabaseService();
    const sanitized = query.replace(/[%_]/g, '');
    let builder = supabase.getClient()
      .from('context_events')
      .select('source_type, source_id, content, metadata, occurred_at')
      .eq('tenant_id', tenantId)
      .order('occurred_at', { ascending: false })
      .limit(limit);

    if (sanitized.length > 0) {
      builder = builder.ilike('content', `%${sanitized}%`);
    }

    const { data, error } = await builder;
    if (error) {
      throw new Error(`context event retrieval failed: ${error.message}`);
    }

    return (data ?? []).map((row) => {
      const record = asRecord(row);
      const occurredAt = typeof record.occurred_at === 'string' ? record.occurred_at : null;
      return {
        content: String(record.content ?? ''),
        metadata: {
          ...asRecord(record.metadata),
          memory_type: 'event_timeline',
        },
        similarity: recencyScore(occurredAt),
        source_kind: String(record.source_type ?? 'event'),
        source_id: String(record.source_id ?? 'timeline'),
        occurred_at: occurredAt,
      };
    }).filter((row) => row.content.length > 0);
  }

  private async searchKnowledgeFallback(
    tenantId: string,
    query: string,
    queryEmbedding: number[],
    limit: number
  ): Promise<SearchResult[]> {
    const supabase = getSupabaseService();
    const { data, error } = await supabase.getClient().rpc('search_knowledge_documents_hybrid', {
      p_query: query,
      p_query_embedding: queryEmbedding,
      p_limit: limit,
      p_tenant_id: tenantId,
    });

    if (error) {
      throw new Error(`search_knowledge_documents_hybrid failed: ${error.message}`);
    }

    return (Array.isArray(data) ? data : []).map((row) => {
      const record = asRecord(row);
      const title = String(record.title ?? 'document');
      const excerpt = String(record.excerpt ?? '').trim();
      const relevance = Number(record.relevance ?? 0);
      return {
        content: excerpt || title,
        metadata: {
          ...asRecord(record.score_breakdown),
          memory_type: 'knowledge_document',
          tenant_id: tenantId,
          title,
          external_url: record.external_url ?? null,
          file_type: record.file_type ?? null,
        },
        similarity: Math.max(0, Math.min(1, relevance / 100)),
        source_kind: 'knowledge_document',
        source_id: String(record.id ?? title),
        occurred_at: null,
      };
    }).filter((row) => row.content.length > 0);
  }
}

function dedupeAndRank(rows: SearchResult[], limit: number): SearchResult[] {
  const deduped = new Map<string, SearchResult>();
  for (const row of rows) {
    const key = `${row.source_kind}:${row.source_id}:${row.content}`;
    const existing = deduped.get(key);
    if (!existing || row.similarity > existing.similarity) {
      deduped.set(key, row);
    }
  }

  return [...deduped.values()]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

function recencyScore(occurredAt: string | null): number {
  if (!occurredAt) return 0.25;
  const eventTime = new Date(occurredAt).getTime();
  if (Number.isNaN(eventTime)) return 0.25;
  const ageDays = Math.max(0, (Date.now() - eventTime) / (1000 * 60 * 60 * 24));
  return Math.max(0.25, Math.min(1, 1 / (1 + ageDays / 3)));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

let instance: Retriever | null = null;
export function getRetriever(): Retriever {
  if (!instance) {
    instance = new Retriever();
  }
  return instance;
}
