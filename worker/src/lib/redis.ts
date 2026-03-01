import { Redis } from 'ioredis';

let instance: Redis | null = null;

export function getRedisInstance(): Redis {
  if (!instance) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL environment variable is missing.');
    }
    instance = new Redis(url, {
      maxRetriesPerRequest: null,
      // Reconnect with capped exponential backoff (max 30s between attempts).
      retryStrategy: (times: number) => Math.min(times * 500, 30_000),
    });

    // Prevent unhandled rejection crashes — ioredis emits 'error' on connection failure.
    instance.on('error', (err: Error) => {
      console.error('[redis] Connection error (will retry):', err.message);
    });

    instance.on('reconnecting', (delay: number) => {
      console.warn(`[redis] Reconnecting in ${delay}ms…`);
    });

    instance.on('connect', () => {
      console.log('[redis] Connected');
    });
  }
  return instance;
}
