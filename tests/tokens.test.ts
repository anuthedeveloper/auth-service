import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../src/app';
import { hashToken } from '../src/utils/crypto';
import { createFakePrisma } from './helpers/fakePrisma';

const mockPrisma = createFakePrisma();
jest.mock('../src/db/prisma', () => ({
  getPrisma: () => mockPrisma,
  disconnectPrisma: jest.fn(),
}));

const app = createApp();
const SECRET = process.env.JWT_ACCESS_SECRET as string;
const creds = { email: 'ada@example.com', password: 'a-strong-passphrase' };

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function login() {
  const res = await request(app).post('/auth/login').send(creds);
  expect(res.status).toBe(200);
  return res.body as {
    user: { id: string; role: string };
    accessToken: string;
    refreshToken: string;
    tokenType: string;
    expiresIn: number;
  };
}

const refresh = (refreshToken: string) => request(app).post('/auth/refresh').send({ refreshToken });
const events = () => mockPrisma.auditLogs.map((a) => a.event);

beforeEach(async () => {
  mockPrisma.reset();
  jest.restoreAllMocks();
  await request(app).post('/auth/register').send(creds);
});

describe('POST /auth/login (tokens)', () => {
  it('returns an access token, a refresh token and no-store caching', async () => {
    const res = await request(app).post('/auth/login').send(creds);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
  });

  it('issues a JWT with sub, role, issuer and expiry', async () => {
    const body = await login();
    const claims = jwt.verify(body.accessToken, SECRET) as jwt.JwtPayload;

    expect(claims.sub).toBe(body.user.id);
    expect(claims.role).toBe('USER');
    expect(claims.iss).toBe('auth-service');
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(900);
    expect(claims).not.toHaveProperty('email');
  });

  it('stores only a hash of the refresh token', async () => {
    const body = await login();
    const stored = mockPrisma.refreshTokens[0];

    expect(stored?.tokenHash).toBe(hashToken(body.refreshToken));
    expect(JSON.stringify(mockPrisma.refreshTokens)).not.toContain(body.refreshToken);
  });

  it('starts a new session family per login', async () => {
    await login();
    await login();

    const [a, b] = mockPrisma.refreshTokens;
    expect(a?.familyId).toBeDefined();
    expect(a?.familyId).not.toBe(b?.familyId);
  });
});

describe('GET /auth/me (access token verification)', () => {
  it('returns the current user for a valid token', async () => {
    const { accessToken } = await login();
    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(creds.email);
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('rejects a missing header, with a WWW-Authenticate challenge', async () => {
    const res = await request(app).get('/auth/me');

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it.each([
    ['wrong scheme', 'Basic abc'],
    ['no token', 'Bearer'],
    ['garbage token', 'Bearer not.a.jwt'],
    ['extra segments', 'Bearer a b'],
  ])('rejects %s', async (_name, header) => {
    const res = await request(app).get('/auth/me').set('Authorization', header);

    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const { user } = await login();
    const expired = jwt.sign({ role: 'USER' }, SECRET, {
      algorithm: 'HS256',
      subject: user.id,
      issuer: 'auth-service',
      expiresIn: -10,
    });

    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with a different secret', async () => {
    const { user } = await login();
    const forged = jwt.sign({ role: 'ADMIN' }, 'x'.repeat(40), {
      subject: user.id,
      issuer: 'auth-service',
      expiresIn: 60,
    });

    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('rejects a token from another issuer', async () => {
    const { user } = await login();
    const other = jwt.sign({ role: 'USER' }, SECRET, {
      subject: user.id,
      issuer: 'someone-else',
      expiresIn: 60,
    });

    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${other}`);
    expect(res.status).toBe(401);
  });

  it('rejects an unsigned (alg: none) token', async () => {
    const { user } = await login();
    const unsigned = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
      sub: user.id,
      role: 'ADMIN',
      iss: 'auth-service',
      exp: Math.floor(Date.now() / 1000) + 600,
    })}.`;

    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${unsigned}`);
    expect(res.status).toBe(401);
  });

  it('rejects a validly signed token carrying an unknown role', async () => {
    const { user } = await login();
    const odd = jwt.sign({ role: 'SUPERUSER' }, SECRET, {
      subject: user.id,
      issuer: 'auth-service',
      expiresIn: 60,
    });

    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${odd}`);
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/refresh (rotation)', () => {
  it('issues a new pair and revokes the old refresh token', async () => {
    const first = await login();
    const res = await refresh(first.refreshToken);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.refreshToken).not.toBe(first.refreshToken);
    expect(res.body.accessToken).toEqual(expect.any(String));

    const [oldRow, newRow] = mockPrisma.refreshTokens;
    expect(oldRow?.revokedAt).toBeInstanceOf(Date);
    expect(oldRow?.replacedById).toBe(newRow?.id);
    expect(newRow?.revokedAt).toBeNull();
    expect(newRow?.familyId).toBe(oldRow?.familyId);
    expect(newRow?.expiresAt).toEqual(oldRow?.expiresAt);
  });

  it('lets the rotated token be used again, and so on', async () => {
    const first = await login();
    const second = await refresh(first.refreshToken);
    const third = await refresh(second.body.refreshToken);

    expect(third.status).toBe(200);
    expect(mockPrisma.refreshTokens).toHaveLength(3);
    expect(events()).toContain('TOKEN_REFRESHED');
  });

  it('rejects an unknown token', async () => {
    const res = await refresh('totally-made-up');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('rejects an expired token', async () => {
    const first = await login();
    const row = mockPrisma.refreshTokens[0];
    if (row) row.expiresAt = new Date(Date.now() - 1000);

    const res = await refresh(first.refreshToken);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('rejects a malformed body with 400', async () => {
    const res = await request(app).post('/auth/refresh').send({});

    expect(res.status).toBe(400);
  });
});

describe('refresh token reuse detection', () => {
  it('revokes the whole family when a rotated token is replayed', async () => {
    const first = await login();
    const second = await refresh(first.refreshToken);

    const replay = await refresh(first.refreshToken);
    expect(replay.status).toBe(401);

    // The legitimate newest token is now dead too.
    const afterwards = await refresh(second.body.refreshToken);
    expect(afterwards.status).toBe(401);
    expect(mockPrisma.refreshTokens.every((t) => t.revokedAt !== null)).toBe(true);
    expect(events()).toContain('REFRESH_REUSE_DETECTED');
  });

  it('does not touch other sessions of the same user', async () => {
    const laptop = await login();
    const phone = await login();
    const rotated = await refresh(laptop.refreshToken);
    await refresh(laptop.refreshToken); // replay

    expect(rotated.status).toBe(200);
    expect((await refresh(phone.refreshToken)).status).toBe(200);
  });

  it('lets only one of two concurrent refreshes with the same token succeed', async () => {
    const first = await login();

    const [a, b] = await Promise.all([refresh(first.refreshToken), refresh(first.refreshToken)]);

    expect([a.status, b.status].sort()).toEqual([200, 401]);
    expect(events()).toContain('REFRESH_REUSE_DETECTED');
  });
});

describe('POST /auth/logout', () => {
  it('revokes the session so its tokens stop working', async () => {
    const first = await login();
    const rotated = await refresh(first.refreshToken);

    const res = await request(app).post('/auth/logout').send({ refreshToken: rotated.body.refreshToken });

    expect(res.status).toBe(204);
    expect((await refresh(rotated.body.refreshToken)).status).toBe(401);
    expect(events()).toContain('LOGOUT');
  });

  it('does not raise a reuse alarm when a logged-out token is presented', async () => {
    const first = await login();
    await request(app).post('/auth/logout').send({ refreshToken: first.refreshToken });
    mockPrisma.auditLogs.length = 0;

    const res = await refresh(first.refreshToken);

    expect(res.status).toBe(401);
    expect(events()).not.toContain('REFRESH_REUSE_DETECTED');
  });

  it('is idempotent and reveals nothing for unknown tokens', async () => {
    const res = await request(app).post('/auth/logout').send({ refreshToken: 'unknown-token' });

    expect(res.status).toBe(204);
  });

  it('only ends the current session, not other devices', async () => {
    const laptop = await login();
    const phone = await login();

    await request(app).post('/auth/logout').send({ refreshToken: laptop.refreshToken });

    expect((await refresh(laptop.refreshToken)).status).toBe(401);
    expect((await refresh(phone.refreshToken)).status).toBe(200);
  });
});

describe('POST /auth/logout-all', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/auth/logout-all');

    expect(res.status).toBe(401);
  });

  it('revokes every session for the user', async () => {
    const laptop = await login();
    const phone = await login();

    const res = await request(app)
      .post('/auth/logout-all')
      .set('Authorization', `Bearer ${laptop.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.sessionsRevoked).toBe(2);
    expect((await refresh(laptop.refreshToken)).status).toBe(401);
    expect((await refresh(phone.refreshToken)).status).toBe(401);
    expect(events()).toContain('LOGOUT_ALL');
  });
});
