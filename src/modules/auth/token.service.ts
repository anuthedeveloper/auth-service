import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';

export type Role = 'USER' | 'ADMIN';

export interface AccessTokenClaims {
  userId: string;
  role: Role;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** Access token lifetime in seconds. */
  expiresIn: number;
}

function isRole(value: unknown): value is Role {
  return value === 'USER' || value === 'ADMIN';
}

export function signAccessToken(user: { id: string; role: string }): string {
  return jwt.sign({ role: user.role }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    issuer: env.JWT_ISSUER,
    subject: user.id,
  });
}

/** Pinning `algorithms` blocks alg-confusion and `alg: none` attacks. */
export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
    });
    if (typeof payload === 'string' || typeof payload.sub !== 'string' || !isRole(payload.role)) {
      throw new Error('Unexpected token claims');
    }
    return { userId: payload.sub, role: payload.role };
  } catch {
    throw AppError.unauthorized('Invalid or expired access token');
  }
}

export function buildTokenPair(user: { id: string; role: string }, refreshToken: string): TokenPair {
  return {
    accessToken: signAccessToken(user),
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  };
}

export function refreshTokenExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}
