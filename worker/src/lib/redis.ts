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
    });
  }
  return instance;
}
