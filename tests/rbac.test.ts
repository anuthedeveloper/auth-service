import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../src/app';
import { createFakePrisma } from './helpers/fakePrisma';

const mockPrisma = createFakePrisma();
jest.mock('../src/db/prisma', () => ({
  getPrisma: () => mockPrisma,
  disconnectPrisma: jest.fn(),
}));

const app = createApp();
const password = 'a-strong-passphrase';

interface Session {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

/** Registers a user, optionally forces a role directly in the store, then logs in. */
async function createUser(email: string, role: 'USER' | 'ADMIN' = 'USER'): Promise<Session> {
  await request(app).post('/auth/register').send({ email, password });
  const row = mockPrisma.users.find((u) => u.email === email);
  if (row) row.role = role;
  const res = await request(app).post('/auth/login').send({ email, password });
  return {
    id: row?.id as string,
    email,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
  };
}

const as = (session: Session) => ({ Authorization: `Bearer ${session.accessToken}` });
const events = () => mockPrisma.auditLogs.map((a) => a.event);

beforeEach(() => {
  mockPrisma.reset();
  jest.restoreAllMocks();
});

describe('authorization guard on /admin', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/admin/users');

    expect(res.status).toBe(401);
  });

  it('returns 403 for a regular user and audits the denial', async () => {
    const user = await createUser('user@example.com');

    const res = await request(app).get('/admin/users?page=1').set(as(user));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(mockPrisma.auditLogs.find((a) => a.event === 'ACCESS_DENIED')).toMatchObject({
      userId: user.id,
      metadata: { method: 'GET', path: '/admin/users', role: 'USER' },
    });
  });

  it('allows an admin', async () => {
    const admin = await createUser('admin@example.com', 'ADMIN');

    const res = await request(app).get('/admin/users').set(as(admin));

    expect(res.status).toBe(200);
  });

  it('cannot be bypassed by forging an ADMIN role claim', async () => {
    const user = await createUser('user@example.com');
    const forged = jwt.sign({ role: 'ADMIN' }, 'x'.repeat(40), {
      subject: user.id,
      issuer: 'auth-service',
      expiresIn: 60,
    });

    const res = await request(app).get('/admin/users').set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
  });

  it('ignores a "role" field sent at registration', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'sneaky@example.com', password, role: 'ADMIN' });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('USER');
    expect(mockPrisma.users[0]?.role).toBe('USER');
  });
});

describe('GET /admin/users', () => {
  it('lists users without any secrets', async () => {
    const admin = await createUser('admin@example.com', 'ADMIN');
    await createUser('user@example.com');

    const res = await request(app).get('/admin/users').set(as(admin));

    expect(res.body).toMatchObject({ page: 1, limit: 20, total: 2 });
    expect(res.body.users).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
  });

  it('paginates', async () => {
    const admin = await createUser('admin@example.com', 'ADMIN');
    await createUser('a@example.com');
    await createUser('b@example.com');

    const res = await request(app).get('/admin/users?page=2&limit=2').set(as(admin));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 2, limit: 2, total: 3 });
    expect(res.body.users).toHaveLength(1);
  });

  it.each(['limit=1000', 'limit=0', 'page=0', 'page=abc'])('rejects %s with 400', async (query) => {
    const admin = await createUser('admin@example.com', 'ADMIN');

    const res = await request(app).get(`/admin/users?${query}`).set(as(admin));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /admin/users/:id/role', () => {
  it('promotes a user, revokes their sessions and audits the change', async () => {
    const admin = await createUser('admin@example.com', 'ADMIN');
    const user = await createUser('user@example.com');
    mockPrisma.auditLogs.length = 0;

    const res = await request(app)
      .patch(`/admin/users/${user.id}/role`)
      .set(as(admin))
      .send({ role: 'ADMIN' });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.id, role: 'ADMIN' });

    const refresh = await request(app).post('/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(refresh.status).toBe(401);

    expect(mockPrisma.auditLogs.find((a) => a.event === 'ROLE_CHANGED')).toMatchObject({
      userId: admin.id,
      metadata: { targetUserId: user.id, from: 'USER', to: 'ADMIN' },
    });
  });

  it('applies the new role to tokens issued after the change, not to old ones', async () => {
    const admin = await createUser('admin@example.com', 'ADMIN');
    const user = await createUser('user@example.com');

    await request(app).patch(`/admin/users/${user.id}/role`).set(as(admin)).send({ role: 'ADMIN' });

    const oldToken = await request(app).get('/admin/users').set(as(user));
    expect(oldToken.status).toBe(403); // still carries role USER until it expires

    const login = await request(app).post('/auth/login').send({ email: user.email, password });
    const fresh = await request(app)
      .get('/admin/users')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(fresh.status).toBe(200);
  });

  it('demotes an admin and cuts off their refresh', async () => {
    const admin = await createUser('admin@example.com', 'ADMIN');
    const other = await createUser('other@example.com', 'ADMIN');

    const res = await request(app)
      .patch(`/admin/users/${other.id}/role`)
      .set(as(admin))
      .send({ role: 'USER' });
    expect(res.status).toBe(200);

    const refresh = await request(app).post('/auth/refresh').send({ refreshToken: other.refreshToken });
    expect(refresh.status).toBe(401);

    const login = await request(app).post('/auth/login').send({ email: other.email, password });
    const denied = await request(app)
      .get('/admin/users')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(denied.status).toBe(403);
  });

  it('does not let an admin change their own role', async () => {
    const admin = await createUser('admin@example.com', 'ADMIN');

    const res = await request(app)
      .patch(`/admin/users/${admin.id}/role`)
      .set(as(admin))
      .send({ role: 'USER' });

    expect(res.status).toBe(403);
    expect(mockPrisma.users.find((u) => u.id === admin.id)?.role).toBe('ADMIN');
  });

  it('does not let a regular user change roles', async () => {
    const user = await createUser('user@example.com');

    const res = await request(app)
      .patch(`/admin/users/${user.id}/role`)
      .set(as(user))
      .send({ role: 'ADMIN' });

    expect(res.status).toBe(403);
    expect(mockPrisma.users.find((u) => u.id === user.id)?.role).toBe('USER');
  });

  it('is a no-op when the role is unchanged (no revocation, no audit)', async () => {
    const admin = await createUser('admin@example.com', 'ADMIN');
    const user = await createUser('user@example.com');
    mockPrisma.auditLogs.length = 0;

    const res = await request(app)
      .patch(`/admin/users/${user.id}/role`)
      .set(as(admin))
      .send({ role: 'USER' });

    expect(res.status).toBe(200);
    expect(events()).not.toContain('ROLE_CHANGED');
    const refresh = await request(app).post('/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(refresh.status).toBe(200);
  });

  it('returns 404 for an unknown user', async () => {
    const admin = await createUser('admin@example.com', 'ADMIN');

    const res = await request(app)
      .patch('/admin/users/3f1c2b7e-8a4d-4c55-9a66-1d2e3f4a5b6c/role')
      .set(as(admin))
      .send({ role: 'ADMIN' });

    expect(res.status).toBe(404);
  });

  it.each([
    ['a non-uuid id', '/admin/users/not-a-uuid/role', { role: 'ADMIN' }],
    ['an unknown role', '/admin/users/3f1c2b7e-8a4d-4c55-9a66-1d2e3f4a5b6c/role', { role: 'ROOT' }],
    ['a missing role', '/admin/users/3f1c2b7e-8a4d-4c55-9a66-1d2e3f4a5b6c/role', {}],
  ])('rejects %s with 400', async (_name, path, body) => {
    const admin = await createUser('admin@example.com', 'ADMIN');

    const res = await request(app).patch(path).set(as(admin)).send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
