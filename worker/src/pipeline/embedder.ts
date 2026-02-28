import OpenAI from 'openai';
import { getSupabaseService } from '../lib/supabase';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 100;

export class Embedder {
  private openai: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is missing');
    }
    this.openai = new OpenAI({ apiKey });
  }

  /**
   * Generates embeddings for a list of text chunks and stores them in Supabase.
   */
  async processBatch(
    tenantId: string,
    sourceKind: string,
    sourceId: string,
    chunks: { content: string; metadata: Record<string, unknown> }[]
  ): Promise<void> {
    const supabase = getSupabaseService();

    // Process in batches to avoid LLM limits
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const inputs = batch.map(c => c.content.replace(/\n/g, ' '));

      const response = await this.openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: inputs,
      });

      const records = response.data.map((item, index) => ({
        tenant_id: tenantId,
        source_kind: sourceKind,
        source_id: sourceId,
        content: batch[index].content,
        embedding: item.embedding,
        metadata: batch[index].metadata,
      }));

      const { error } = await supabase.getClient()
        .from('embeddings')
        .upsert(records);

      if (error) {
        throw new Error(`Failed to store embeddings: ${error.message}`);
      }
    }
  }
}

let instance: Embedder | null = null;
export function getEmbedder(): Embedder {
  if (!instance) {
    instance = new Embedder();
  }
  return instance;
}
