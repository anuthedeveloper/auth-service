import request from 'supertest';
import { createApp } from '../src/app';
import { seedAdmin } from '../src/scripts/seedAdmin';
import { createFakePrisma } from './helpers/fakePrisma';

const mockPrisma = createFakePrisma();
jest.mock('../src/db/prisma', () => ({
  getPrisma: () => mockPrisma,
  disconnectPrisma: jest.fn(),
}));

const creds = { email: 'admin@example.com', password: 'a-strong-passphrase' };

beforeEach(() => {
  mockPrisma.reset();
});

describe('seedAdmin', () => {
  it('creates a verified admin that can log in and use admin routes', async () => {
    const result = await seedAdmin(creds);

    expect(result.created).toBe(true);
    expect(mockPrisma.users[0]).toMatchObject({ role: 'ADMIN', email: creds.email });
    expect(mockPrisma.users[0]?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(mockPrisma.users[0]?.passwordHash).toMatch(/^\$argon2id\$/);

    const app = createApp();
    const login = await request(app).post('/auth/login').send(creds);
    const list = await request(app)
      .get('/admin/users')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(list.status).toBe(200);
  });

  it('is idempotent', async () => {
    const first = await seedAdmin(creds);
    const second = await seedAdmin(creds);

    expect(second).toEqual({ userId: first.userId, created: false });
    expect(mockPrisma.users).toHaveLength(1);
  });

  it('promotes an existing user without touching their password', async () => {
    const app = createApp();
    await request(app).post('/auth/register').send({ ...creds, password: 'original-password-1' });
    const before = mockPrisma.users[0]?.passwordHash;

    const result = await seedAdmin(creds);

    expect(result.created).toBe(false);
    expect(mockPrisma.users[0]?.role).toBe('ADMIN');
    expect(mockPrisma.users[0]?.passwordHash).toBe(before);
    expect(mockPrisma.users[0]?.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('enforces the registration password rules', async () => {
    await expect(seedAdmin({ email: creds.email, password: 'short' })).rejects.toThrow();
    await expect(seedAdmin({ email: 'not-an-email', password: creds.password })).rejects.toThrow();
    expect(mockPrisma.users).toHaveLength(0);
  });
});
