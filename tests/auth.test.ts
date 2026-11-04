import request from 'supertest';
import { createApp } from '../src/app';
import { createFakePrisma } from './helpers/fakePrisma';

const mockPrisma = createFakePrisma();
jest.mock('../src/db/prisma', () => ({
  getPrisma: () => mockPrisma,
  disconnectPrisma: jest.fn(),
}));

const app = createApp();
const validUser = { email: 'ada@example.com', password: 'a-strong-passphrase' };

beforeEach(() => {
  mockPrisma.reset();
  jest.restoreAllMocks();
});

describe('POST /auth/register', () => {
  it('creates a user and returns a public profile without secrets', async () => {
    const res = await request(app).post('/auth/register').send(validUser);

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email: 'ada@example.com',
      role: 'USER',
      emailVerified: false,
    });
    expect(res.body.user.id).toEqual(expect.any(String));
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain(validUser.password);
  });

  it('stores an argon2id hash, not the password', async () => {
    await request(app).post('/auth/register').send(validUser);

    const stored = mockPrisma.users[0];
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(stored?.passwordHash).not.toContain(validUser.password);
  });

  it('normalizes the email (trim + lowercase)', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: '  Ada@Example.COM ', password: validUser.password });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('ada@example.com');
  });

  it('rejects a duplicate email with 409', async () => {
    await request(app).post('/auth/register').send(validUser);
    const res = await request(app).post('/auth/register').send(validUser);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns 409 when the unique index wins a race', async () => {
    await request(app).post('/auth/register').send(validUser);
    // Simulate the pre-check missing the existing row (concurrent request).
    jest.spyOn(mockPrisma.user, 'findUnique').mockResolvedValueOnce(null);

    const res = await request(app).post('/auth/register').send(validUser);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it.each([
    ['invalid email', { email: 'not-an-email', password: validUser.password }],
    ['short password', { email: validUser.email, password: 'short' }],
    ['overlong password', { email: validUser.email, password: 'x'.repeat(129) }],
    ['missing fields', {}],
  ])('rejects %s with 400', async (_name, body) => {
    const res = await request(app).post('/auth/register').send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockPrisma.users).toHaveLength(0);
  });

  it('writes a USER_REGISTERED audit event', async () => {
    const res = await request(app)
      .post('/auth/register')
      .set('User-Agent', 'jest-agent')
      .send(validUser);

    expect(mockPrisma.auditLogs).toHaveLength(1);
    expect(mockPrisma.auditLogs[0]).toMatchObject({
      event: 'USER_REGISTERED',
      userId: res.body.user.id,
      userAgent: 'jest-agent',
    });
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await request(app).post('/auth/register').send(validUser);
    mockPrisma.auditLogs.length = 0;
  });

  it('logs in with correct credentials', async () => {
    const res = await request(app).post('/auth/login').send(validUser);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(validUser.email);
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(mockPrisma.auditLogs[0]).toMatchObject({ event: 'LOGIN_SUCCESS' });
  });

  it('is case-insensitive on email', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'ADA@example.com', password: validUser.password });

    expect(res.status).toBe(200);
  });

  it('rejects a wrong password with a generic 401', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: validUser.email, password: 'definitely-wrong' });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid email or password');
    expect(mockPrisma.auditLogs[0]).toMatchObject({
      event: 'LOGIN_FAILED',
      metadata: { reason: 'bad_password' },
    });
  });

  it('returns the same 401 for an unknown email (no user enumeration)', async () => {
    const wrongPassword = await request(app)
      .post('/auth/login')
      .send({ email: validUser.email, password: 'definitely-wrong' });
    mockPrisma.auditLogs.length = 0;

    const unknownEmail = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'definitely-wrong' });

    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
    expect(mockPrisma.auditLogs[0]).toMatchObject({
      event: 'LOGIN_FAILED',
      metadata: { reason: 'unknown_email' },
    });
    expect(mockPrisma.auditLogs[0]?.userId).toBeUndefined();
  });

  it('rejects malformed login bodies with 400', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'bad' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('still succeeds if the audit log write fails', async () => {
    jest.spyOn(mockPrisma.auditLog, 'create').mockRejectedValueOnce(new Error('db down'));

    const res = await request(app).post('/auth/login').send(validUser);

    expect(res.status).toBe(200);
  });
});
