import { getPrisma, disconnectPrisma } from '../db/prisma';
import { registerSchema } from '../modules/auth/auth.schemas';
import { hashPassword } from '../utils/password';
import { logger } from '../utils/logger';

export interface SeedAdminResult {
  userId: string;
  created: boolean;
}

/**
 * Creates the first admin, or promotes an existing account. Idempotent, and it never
 * overwrites an existing account's password. Public registration can only ever create
 * USER accounts, so this script is the only way to bootstrap an admin.
 */
export async function seedAdmin(input: { email: string; password: string }): Promise<SeedAdminResult> {
  // Reuse the registration rules (email format, password length).
  const { email, password } = registerSchema.parse(input);
  const prisma = getPrisma();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role !== 'ADMIN') {
      await prisma.user.update({
        where: { id: existing.id },
        data: { role: 'ADMIN', emailVerifiedAt: existing.emailVerifiedAt ?? new Date() },
      });
    }
    return { userId: existing.id, created: false };
  }

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      role: 'ADMIN',
      emailVerifiedAt: new Date(),
    },
  });
  return { userId: user.id, created: true };
}

async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD to seed the first admin');
  }

  const result = await seedAdmin({ email, password });
  logger.info(
    { userId: result.userId },
    result.created ? 'Admin account created' : 'Existing account is now an admin',
  );
}

if (require.main === module) {
  main()
    .catch((err: unknown) => {
      logger.error({ err }, 'Seeding admin failed');
      process.exitCode = 1;
    })
    .finally(() => disconnectPrisma());
}
