import type Redis from 'ioredis';
import { env } from '../config/env';
import { getRedis } from '../db/redis';

export interface RateLimitHit {
  /** Requests counted in the current window, including this one. */
  count: number;
  /** Milliseconds until the window resets. */
  resetMs: number;
}

export interface RateLimitStore {
  /** Counts one request against `key`. The first hit in a window starts the window. */
  hit(key: string, windowMs: number): Promise<RateLimitHit>;
}

// ---- Redis ----------------------------------------------------------------------------

/**
 * INCR and PEXPIRE must be one atomic step. With two separate commands, a crash or a
 * timeout between them leaves a counter with no expiry, and that client is blocked forever.
 * The `ttl < 0` branch also repairs a key that somehow lost its expiry.
 */
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

interface EvalClient {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

/** Fixed-window counter in Redis. Shared by every app instance, so limits hold when scaled out. */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: EvalClient | Redis) {}

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const result = await (this.redis as EvalClient).eval(HIT_SCRIPT, 1, key, windowMs);
    if (!Array.isArray(result) || typeof result[0] !== 'number' || typeof result[1] !== 'number') {
      throw new Error('Unexpected reply from the rate limit script');
    }
    return { count: result[0], resetMs: result[1] };
  }
}

// ---- Memory ---------------------------------------------------------------------------

interface Entry {
  count: number;
  resetAt: number;
}

/**
 * Per-process counters, for tests and single-instance setups. With several instances each one
 * counts separately, so the effective limit is multiplied; use Redis in production.
 * The map is bounded, so an attacker rotating keys cannot grow it without limit.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const now = this.now();
    let entry = this.entries.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.entries.set(key, entry);
      this.makeRoom(now);
    }

    entry.count += 1;
    return { count: entry.count, resetMs: entry.resetAt - now };
  }

  clear(): void {
    this.entries.clear();
  }

  private makeRoom(now: number): void {
    if (this.entries.size <= this.maxKeys) {
      return;
    }
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) {
        this.entries.delete(key);
      }
    }
    // Still full of live windows: drop the oldest ones (Map keeps insertion order).
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxKeys) {
        break;
      }
      this.entries.delete(key);
    }
  }
}

// ---- Selection ------------------------------------------------------------------------

let store: RateLimitStore | undefined;

export function getRateLimitStore(): RateLimitStore {
  store ??=
    env.RATE_LIMIT_STORE === 'redis' ? new RedisRateLimitStore(getRedis()) : new MemoryRateLimitStore();
  return store;
}

/** Swap the store (tests); pass undefined to go back to the configured one. */
export function setRateLimitStore(next: RateLimitStore | undefined): void {
  store = next;
}
