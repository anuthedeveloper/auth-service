import request from 'supertest';
import { createApp } from '../src/app';
import { env, parseEnv } from '../src/config/env';
import {
  MemoryRateLimitStore,
  setRateLimitStore,
  type RateLimitHit,
  type RateLimitStore,
} from '../src/services/rateLimitStore';
import { setEmailSender, type EmailMessage, type EmailSender } from '../src/services/email.service';
import { rateLimitIdentity } from '../src/utils/ip';
import { createFakePrisma } from './helpers/fakePrisma';

const mockPrisma = createFakePrisma();
jest.mock('../src/db/prisma', () => ({
  getPrisma: () => mockPrisma,
  disconnectPrisma: jest.fn(),
}));

class Outbox implements EmailSender {
  sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/** A memory store that also records every key it is asked to count. */
class CapturingStore extends MemoryRateLimitStore {
  keys: string[] = [];
  override async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    this.keys.push(key);
    return super.hit(key, windowMs);
  }
}

function buildApp(trustProxy = 0) {
  env.TRUST_PROXY = trustProxy; // read when the app is created
  return createApp();
}

const post = (app: ReturnType<typeof createApp>, path: string, body: object = {}, ip?: string) => {
  const req = request(app).post(path);
  if (ip) req.set('X-Forwarded-For', ip);
  return req.send(body);
};

beforeEach(() => {
  env.RATE_LIMIT_ENABLED = true;
  setRateLimitStore(new MemoryRateLimitStore());
  mockPrisma.reset();
  setEmailSender(new Outbox());
});

afterEach(() => {
  env.RATE_LIMIT_ENABLED = false;
  env.TRUST_PROXY = 0;
  setRateLimitStore(undefined);
  setEmailSender(undefined);
});

describe('per-IP limits', () => {
  it('answers the 21st login attempt from one IP with 429 and Retry-After', async () => {
    const app = buildApp();
    for (let i = 0; i < 20; i++) {
      expect((await post(app, '/auth/login')).status).toBe(400); // reaches validation
    }

    const res = await post(app, '/auth/login');

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(res.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(Number(res.headers['retry-after'])).toBe(res.body.error.details.retryAfterSeconds);
    expect(res.headers['ratelimit-limit']).toBe('20');
    expect(res.headers['ratelimit-remaining']).toBe('0');
  });

  it('reports how many requests are left', async () => {
    const res = await post(buildApp(), '/auth/login');

    expect(res.headers['ratelimit-limit']).toBe('20');
    expect(res.headers['ratelimit-remaining']).toBe('19');
    expect(Number(res.headers['ratelimit-reset'])).toBeGreaterThan(0);
  });

  it('limits registration to 10 per hour per IP', async () => {
    const app = buildApp();
    for (let i = 0; i < 10; i++) {
      expect((await post(app, '/auth/register')).status).toBe(400);
    }

    expect((await post(app, '/auth/register')).status).toBe(429);
  });

  it('counts each client separately when a proxy is trusted', async () => {
    const app = buildApp(1);
    for (let i = 0; i < 20; i++) {
      await post(app, '/auth/login', {}, '198.51.100.1');
    }

    expect((await post(app, '/auth/login', {}, '198.51.100.1')).status).toBe(429);
    expect((await post(app, '/auth/login', {}, '198.51.100.2')).status).toBe(400);
  });

  it('cannot be dodged by spoofing X-Forwarded-For when no proxy is trusted', async () => {
    const app = buildApp(0);
    for (let i = 0; i < 20; i++) {
      await post(app, '/auth/login', {}, `198.51.100.${i}`);
    }

    expect((await post(app, '/auth/login', {}, '198.51.100.250')).status).toBe(429);
  });

  it('applies a baseline to every route except the health check', async () => {
    const app = buildApp();
    for (let i = 0; i < 300; i++) {
      await request(app).get('/nowhere');
    }

    expect((await request(app).get('/nowhere')).status).toBe(429);
    expect((await request(app).get('/health')).status).toBe(200);
  });
});

describe('limits on the email endpoints', () => {
  const known = 'ada@example.com';
  const unknown = 'nobody@example.com';

  beforeEach(async () => {
    env.RATE_LIMIT_ENABLED = false;
    await request(createApp()).post('/auth/register').send({ email: known, password: 'a-strong-passphrase' });
    env.RATE_LIMIT_ENABLED = true;
  });

  it('allows 3 requests per address per hour, identically for known and unknown accounts', async () => {
    const app = buildApp();
    const statuses = async (email: string) => {
      const result: number[] = [];
      for (let i = 0; i < 4; i++) {
        result.push((await post(app, '/auth/forgot-password', { email })).status);
      }
      return result;
    };

    const forKnown = await statuses(known);
    const forUnknown = await statuses(unknown);

    expect(forKnown).toEqual([202, 202, 202, 429]);
    expect(forUnknown).toEqual(forKnown); // the limit gives nothing away
  });

  it('applies the same limit to resend-verification', async () => {
    const app = buildApp();
    const result: number[] = [];
    for (let i = 0; i < 4; i++) {
      result.push((await post(app, '/auth/resend-verification', { email: known })).status);
    }

    expect(result).toEqual([202, 202, 202, 429]);
  });

  it('treats email addresses case-insensitively', async () => {
    const app = buildApp();
    await post(app, '/auth/forgot-password', { email: 'Ada@Example.com' });
    await post(app, '/auth/forgot-password', { email: 'ADA@EXAMPLE.COM' });
    await post(app, '/auth/forgot-password', { email: known });

    expect((await post(app, '/auth/forgot-password', { email: known })).status).toBe(429);
  });

  it('limits one address even when requests come from many IPs', async () => {
    const app = buildApp(1);
    for (let i = 1; i <= 3; i++) {
      expect((await post(app, '/auth/forgot-password', { email: known }, `203.0.113.${i}`)).status).toBe(202);
    }

    expect((await post(app, '/auth/forgot-password', { email: known }, '203.0.113.99')).status).toBe(429);
  });

  it('limits one IP to 10 requests per hour across different addresses', async () => {
    const app = buildApp();
    for (let i = 0; i < 10; i++) {
      expect((await post(app, '/auth/forgot-password', { email: `user${i}@example.com` })).status).toBe(202);
    }

    expect((await post(app, '/auth/forgot-password', { email: 'user10@example.com' })).status).toBe(429);
  });

  it('reports the tightest limit that applies', async () => {
    const res = await post(buildApp(), '/auth/forgot-password', { email: known });

    expect(res.headers['ratelimit-limit']).toBe('3'); // per-address, not the per-IP 10
    expect(res.headers['ratelimit-remaining']).toBe('2');
  });

  it('keeps raw email addresses out of the rate limit keys', async () => {
    const store = new CapturingStore();
    setRateLimitStore(store);

    await post(buildApp(), '/auth/forgot-password', { email: known });

    expect(store.keys.some((k) => k.startsWith('rl:forgot-password-address:email:'))).toBe(true);
    expect(store.keys.some((k) => k.includes(known))).toBe(false);
  });
});

describe('failure handling', () => {
  it('fails open when the store is unavailable', async () => {
    const broken: RateLimitStore = {
      hit: async () => {
        throw new Error('redis is down');
      },
    };
    setRateLimitStore(broken);

    const res = await post(buildApp(), '/auth/login');

    expect(res.status).toBe(400); // reached validation instead of failing with 429 or 500
  });

  it('can be switched off', async () => {
    env.RATE_LIMIT_ENABLED = false;
    const app = buildApp();

    for (let i = 0; i < 25; i++) {
      expect((await post(app, '/auth/login')).status).toBe(400);
    }
  });
});

describe('MemoryRateLimitStore', () => {
  it('counts within a window and starts a new one after it ends', async () => {
    let now = 1_000;
    const store = new MemoryRateLimitStore(() => now);

    expect(await store.hit('k', 1_000)).toEqual({ count: 1, resetMs: 1_000 });
    now += 400;
    expect(await store.hit('k', 1_000)).toEqual({ count: 2, resetMs: 600 });
    now += 600;
    expect(await store.hit('k', 1_000)).toEqual({ count: 1, resetMs: 1_000 });
  });

  it('keeps keys independent', async () => {
    const store = new MemoryRateLimitStore();
    await store.hit('a', 1_000);
    await store.hit('a', 1_000);

    expect((await store.hit('b', 1_000)).count).toBe(1);
  });

  it('stays bounded, dropping expired windows first and then the oldest', async () => {
    let now = 0;
    const store = new MemoryRateLimitStore(() => now, 3);

    await store.hit('a', 100);
    await store.hit('b', 100);
    await store.hit('c', 100);
    now = 200; // a, b, c have expired
    await store.hit('d', 100);
    expect(store.size).toBe(1);

    for (const key of ['e', 'f', 'g', 'h']) {
      await store.hit(key, 100_000);
    }
    expect(store.size).toBeLessThanOrEqual(3);
  });
});

describe('rateLimitIdentity', () => {
  it('leaves IPv4 addresses alone and unwraps IPv4-mapped IPv6', () => {
    expect(rateLimitIdentity('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitIdentity('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('groups IPv6 clients by /64 so one client cannot rotate addresses', () => {
    const a = rateLimitIdentity('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    const b = rateLimitIdentity('2001:DB8:1:2::1');
    const other = rateLimitIdentity('2001:db8:1:3::1');

    expect(a).toBe('2001:db8:1:2::/64');
    expect(b).toBe(a);
    expect(other).toBe('2001:db8:1:3::/64');
  });

  it('ignores a source port, so new connections from one client share a counter', () => {
    expect(rateLimitIdentity('203.0.113.5:61234')).toBe('203.0.113.5');
    expect(rateLimitIdentity('203.0.113.5:61235')).toBe('203.0.113.5');
    expect(rateLimitIdentity('[2001:db8:1:2::9]:5000')).toBe('2001:db8:1:2::/64');
    expect(rateLimitIdentity('[2001:db8:1:2::9]')).toBe('2001:db8:1:2::/64');
    expect(rateLimitIdentity('[fe80::1%eth0]:443')).toBe('fe80:0:0:0::/64');
  });

  it('handles short forms, zone ids and missing addresses', () => {
    expect(rateLimitIdentity('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitIdentity('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(rateLimitIdentity(undefined)).toBe('unknown');
  });
});

describe('environment validation for abuse protection', () => {
  const base = { JWT_ACCESS_SECRET: 'x'.repeat(40) };

  it('applies safe defaults', () => {
    const parsed = parseEnv(base);

    expect(parsed).toMatchObject({
      RATE_LIMIT_ENABLED: true,
      RATE_LIMIT_STORE: 'redis',
      TRUST_PROXY: 0,
      MAX_FAILED_LOGINS: 5,
      LOCKOUT_MINUTES: 15,
    });
  });

  it('reads the switch literally ("false" must not stay enabled)', () => {
    expect(parseEnv({ ...base, RATE_LIMIT_ENABLED: 'false' }).RATE_LIMIT_ENABLED).toBe(false);
    expect(() => parseEnv({ ...base, RATE_LIMIT_ENABLED: 'yes' })).toThrow();
  });

  it.each([
    ['an unknown store', { RATE_LIMIT_STORE: 'file' }],
    ['a negative proxy count', { TRUST_PROXY: '-1' }],
    ['a zero failed-login limit', { MAX_FAILED_LOGINS: '0' }],
    ['a zero lockout time', { LOCKOUT_MINUTES: '0' }],
  ])('rejects %s', (_name, extra) => {
    expect(() => parseEnv({ ...base, ...extra })).toThrow();
  });
});
