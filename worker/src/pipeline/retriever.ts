import OpenAI from 'openai';
import { getSupabaseService } from '../lib/supabase';

const EMBEDDING_MODEL = 'text-embedding-3-small';

export type SearchResult = {
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  source_kind: string;
  source_id: string;
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
   * Hybrid search: semantic vector search + keyword boost via Supabase RPC.
   */
  async search(
    tenantId: string,
    query: string,
    options: { limit?: number; threshold?: number } = {}
  ): Promise<SearchResult[]> {
    const supabase = getSupabaseService();
    
    // 1. Generate query embedding
    const embeddingResponse = await this.openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: query.replace(/\n/g, ' '),
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

    // 2. Call hybrid search RPC
    const { data, error } = await supabase.getClient().rpc('search_knowledge_documents_hybrid', {
      p_tenant_id: tenantId,
      p_query_embedding: queryEmbedding,
      p_query_text: query,
      p_match_count: options.limit || 10,
      p_similarity_threshold: options.threshold || 0.5
    });

    if (error) {
      throw new Error(`Hybrid search failed: ${error.message}`);
    }

    return (data || []) as SearchResult[];
  }
}

let instance: Retriever | null = null;
export function getRetriever(): Retriever {
  if (!instance) {
    instance = new Retriever();
  }
  return instance;
}
