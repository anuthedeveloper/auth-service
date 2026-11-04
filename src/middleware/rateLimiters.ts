import { emailKey, rateLimit } from './rateLimit';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const perIp = (name: string, windowMs: number, max: number) => rateLimit({ name, windowMs, max });

/** Limits requests for one email address, on top of the per-IP limit. */
const perEmail = (name: string, windowMs: number, max: number) =>
  rateLimit({ name: `${name}-address`, windowMs, max, key: emailKey });

// Baseline for every route except the health check, which load balancers poll constantly.
export const globalLimiter = rateLimit({
  name: 'global',
  windowMs: 15 * MINUTE,
  max: 300,
  skip: (req) => req.path === '/health',
});

export const registerLimiter = perIp('register', HOUR, 10);

// Per IP only. Guessing one account's password is stopped by account lockout instead.
export const loginLimiter = perIp('login', 15 * MINUTE, 20);

export const refreshLimiter = perIp('refresh', 15 * MINUTE, 100);

export const verifyEmailLimiter = perIp('verify-email', 15 * MINUTE, 10);
export const resetPasswordLimiter = perIp('reset-password', 15 * MINUTE, 10);

// These two send email, so they also get a per-address limit to stop someone flooding an inbox.
export const forgotPasswordLimiter = perIp('forgot-password', HOUR, 10);
export const forgotPasswordAddressLimiter = perEmail('forgot-password', HOUR, 3);
export const resendVerificationLimiter = perIp('resend-verification', HOUR, 10);
export const resendVerificationAddressLimiter = perEmail('resend-verification', HOUR, 3);
