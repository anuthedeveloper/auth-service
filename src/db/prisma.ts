import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

let client: PrismaClient | undefined;

/**
 * Lazily creates a single shared PrismaClient. Lazy so that importing the app
 * (e.g. in tests that don't touch the database) never opens a connection.
 */
export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      datasources: { db: { url: env.DATABASE_URL } },
      log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
