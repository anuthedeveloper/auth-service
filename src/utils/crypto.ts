import { createHash, randomBytes } from 'crypto';

/** SHA-256 hex digest. Used to store opaque tokens so a DB leak does not leak usable tokens. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 256 bits of randomness, URL-safe. High entropy means a fast hash is sufficient (no need for argon2). */
export function generateOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}
