import { createApp } from './app';
import { env } from './config/env';
import { disconnectRedis, getRedis } from './db/redis';
import { waitForBackgroundTasks } from './utils/background';
import { logger } from './utils/logger';

const app = createApp();

// Connect to Redis now, so the first requests don't reach the rate limiter without a connection.
if (env.RATE_LIMIT_ENABLED && env.RATE_LIMIT_STORE === 'redis') {
  getRedis();
}
if (env.NODE_ENV === 'production' && env.RATE_LIMIT_ENABLED && env.RATE_LIMIT_STORE === 'memory') {
  logger.warn('RATE_LIMIT_STORE=memory: limits are per process and do not hold across several instances');
}

const server = app.listen(env.PORT, () => {
  logger.info(`auth-service listening on port ${env.PORT} (${env.NODE_ENV})`);
});

function shutdown(signal: string): void {
  logger.info(`${signal} received, shutting down gracefully`);
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();

  server.close((err) => {
    if (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
    // Let queued emails finish, then close the Redis connection.
    void waitForBackgroundTasks()
      .then(disconnectRedis)
      .finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
