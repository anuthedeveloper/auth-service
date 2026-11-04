import { getPrisma } from '../db/prisma';
import { logger } from '../utils/logger';

export const AuditEvent = {
  USER_REGISTERED: 'USER_REGISTERED',
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILED: 'LOGIN_FAILED',
  TOKEN_REFRESHED: 'TOKEN_REFRESHED',
  REFRESH_REUSE_DETECTED: 'REFRESH_REUSE_DETECTED',
  LOGOUT: 'LOGOUT',
  LOGOUT_ALL: 'LOGOUT_ALL',
  ACCESS_DENIED: 'ACCESS_DENIED',
  ROLE_CHANGED: 'ROLE_CHANGED',
  EMAIL_VERIFIED: 'EMAIL_VERIFIED',
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  PASSWORD_RESET_COMPLETED: 'PASSWORD_RESET_COMPLETED',
  LOGIN_BLOCKED: 'LOGIN_BLOCKED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
} as const;

export type AuditEventName = (typeof AuditEvent)[keyof typeof AuditEvent];

export interface AuditEntry {
  event: AuditEventName;
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

/**
 * Records an auth event. Failures are logged but never thrown: losing an audit row
 * must not turn a valid login or registration into an error.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await getPrisma().auditLog.create({
      data: {
        event: entry.event,
        userId: entry.userId,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        metadata: entry.metadata,
      },
    });
  } catch (err) {
    logger.error({ err, event: entry.event }, 'Failed to write audit log');
  }
}
