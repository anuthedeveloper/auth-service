import { randomUUID } from 'crypto';

export interface FakeUser {
  id: string;
  email: string;
  passwordHash: string;
  role: 'USER' | 'ADMIN';
  emailVerifiedAt: Date | null;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeRefreshToken {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedById: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
}

export interface FakeVerificationToken {
  id: string;
  userId: string;
  type: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface FakeAuditLog {
  id: string;
  event: string;
  userId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}

function uniqueViolation(field: string): Error {
  return Object.assign(new Error(`Unique constraint failed on the fields: (\`${field}\`)`), {
    code: 'P2002',
  });
}

type Comparable = Date | number;
const toNumber = (value: Comparable): number => (value instanceof Date ? value.getTime() : value);

/** One field of a where clause: null, Date equality, lt/lte/gt/gte operators, or plain equality. */
function valueMatches(actual: unknown, expected: unknown): boolean {
  if (expected === null) {
    return actual === null || actual === undefined;
  }
  if (expected instanceof Date) {
    return actual instanceof Date && actual.getTime() === expected.getTime();
  }
  if (typeof expected === 'object' && expected !== null) {
    if (actual === null || actual === undefined) {
      return false;
    }
    const ops = expected as { lt?: Comparable; lte?: Comparable; gt?: Comparable; gte?: Comparable };
    const value = toNumber(actual as Comparable);
    return (
      (ops.lt === undefined || value < toNumber(ops.lt)) &&
      (ops.lte === undefined || value <= toNumber(ops.lte)) &&
      (ops.gt === undefined || value > toNumber(ops.gt)) &&
      (ops.gte === undefined || value >= toNumber(ops.gte))
    );
  }
  return actual === expected;
}

/** Like Prisma, `null` matches null/undefined, and `OR` is a list of alternative conditions. */
function matches(row: object, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') {
      return (expected as Array<Record<string, unknown>>).some((condition) => matches(row, condition));
    }
    return valueMatches((row as Record<string, unknown>)[key], expected);
  });
}

type UserUpdate = Partial<Omit<FakeUser, 'failedLoginAttempts'>> & {
  failedLoginAttempts?: number | { increment: number };
};

/** Applies an update to a stored row, including Prisma's atomic `{ increment }`. */
function applyUserUpdate(user: FakeUser, data: UserUpdate): void {
  const { failedLoginAttempts, ...rest } = data;
  Object.assign(user, rest, { updatedAt: new Date() });
  if (typeof failedLoginAttempts === 'number') {
    user.failedLoginAttempts = failedLoginAttempts;
  } else if (failedLoginAttempts) {
    user.failedLoginAttempts += failedLoginAttempts.increment;
  }
}

/** Real Prisma returns fresh objects, so earlier reads must not change when a row is updated. */
function clone<T extends object>(row: T | undefined): T | null {
  return row ? { ...row } : null;
}

/**
 * Minimal in-memory stand-in for the parts of PrismaClient the service layer uses,
 * so tests run without a database. Mirrors the unique constraints (P2002).
 * JS is single-threaded, so each method runs atomically, like a DB row update.
 */
export function createFakePrisma() {
  const users: FakeUser[] = [];
  const refreshTokens: FakeRefreshToken[] = [];
  const verificationTokens: FakeVerificationToken[] = [];
  const auditLogs: FakeAuditLog[] = [];

  const fake = {
    users,
    refreshTokens,
    verificationTokens,
    auditLogs,
    reset(): void {
      users.length = 0;
      refreshTokens.length = 0;
      verificationTokens.length = 0;
      auditLogs.length = 0;
    },
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) =>
        clone(
          users.find(
            (u) =>
              (where.id !== undefined && u.id === where.id) ||
              (where.email !== undefined && u.email === where.email),
          ),
        ),
      // Insertion order stands in for `orderBy: createdAt, id`.
      findMany: async ({ skip = 0, take }: { skip?: number; take?: number; orderBy?: unknown }) =>
        users.slice(skip, take === undefined ? undefined : skip + take).map((u) => ({ ...u })),
      count: async () => users.length,
      create: async ({
        data,
      }: {
        data: {
          email: string;
          passwordHash: string;
          role?: 'USER' | 'ADMIN';
          emailVerifiedAt?: Date | null;
        };
      }) => {
        if (users.some((u) => u.email === data.email)) {
          throw uniqueViolation('email');
        }
        const now = new Date();
        const user: FakeUser = {
          id: randomUUID(),
          email: data.email,
          passwordHash: data.passwordHash,
          role: data.role ?? 'USER',
          emailVerifiedAt: data.emailVerifiedAt ?? null,
          failedLoginAttempts: 0,
          lockedUntil: null,
          createdAt: now,
          updatedAt: now,
        };
        users.push(user);
        return { ...user };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: UserUpdate;
        select?: unknown;
      }) => {
        const user = users.find((u) => u.id === where.id);
        if (!user) {
          throw Object.assign(new Error('Record to update not found'), { code: 'P2025' });
        }
        applyUserUpdate(user, data);
        return { ...user };
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: UserUpdate }) => {
        const rows = users.filter((u) => matches(u, where));
        rows.forEach((row) => applyUserUpdate(row, data));
        return { count: rows.length };
      },
    },
    refreshToken: {
      findUnique: async ({ where }: { where: { id?: string; tokenHash?: string } }) =>
        clone(
          refreshTokens.find(
            (t) =>
              (where.id !== undefined && t.id === where.id) ||
              (where.tokenHash !== undefined && t.tokenHash === where.tokenHash),
          ),
        ),
      create: async ({
        data,
      }: {
        data: {
          id?: string;
          userId: string;
          familyId: string;
          tokenHash: string;
          expiresAt: Date;
          userAgent?: string;
          ipAddress?: string;
        };
      }) => {
        if (refreshTokens.some((t) => t.tokenHash === data.tokenHash)) {
          throw uniqueViolation('token_hash');
        }
        const token: FakeRefreshToken = {
          id: data.id ?? randomUUID(),
          userId: data.userId,
          familyId: data.familyId,
          tokenHash: data.tokenHash,
          expiresAt: data.expiresAt,
          revokedAt: null,
          replacedById: null,
          userAgent: data.userAgent ?? null,
          ipAddress: data.ipAddress ?? null,
          createdAt: new Date(),
        };
        refreshTokens.push(token);
        return { ...token };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<FakeRefreshToken>;
      }) => {
        const rows = refreshTokens.filter((t) => matches(t, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    },
    verificationToken: {
      findUnique: async ({ where }: { where: { id?: string; tokenHash?: string } }) =>
        clone(
          verificationTokens.find(
            (t) =>
              (where.id !== undefined && t.id === where.id) ||
              (where.tokenHash !== undefined && t.tokenHash === where.tokenHash),
          ),
        ),
      create: async ({
        data,
      }: {
        data: Pick<FakeVerificationToken, 'userId' | 'type' | 'tokenHash' | 'expiresAt'>;
      }) => {
        if (verificationTokens.some((t) => t.tokenHash === data.tokenHash)) {
          throw uniqueViolation('token_hash');
        }
        const token: FakeVerificationToken = {
          id: randomUUID(),
          ...data,
          usedAt: null,
          createdAt: new Date(),
        };
        verificationTokens.push(token);
        return { ...token };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<FakeVerificationToken>;
      }) => {
        const rows = verificationTokens.filter((t) => matches(t, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const keep = verificationTokens.filter((t) => !matches(t, where));
        const count = verificationTokens.length - keep.length;
        verificationTokens.length = 0;
        verificationTokens.push(...keep);
        return { count };
      },
    },
    auditLog: {
      create: async ({ data }: { data: Omit<FakeAuditLog, 'id' | 'createdAt'> }) => {
        const row: FakeAuditLog = { ...data, id: randomUUID(), createdAt: new Date() };
        auditLogs.push(row);
        return row;
      },
    },
  };

  return {
    ...fake,
    // Interactive transactions: the callback receives the client. No rollback is modeled.
    $transaction: async <T>(fn: (tx: typeof fake) => Promise<T>): Promise<T> => fn(fake),
  };
}
