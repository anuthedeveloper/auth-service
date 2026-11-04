import type { RequestHandler } from 'express';
import type { Role } from '../modules/auth/token.service';
import { AuditEvent, recordAudit } from '../services/audit.service';
import { AppError } from '../utils/errors';
import { getRequestContext } from '../utils/requestContext';

/**
 * Allows the request only if the authenticated user has one of the given roles.
 * Must run after `authenticate`. The role comes from the signed access token, so no
 * database lookup is needed (role changes apply once the user's token is refreshed).
 *
 * Denials are audited: repeated 403s from one user are worth noticing.
 */
export function requireRole(...allowed: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      next(AppError.unauthorized());
      return;
    }

    if (allowed.includes(req.auth.role)) {
      next();
      return;
    }

    void recordAudit({
      event: AuditEvent.ACCESS_DENIED,
      userId: req.auth.userId,
      metadata: { method: req.method, path: req.originalUrl.split('?')[0] ?? '', role: req.auth.role },
      ...getRequestContext(req),
    }).then(() => next(AppError.forbidden('Insufficient permissions')));
  };
}
