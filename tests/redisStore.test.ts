import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import request from 'supertest';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { createRedisClient } from '../src/db/redis';
import {
  RedisRateLimitStore,
  setRateLimitStore,
  type RateLimitHit,
  type RateLimitStore,
} from '../src/services/rateLimitStore';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The Lua script can only be tested against a real Redis. Set REDIS_TEST_URL to run these
// (CI provides a Redis service container). Without it they are skipped, not faked.
const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
const withRedis = REDIS_TEST_URL ? describe : describe.skip;

withRedis('RedisRateLimitStore against a real Redis', () => {
  let redis: Redis;
  let store: RedisRateLimitStore;
  const newKey = () => `test:${randomUUID()}`;

  beforeAll(() => {
    redis = new Redis(REDIS_TEST_URL as string);
    store = new RedisRateLimitStore(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('counts hits and starts the window on the first one', async () => {
    const key = newKey();

    const first = await store.hit(key, 5_000);
    const second = await store.hit(key, 5_000);

    expect(first.count).toBe(1);
    expect(first.resetMs).toBeGreaterThan(4_000);
    expect(first.resetMs).toBeLessThanOrEqual(5_000);
    expect(second.count).toBe(2);
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5_000);
  });

  it('does not extend the window on later hits', async () => {
    const key = newKey();

    const first = await store.hit(key, 1_000);
    await sleep(200);
    const second = await store.hit(key, 1_000);

    expect(second.resetMs).toBeLessThan(first.resetMs);
  });

  it('starts a fresh window after the old one expires', async () => {
    const key = newKey();
    await store.hit(key, 100);
    await sleep(160);

    expect((await store.hit(key, 100)).count).toBe(1);
  });

  it('counts exactly under concurrency', async () => {
    const key = newKey();

    const hits = await Promise.all(Array.from({ length: 50 }, () => store.hit(key, 5_000)));

    expect(hits.map((h) => h.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
  });

  it('repairs a counter that lost its expiry', async () => {
    const key = newKey();
    await redis.set(key, '5'); // no TTL: would block this client forever without the repair

    const hit = await store.hit(key, 1_000);

    expect(hit.count).toBe(6);
    expect(await redis.pttl(key)).toBeGreaterThan(0);
  });

  it('enforces the HTTP limits end to end', async () => {
    const runId = randomUUID(); // isolates this run's counters from earlier runs
    const prefixed: RateLimitStore = {
      hit: (key: string, windowMs: number): Promise<RateLimitHit> => store.hit(`${runId}:${key}`, windowMs),
    };
    env.RATE_LIMIT_ENABLED = true;
    setRateLimitStore(prefixed);
    try {
      const app = createApp();
      for (let i = 0; i < 20; i++) {
        expect((await request(app).post('/auth/login').send({})).status).toBe(400);
      }

      const res = await request(app).post('/auth/login').send({});
      expect(res.status).toBe(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      env.RATE_LIMIT_ENABLED = false;
      setRateLimitStore(undefined);
    }
  });
});

describe('Redis outage', () => {
  it('fails fast, and the limiter lets requests through', async () => {
    const dead = createRedisClient('redis://127.0.0.1:1'); // nothing listens there
    try {
      const store = new RedisRateLimitStore(dead);

      const started = Date.now();
      await expect(store.hit('rl:test', 1_000)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1_000); // no queueing behind a dead connection

      env.RATE_LIMIT_ENABLED = true;
      setRateLimitStore(store);
      const res = await request(createApp()).post('/auth/login').send({});
      expect(res.status).toBe(400); // reached validation: the limiter failed open
    } finally {
      dead.disconnect();
      env.RATE_LIMIT_ENABLED = false;
      setRateLimitStore(undefined);
    }
  });
});
