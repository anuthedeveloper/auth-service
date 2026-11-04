import type { Prisma } from '@prisma/client';
import { getPrisma } from '../../db/prisma';
import { AuditEvent, recordAudit } from '../../services/audit.service';
import { AppError } from '../../utils/errors';
import type { RequestContext } from '../../utils/requestContext';
import { toPublicUser, type PublicUser } from '../auth/auth.service';
import type { Role } from '../auth/token.service';
import type { ListUsersQuery } from './admin.schemas';

export interface UserPage {
  users: PublicUser[];
  page: number;
  limit: number;
  total: number;
}

export async function listUsers({ page, limit }: ListUsersQuery): Promise<UserPage> {
  const prisma = getPrisma();

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.user.count(),
  ]);

  return { users: rows.map(toPublicUser), page, limit, total };
}

/**
 * Changes a user's role. Rules:
 * - Admins cannot change their own role, so the last admin can't lock everyone out.
 * - The target's sessions are revoked, so their next token reflects the new role
 *   (and a demoted admin loses access at the next refresh, not in 7 days).
 */
export async function changeRole(
  actorId: string,
  targetId: string,
  role: Role,
  ctx: RequestContext,
): Promise<PublicUser> {
  if (actorId === targetId) {
    throw AppError.forbidden('You cannot change your own role');
  }

  const prisma = getPrisma();
  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) {
    throw AppError.notFound('User not found');
  }

  if (target.role === role) {
    return toPublicUser(target);
  }

  const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const user = await tx.user.update({ where: { id: targetId }, data: { role } });
    await tx.refreshToken.updateMany({
      where: { userId: targetId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return user;
  });

  await recordAudit({
    event: AuditEvent.ROLE_CHANGED,
    userId: actorId,
    metadata: { targetUserId: targetId, from: target.role, to: role },
    ...ctx,
  });

  return toPublicUser(updated);
}
