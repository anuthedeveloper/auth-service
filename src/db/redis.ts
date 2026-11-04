import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Options are chosen so a Redis outage makes commands fail fast, instead of queueing requests
 * behind a dead connection. The rate limiter relies on that to fail open quickly.
 */
export function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 300,
    connectTimeout: 2_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });

  // ioredis emits an error on every failed reconnect; log at most once every 30 seconds.
  let lastLogged = 0;
  client.on('error', (err: Error) => {
    const now = Date.now();
    if (now - lastLogged > 30_000) {
      lastLogged = now;
      logger.warn({ err: err.message }, 'Redis connection problem');
    }
  });

  return client;
}

let client: Redis | undefined;

export function getRedis(): Redis {
  client ??= createRedisClient(env.REDIS_URL);
  return client;
}

export async function disconnectRedis(): Promise<void> {
  if (!client) {
    return;
  }
  const current = client;
  client = undefined;
  try {
    await current.quit();
  } catch {
    current.disconnect();
  }
}
