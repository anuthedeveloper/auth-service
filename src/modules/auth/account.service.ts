import type { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { getPrisma } from '../../db/prisma';
import { AuditEvent, recordAudit } from '../../services/audit.service';
import { getEmailSender } from '../../services/email.service';
import {
  buildLink,
  passwordChangedEmail,
  passwordResetEmail,
  verificationEmail,
} from '../../services/email.templates';
import { runInBackground } from '../../utils/background';
import { generateOpaqueToken, hashToken } from '../../utils/crypto';
import { AppError } from '../../utils/errors';
import { hashPassword } from '../../utils/password';
import type { RequestContext } from '../../utils/requestContext';
import { toPublicUser, type PublicUser } from './user.dto';

type TokenType = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

/** One message for every failure: unknown, expired, used, or wrong-type tokens look the same. */
function invalidToken(): AppError {
  return new AppError(400, 'INVALID_TOKEN', 'Invalid or expired token');
}

/**
 * Creates a one-time token for the user and returns the raw value (only its SHA-256 hash is
 * stored). Older unused tokens of the same type are deleted, so only the newest email works.
 */
async function issueToken(userId: string, type: TokenType, ttlMs: number): Promise<string> {
  const { token, hash } = generateOpaqueToken();

  await getPrisma().$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.verificationToken.deleteMany({ where: { userId, type, usedAt: null } });
    await tx.verificationToken.create({
      data: { userId, type, tokenHash: hash, expiresAt: new Date(Date.now() + ttlMs) },
    });
  });

  return token;
}

async function findValidToken(rawToken: string, type: TokenType) {
  const stored = await getPrisma().verificationToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
  });
  if (!stored || stored.type !== type || stored.usedAt || stored.expiresAt.getTime() <= Date.now()) {
    throw invalidToken();
  }
  return stored;
}

// ---- email verification -------------------------------------------------------------

export async function sendVerificationEmail(user: { id: string; email: string }): Promise<void> {
  const ttlHours = env.EMAIL_VERIFICATION_TTL_HOURS;
  const token = await issueToken(user.id, 'EMAIL_VERIFICATION', ttlHours * 60 * 60 * 1000);
  await getEmailSender().send(
    verificationEmail(user.email, buildLink('/verify-email', token), ttlHours),
  );
}

export async function verifyEmail(rawToken: string, ctx: RequestContext): Promise<PublicUser> {
  const stored = await findValidToken(rawToken, 'EMAIL_VERIFICATION');
  const now = new Date();

  const user = await getPrisma().$transaction(async (tx: Prisma.TransactionClient) => {
    // Compare-and-set: of two concurrent requests with the same token, only one claims it.
    const claimed = await tx.verificationToken.updateMany({
      where: { id: stored.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) {
      return null;
    }
    const existing = await tx.user.findUnique({ where: { id: stored.userId } });
    if (!existing) {
      return null;
    }
    return existing.emailVerifiedAt
      ? existing
      : tx.user.update({ where: { id: existing.id }, data: { emailVerifiedAt: now } });
  });

  if (!user) {
    throw invalidToken();
  }

  await recordAudit({ event: AuditEvent.EMAIL_VERIFIED, userId: user.id, ...ctx });
  return toPublicUser(user);
}

/** Sends a fresh verification email. Silently does nothing for unknown or already verified accounts. */
export async function resendVerification(email: string): Promise<void> {
  const user = await getPrisma().user.findUnique({ where: { email } });
  if (!user || user.emailVerifiedAt) {
    return;
  }
  await sendVerificationEmail(user);
}

// ---- password reset -----------------------------------------------------------------

/** Sends a reset link if the account exists. Callers must respond identically either way. */
export async function requestPasswordReset(email: string, ctx: RequestContext): Promise<void> {
  const user = await getPrisma().user.findUnique({ where: { email } });
  if (!user) {
    return;
  }

  const ttlMinutes = env.PASSWORD_RESET_TTL_MINUTES;
  const token = await issueToken(user.id, 'PASSWORD_RESET', ttlMinutes * 60 * 1000);
  await getEmailSender().send(
    passwordResetEmail(user.email, buildLink('/reset-password', token), ttlMinutes),
  );
  await recordAudit({ event: AuditEvent.PASSWORD_RESET_REQUESTED, userId: user.id, ...ctx });
}

/**
 * Sets a new password using a reset token. The token is consumed atomically, all sessions
 * are revoked (whoever had access before is signed out), and lockout counters are cleared.
 * Having received the email also proves control of the mailbox, so the address is verified.
 */
export async function resetPassword(
  rawToken: string,
  newPassword: string,
  ctx: RequestContext,
): Promise<void> {
  const stored = await findValidToken(rawToken, 'PASSWORD_RESET');
  const passwordHash = await hashPassword(newPassword); // slow, so done before the transaction
  const now = new Date();

  const user = await getPrisma().$transaction(async (tx: Prisma.TransactionClient) => {
    const claimed = await tx.verificationToken.updateMany({
      where: { id: stored.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) {
      return null;
    }
    const existing = await tx.user.findUnique({ where: { id: stored.userId } });
    if (!existing) {
      return null;
    }
    const updated = await tx.user.update({
      where: { id: existing.id },
      data: {
        passwordHash,
        failedLoginAttempts: 0,
        lockedUntil: null,
        emailVerifiedAt: existing.emailVerifiedAt ?? now,
      },
    });
    await tx.refreshToken.updateMany({
      where: { userId: existing.id, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.verificationToken.deleteMany({
      where: { userId: existing.id, type: 'PASSWORD_RESET', usedAt: null },
    });
    return updated;
  });

  if (!user) {
    throw invalidToken();
  }

  await recordAudit({ event: AuditEvent.PASSWORD_RESET_COMPLETED, userId: user.id, ...ctx });
  runInBackground('password-changed-email', () =>
    getEmailSender().send(passwordChangedEmail(user.email)),
  );
}
