import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { getPrisma } from '../../db/prisma';
import { AuditEvent, recordAudit } from '../../services/audit.service';
import { getEmailSender } from '../../services/email.service';
import { accountLockedEmail } from '../../services/email.templates';
import { runInBackground } from '../../utils/background';
import { generateOpaqueToken, hashToken } from '../../utils/crypto';
import { AppError } from '../../utils/errors';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../../utils/password';
import type { RequestContext } from '../../utils/requestContext';
import { sendVerificationEmail } from './account.service';
import type { LoginInput, RegisterInput } from './auth.schemas';
import { buildTokenPair, refreshTokenExpiry, type TokenPair } from './token.service';
import { toPublicUser, type PublicUser } from './user.dto';

export { toPublicUser };
export type { PublicUser, RequestContext };

export interface AuthResult {
  user: PublicUser;
  tokens: TokenPair;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

const INVALID_CREDENTIALS = 'Invalid email or password';

function invalidRefreshToken(): AppError {
  return new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token');
}

export async function register(input: RegisterInput, ctx: RequestContext): Promise<PublicUser> {
  const prisma = getPrisma();

  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw AppError.conflict('An account with this email already exists');
  }

  const passwordHash = await hashPassword(input.password);

  let user;
  try {
    user = await prisma.user.create({ data: { email: input.email, passwordHash } });
  } catch (err) {
    // Two requests can pass the check above at once; the unique index is the real guard.
    if (isUniqueViolation(err)) {
      throw AppError.conflict('An account with this email already exists');
    }
    throw err;
  }

  await recordAudit({ event: AuditEvent.USER_REGISTERED, userId: user.id, ...ctx });

  // An SMTP outage must not make registration fail; the user can ask for a new email.
  runInBackground('verification-email', () => sendVerificationEmail(user));

  return toPublicUser(user);
}

/**
 * Counts a wrong password and locks the account once MAX_FAILED_LOGINS is reached.
 *
 * - The increment is a single atomic SQL update, so parallel guesses each get a distinct count
 *   and none can slip past the limit.
 * - The lock is a compare-and-set, so when several requests cross the limit together only one
 *   locks the account, writes the audit event and sends the email.
 */
async function registerFailedLogin(
  user: { id: string; email: string },
  ctx: RequestContext,
): Promise<void> {
  const prisma = getPrisma();

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: { increment: 1 } },
    select: { failedLoginAttempts: true },
  });
  if (updated.failedLoginAttempts < env.MAX_FAILED_LOGINS) {
    return;
  }

  const now = new Date();
  const claimed = await prisma.user.updateMany({
    where: { id: user.id, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
    data: {
      lockedUntil: new Date(now.getTime() + env.LOCKOUT_MINUTES * 60_000),
      failedLoginAttempts: 0,
    },
  });
  if (claimed.count !== 1) {
    return;
  }

  await recordAudit({
    event: AuditEvent.ACCOUNT_LOCKED,
    userId: user.id,
    metadata: { lockoutMinutes: env.LOCKOUT_MINUTES },
    ...ctx,
  });
  runInBackground('account-locked-email', () =>
    getEmailSender().send(accountLockedEmail(user.email, env.LOCKOUT_MINUTES)),
  );
}

export async function login(input: LoginInput, ctx: RequestContext): Promise<AuthResult> {
  const prisma = getPrisma();

  let user = await prisma.user.findUnique({ where: { email: input.email } });

  if (!user) {
    await verifyAgainstDummy(input.password);
    await recordAudit({
      event: AuditEvent.LOGIN_FAILED,
      metadata: { reason: 'unknown_email' },
      ...ctx,
    });
    throw AppError.unauthorized(INVALID_CREDENTIALS);
  }

  // While locked, even the correct password is refused; otherwise guessing could carry on during
  // the lock. The reply is the same generic 401 and takes about as long as a real check, so a
  // lock doesn't reveal that the account exists. The owner is told by email.
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await verifyAgainstDummy(input.password);
    await recordAudit({
      event: AuditEvent.LOGIN_BLOCKED,
      userId: user.id,
      metadata: { reason: 'account_locked' },
      ...ctx,
    });
    throw AppError.unauthorized(INVALID_CREDENTIALS);
  }

  if (user.lockedUntil) {
    // The lock has expired: start counting from zero again. Compare-and-set on the old value.
    await prisma.user.updateMany({
      where: { id: user.id, lockedUntil: user.lockedUntil },
      data: { lockedUntil: null, failedLoginAttempts: 0 },
    });
    user = { ...user, lockedUntil: null, failedLoginAttempts: 0 };
  }

  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!valid) {
    await recordAudit({
      event: AuditEvent.LOGIN_FAILED,
      userId: user.id,
      metadata: { reason: 'bad_password' },
      ...ctx,
    });
    await registerFailedLogin(user, ctx);
    throw AppError.unauthorized(INVALID_CREDENTIALS);
  }

  if (user.failedLoginAttempts > 0) {
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0 } });
  }

  // Only reachable with the correct password, so this does not reveal which emails exist.
  if (env.REQUIRE_EMAIL_VERIFICATION && !user.emailVerifiedAt) {
    await recordAudit({
      event: AuditEvent.LOGIN_FAILED,
      userId: user.id,
      metadata: { reason: 'email_not_verified' },
      ...ctx,
    });
    throw new AppError(
      403,
      'EMAIL_NOT_VERIFIED',
      'Please verify your email address before signing in',
    );
  }

  // A login starts a new session: a new "family" of refresh tokens.
  const refresh = generateOpaqueToken();
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      familyId: randomUUID(),
      tokenHash: refresh.hash,
      expiresAt: refreshTokenExpiry(),
      userAgent: ctx.userAgent,
      ipAddress: ctx.ipAddress,
    },
  });

  await recordAudit({ event: AuditEvent.LOGIN_SUCCESS, userId: user.id, ...ctx });
  return { user: toPublicUser(user), tokens: buildTokenPair(user, refresh.token) };
}

/**
 * Exchanges a refresh token for a new access + refresh token pair (rotation).
 *
 * - A rotated token is revoked and points at its replacement (`replacedById`).
 * - Presenting an already-rotated token means it was copied or stolen, so the whole
 *   family (the session) is revoked and the real user has to log in again.
 * - The rotated session keeps its original expiry, so sessions have an absolute lifetime.
 */
export async function refresh(rawToken: string, ctx: RequestContext): Promise<AuthResult> {
  const prisma = getPrisma();

  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!stored) {
    throw invalidRefreshToken();
  }

  if (stored.revokedAt) {
    // Revoked by rotation => replay of an old token. Revoked by logout => just reject.
    if (stored.replacedById) {
      await revokeFamilyForReuse(stored, ctx);
    }
    throw invalidRefreshToken();
  }

  if (stored.expiresAt.getTime() <= Date.now()) {
    throw invalidRefreshToken();
  }

  const user = await prisma.user.findUnique({ where: { id: stored.userId } });
  if (!user) {
    throw invalidRefreshToken();
  }

  const next = generateOpaqueToken();
  const nextId = randomUUID();

  const rotated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Compare-and-set: only one concurrent request can flip revokedAt from null.
    const claimed = await tx.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedById: nextId },
    });
    if (claimed.count !== 1) {
      return false;
    }
    await tx.refreshToken.create({
      data: {
        id: nextId,
        userId: stored.userId,
        familyId: stored.familyId,
        tokenHash: next.hash,
        expiresAt: stored.expiresAt,
        userAgent: ctx.userAgent,
        ipAddress: ctx.ipAddress,
      },
    });
    return true;
  });

  if (!rotated) {
    // Lost a race with another request using the same token: treat as reuse.
    await revokeFamilyForReuse(stored, ctx);
    throw invalidRefreshToken();
  }

  await recordAudit({ event: AuditEvent.TOKEN_REFRESHED, userId: user.id, ...ctx });
  return { user: toPublicUser(user), tokens: buildTokenPair(user, next.token) };
}

async function revokeFamilyForReuse(
  token: { userId: string; familyId: string },
  ctx: RequestContext,
): Promise<void> {
  await getPrisma().refreshToken.updateMany({
    where: { familyId: token.familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await recordAudit({
    event: AuditEvent.REFRESH_REUSE_DETECTED,
    userId: token.userId,
    metadata: { familyId: token.familyId },
    ...ctx,
  });
}

/** Ends the session that owns this refresh token. Idempotent: unknown tokens are ignored. */
export async function logout(rawToken: string, ctx: RequestContext): Promise<void> {
  const prisma = getPrisma();

  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!stored) {
    return;
  }

  await prisma.refreshToken.updateMany({
    where: { familyId: stored.familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await recordAudit({ event: AuditEvent.LOGOUT, userId: stored.userId, ...ctx });
}

/** Ends every session for a user (all devices). */
export async function logoutAll(userId: string, ctx: RequestContext): Promise<number> {
  const result = await getPrisma().refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await recordAudit({
    event: AuditEvent.LOGOUT_ALL,
    userId,
    metadata: { sessionsRevoked: result.count },
    ...ctx,
  });
  return result.count;
}

export async function getUserById(userId: string): Promise<PublicUser> {
  const user = await getPrisma().user.findUnique({ where: { id: userId } });
  if (!user) {
    throw AppError.unauthorized('Account no longer exists');
  }
  return toPublicUser(user);
}
