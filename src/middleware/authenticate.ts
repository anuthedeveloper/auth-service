import type { RequestHandler } from 'express';
import { verifyAccessToken, type AccessTokenClaims } from '../modules/auth/token.service';
import { AppError } from '../utils/errors';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `authenticate` after the access token is verified. */
      auth?: AccessTokenClaims;
    }
  }
}

/** Requires `Authorization: Bearer <access token>`. Stateless: no database lookup. */
export const authenticate: RequestHandler = (req, _res, next) => {
  const [scheme, token, ...extra] = (req.get('authorization') ?? '').split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token || extra.length > 0) {
    next(AppError.unauthorized('Missing or malformed Authorization header'));
    return;
  }

  try {
    req.auth = verifyAccessToken(token);
    next();
  } catch (err) {
    next(err);
  }
};
