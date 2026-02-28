import { getQueueService, QUEUES } from '../lib/queue';
import { getSupabaseService } from '../lib/supabase';
import { getEmbedder } from '../pipeline/embedder';

export function startIngestionWorker() {
  const queueService = getQueueService();
  const ingestionQueue = queueService.getQueue(QUEUES.INGESTION);

  ingestionQueue.process(async (job) => {
    const { tenant_id, source_kind, source_id, content, metadata } = job.data;
    const supabase = getSupabaseService();
    const embedder = getEmbedder();

    try {
      console.log(`Ingesting content for tenant ${tenant_id}, source ${source_id}`);

      // 1. Logic for chunking (simplified for now)
      const chunks = chunkText(content, 512, 50);
      
      // 2. Process and store embeddings
      await embedder.processBatch(
        tenant_id,
        source_kind,
        source_id,
        chunks.map(c => ({ content: c, metadata }))
      );

      // 3. Log event
      await supabase.getClient().from('context_events').insert({
        tenant_id,
        source_type: source_kind,
        source_id,
        event_type: 'ingested',
        content: `Ingested ${chunks.length} chunks`,
        metadata
      });

      return { success: true, chunks: chunks.length };
    } catch (err) {
      console.error(`Ingestion failed for job ${job.id}:`, err);
      throw err;
    }
  });
}

function chunkText(text: string, size: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + size));
    start += size - overlap;
  }
  return chunks;
}
