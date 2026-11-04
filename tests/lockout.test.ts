import request from 'supertest';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { setEmailSender, type EmailMessage, type EmailSender } from '../src/services/email.service';
import * as authService from '../src/modules/auth/auth.service';
import { waitForBackgroundTasks } from '../src/utils/background';
import * as passwordUtils from '../src/utils/password';
import { createFakePrisma, type FakeUser } from './helpers/fakePrisma';

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

const app = createApp();
const outbox = new Outbox();
const creds = { email: 'ada@example.com', password: 'a-strong-passphrase' };
const original = { max: env.MAX_FAILED_LOGINS, minutes: env.LOCKOUT_MINUTES };

const login = (password = creds.password, email = creds.email) =>
  request(app).post('/auth/login').send({ email, password });
const wrong = () => login('definitely-wrong');
const user = () => mockPrisma.users[0] as FakeUser;
const events = () => mockPrisma.auditLogs.map((a) => a.event);

async function lockAccount(): Promise<void> {
  for (let i = 0; i < env.MAX_FAILED_LOGINS; i++) {
    await wrong();
  }
}

beforeEach(async () => {
  mockPrisma.reset();
  setEmailSender(outbox);
  await request(app).post('/auth/register').send(creds);
  await waitForBackgroundTasks(); // registration queues a verification email
  outbox.sent = [];
  mockPrisma.auditLogs.length = 0;
});

afterEach(() => {
  jest.restoreAllMocks();
  env.MAX_FAILED_LOGINS = original.max;
  env.LOCKOUT_MINUTES = original.minutes;
  setEmailSender(undefined);
});

describe('account lockout', () => {
  it('locks the account once the failed-login limit is reached', async () => {
    for (let i = 0; i < env.MAX_FAILED_LOGINS - 1; i++) {
      await wrong();
    }
    expect(user().lockedUntil).toBeNull();
    expect(user().failedLoginAttempts).toBe(env.MAX_FAILED_LOGINS - 1);

    await wrong();

    expect(user().lockedUntil).toBeInstanceOf(Date);
    expect((user().lockedUntil as Date).getTime()).toBeGreaterThan(
      Date.now() + (env.LOCKOUT_MINUTES - 1) * 60_000,
    );
    expect(user().failedLoginAttempts).toBe(0);
    expect(events().filter((e) => e === 'ACCOUNT_LOCKED')).toHaveLength(1);
  });

  it('honours a custom limit', async () => {
    env.MAX_FAILED_LOGINS = 2;

    await wrong();
    expect(user().lockedUntil).toBeNull();
    await wrong();

    expect(user().lockedUntil).toBeInstanceOf(Date);
  });

  it('refuses even the correct password while locked, with the same reply as a wrong one', async () => {
    await lockAccount();
    const lockedUntil = user().lockedUntil;

    const correct = await login();
    const incorrect = await wrong();
    const unknownEmail = await login('definitely-wrong', 'nobody@example.com');

    expect(correct.status).toBe(401);
    expect(correct.body).toEqual(incorrect.body);
    expect(correct.body).toEqual(unknownEmail.body); // a lock reveals nothing about the account
    expect(mockPrisma.refreshTokens).toHaveLength(0);
    expect(events()).toContain('LOGIN_BLOCKED');
    // Attempts during a lock neither count nor extend it.
    expect(user().lockedUntil).toEqual(lockedUntil);
    expect(user().failedLoginAttempts).toBe(0);
  });

  it('emails the owner once when the account locks', async () => {
    await lockAccount();
    await waitForBackgroundTasks();

    expect(outbox.sent).toHaveLength(1);
    expect(outbox.sent[0]).toMatchObject({ to: creds.email });
    expect(outbox.sent[0]?.subject).toMatch(/locked/i);
    expect(outbox.sent[0]?.text).toContain(`${env.LOCKOUT_MINUTES} minutes`);
  });

  it('stays consistent when wrong guesses arrive in parallel over HTTP', async () => {
    await Promise.all(Array.from({ length: env.MAX_FAILED_LOGINS + 3 }, () => wrong()));
    await waitForBackgroundTasks();

    expect(user().lockedUntil).toBeInstanceOf(Date);
    expect(events().filter((e) => e === 'ACCOUNT_LOCKED')).toHaveLength(1);
    expect(outbox.sent).toHaveLength(1);
  });

  // Over HTTP, slow password hashing tends to serialize requests, so the previous test rarely
  // races for real. Here the password check is instant, so every guess has read the account
  // before any of them is counted, and several cross the limit together.
  it('locks, audits and emails exactly once when guesses race to cross the limit', async () => {
    jest.spyOn(passwordUtils, 'verifyPassword').mockResolvedValue(false);
    const guesses = env.MAX_FAILED_LOGINS + 4;

    const results = await Promise.allSettled(
      Array.from({ length: guesses }, () => authService.login(creds, {})),
    );
    await waitForBackgroundTasks();

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(user().lockedUntil).toBeInstanceOf(Date);
    expect(events().filter((e) => e === 'LOGIN_FAILED')).toHaveLength(guesses); // all really raced
    expect(events().filter((e) => e === 'ACCOUNT_LOCKED')).toHaveLength(1);
    expect(outbox.sent).toHaveLength(1);
  });

  it('resets the counter after a successful login', async () => {
    await wrong();
    await wrong();
    await wrong();
    expect(user().failedLoginAttempts).toBe(3);

    expect((await login()).status).toBe(200);
    expect(user().failedLoginAttempts).toBe(0);

    // The earlier failures no longer count towards a lock.
    for (let i = 0; i < env.MAX_FAILED_LOGINS - 1; i++) {
      await wrong();
    }
    expect((await login()).status).toBe(200);
  });

  it('lets the owner in again once the lock has expired', async () => {
    await lockAccount();
    (user() as FakeUser).lockedUntil = new Date(Date.now() - 1_000);

    const res = await login();

    expect(res.status).toBe(200);
    expect(user().lockedUntil).toBeNull();
  });

  it('starts counting from zero after a lock expires, even with a leftover counter', async () => {
    await lockAccount();
    // Parallel guesses can leave a stale counter behind; expiry must not re-lock on one failure.
    user().lockedUntil = new Date(Date.now() - 1_000);
    user().failedLoginAttempts = env.MAX_FAILED_LOGINS;

    const res = await wrong();

    expect(res.status).toBe(401);
    expect(user().lockedUntil).toBeNull();
    expect(user().failedLoginAttempts).toBe(1);
  });

  it('never locks or changes anything for unknown emails', async () => {
    for (let i = 0; i < env.MAX_FAILED_LOGINS + 2; i++) {
      const res = await login('definitely-wrong', 'nobody@example.com');
      expect(res.status).toBe(401);
    }

    expect(mockPrisma.users).toHaveLength(1);
    expect(user().failedLoginAttempts).toBe(0);
    expect(outbox.sent).toHaveLength(0);
  });

  it('is lifted by resetting the password', async () => {
    await lockAccount();
    await waitForBackgroundTasks();
    outbox.sent = [];

    await request(app).post('/auth/forgot-password').send({ email: creds.email });
    await waitForBackgroundTasks();
    const resetMail = outbox.sent.find((m) => m.subject === 'Reset your password');
    const token = /token=([^\s&]+)/.exec(resetMail?.text ?? '')?.[1];
    expect(token).toBeDefined();

    const reset = await request(app)
      .post('/auth/reset-password')
      .send({ token, password: 'a-brand-new-passphrase' });
    expect(reset.status).toBe(200);

    expect((await login('a-brand-new-passphrase')).status).toBe(200);
  });
});
