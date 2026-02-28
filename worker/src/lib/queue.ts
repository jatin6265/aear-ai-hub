import Queue from 'bull';
import { getRedisInstance } from './redis';

/**
 * Manages job queues for the OpsAI worker.
 * Uses Bull (Redis-backed) for reliable background processing.
 */
export class QueueService {
  private queues: Map<string, Queue.Queue> = new Map();

  getQueue(name: string): Queue.Queue {
    if (!this.queues.has(name)) {
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) {
        throw new Error('REDIS_URL is required for QueueService');
      }
      
      const queue = new Queue(name, redisUrl, {
        defaultJobOptions: {
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: true,
        },
      });
      this.queues.set(name, queue);
    }
    return this.queues.get(name)!;
  }

  async closeAll(): Promise<void> {
    for (const queue of this.queues.values()) {
      await queue.close();
    }
    this.queues.clear();
  }
}

let instance: QueueService | null = null;

export function getQueueService(): QueueService {
  if (!instance) {
    instance = new QueueService();
  }
  return instance;
}

// Named queues as per architecture
export const QUEUES = {
  INGESTION: 'ingestion-pipeline',
  SYNC: 'connector-sync',
  EMBEDDING: 'embedding-batch',
  AGENT_RUN: 'agent-runtime',
  WEBHOOK: 'webhook-delivery',
};
