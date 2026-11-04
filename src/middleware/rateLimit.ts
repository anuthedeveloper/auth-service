import type { Request, RequestHandler, Response } from 'express';
import { env } from '../config/env';
import { getRateLimitStore } from '../services/rateLimitStore';
import { hashToken } from '../utils/crypto';
import { AppError } from '../utils/errors';
import { rateLimitIdentity } from '../utils/ip';
import { logger } from '../utils/logger';

export interface RateLimitOptions {
  /** Part of the Redis key, so each limiter has its own counters. */
  name: string;
  windowMs: number;
  /** Requests allowed per window; the next one gets a 429. */
  max: number;
  /** What to count against. Defaults to the client IP. Return undefined to skip the limiter. */
  key?: (req: Request) => string | undefined;
  skip?: (req: Request) => boolean;
}

export const ipKey = (req: Request): string => `ip:${rateLimitIdentity(req.ip)}`;

/**
 * Counts per email address (whether or not an account exists, so the limit itself reveals nothing).
 * The address is hashed so Redis keys don't hold personal data. Run it after `validate`, which
 * trims and lowercases the email so that "A@x.com" and "a@x.com" share one counter.
 */
export const emailKey = (req: Request): string | undefined => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? `email:${hashToken(email)}` : undefined;
};

let lastStoreWarning = 0;

function warnStoreFailure(err: unknown, limiter: string): void {
  const now = Date.now();
  if (now - lastStoreWarning > 30_000) {
    lastStoreWarning = now;
    logger.warn({ err: err instanceof Error ? err.message : err, limiter }, 'Rate limit store unavailable, allowing requests');
  }
}

interface HeaderInfo {
  limit: number;
  remaining: number;
  reset: number;
}

/** Several limiters can apply to one request; report the one with the least room left. */
function setHeaders(res: Response, info: HeaderInfo): void {
  const current = res.locals.rateLimit as HeaderInfo | undefined;
  if (current && current.remaining <= info.remaining) {
    return;
  }
  res.locals.rateLimit = info;
  res.set({
    'RateLimit-Limit': String(info.limit),
    'RateLimit-Remaining': String(info.remaining),
    'RateLimit-Reset': String(info.reset),
  });
}

/**
 * Fixed-window rate limiter. If the store is unreachable it fails open: a Redis outage must not
 * take sign-in down. Brute-force protection survives that, because account lockout lives in
 * the database.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const getKey = options.key ?? ipKey;

  return async (req, res, next) => {
    if (!env.RATE_LIMIT_ENABLED || options.skip?.(req)) {
      next();
      return;
    }

    const identity = getKey(req);
    if (!identity) {
      next();
      return;
    }

    let hit;
    try {
      hit = await getRateLimitStore().hit(`rl:${options.name}:${identity}`, options.windowMs);
    } catch (err) {
      warnStoreFailure(err, options.name);
      next();
      return;
    }

    const resetSeconds = Math.max(1, Math.ceil(hit.resetMs / 1000));
    setHeaders(res, {
      limit: options.max,
      remaining: Math.max(0, options.max - hit.count),
      reset: resetSeconds,
    });

    if (hit.count > options.max) {
      res.set('Retry-After', String(resetSeconds));
      logger.warn({ limiter: options.name, ip: req.ip }, 'Rate limit exceeded');
      next(
        new AppError(429, 'TOO_MANY_REQUESTS', 'Too many requests, please try again later', {
          retryAfterSeconds: resetSeconds,
        }),
      );
      return;
    }

    next();
  };
}
