import request from 'supertest';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { setEmailSender, type EmailMessage, type EmailSender } from '../src/services/email.service';
import { waitForBackgroundTasks } from '../src/utils/background';
import { hashToken } from '../src/utils/crypto';
import { createFakePrisma } from './helpers/fakePrisma';

const mockPrisma = createFakePrisma();
jest.mock('../src/db/prisma', () => ({
  getPrisma: () => mockPrisma,
  disconnectPrisma: jest.fn(),
}));

class OutboxSender implements EmailSender {
  sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

const outbox = new OutboxSender();
const app = createApp();
const creds = { email: 'ada@example.com', password: 'a-strong-passphrase' };

const tokenFrom = (message: EmailMessage | undefined): string =>
  /token=([\w-]+)/.exec(message?.text ?? '')?.[1] ?? '';
const events = () => mockPrisma.auditLogs.map((a) => a.event);
const user = () => mockPrisma.users.find((u) => u.email === creds.email);

async function register(email = creds.email): Promise<void> {
  const res = await request(app).post('/auth/register').send({ email, password: creds.password });
  expect(res.status).toBe(201);
  await waitForBackgroundTasks();
}

/** Asks for a reset and returns the raw token from the email that was "sent". */
async function requestReset(email = creds.email): Promise<string> {
  outbox.sent.length = 0;
  const res = await request(app).post('/auth/forgot-password').send({ email });
  expect(res.status).toBe(202);
  await waitForBackgroundTasks();
  return tokenFrom(outbox.sent[0]);
}

const login = (password = creds.password) =>
  request(app).post('/auth/login').send({ email: creds.email, password });

beforeEach(() => {
  mockPrisma.reset();
  outbox.sent.length = 0;
  jest.restoreAllMocks();
  setEmailSender(outbox);
});

afterEach(() => {
  env.REQUIRE_EMAIL_VERIFICATION = false;
});

afterAll(() => {
  setEmailSender(undefined);
});

describe('email verification', () => {
  it('emails a verification link on registration and stores only a hash', async () => {
    await register();

    expect(outbox.sent).toHaveLength(1);
    const [message] = outbox.sent;
    const token = tokenFrom(message);
    expect(message?.to).toBe(creds.email);
    expect(message?.text).toContain(`${env.APP_BASE_URL}/verify-email?token=${token}`);

    const stored = mockPrisma.verificationTokens[0];
    expect(stored).toMatchObject({ type: 'EMAIL_VERIFICATION', tokenHash: hashToken(token) });
    expect(JSON.stringify(mockPrisma.verificationTokens)).not.toContain(token);
    const expectedExpiry = Date.now() + 24 * 60 * 60 * 1000;
    expect(Math.abs((stored?.expiresAt.getTime() ?? 0) - expectedExpiry)).toBeLessThan(5000);
  });

  it('verifies the address with the emailed token', async () => {
    await register();
    const token = tokenFrom(outbox.sent[0]);

    const res = await request(app).post('/auth/verify-email').send({ token });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: creds.email, emailVerified: true });
    expect(user()?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(events()).toContain('EMAIL_VERIFIED');
    expect((await login()).body.user.emailVerified).toBe(true);
  });

  it('only works once', async () => {
    await register();
    const token = tokenFrom(outbox.sent[0]);

    await request(app).post('/auth/verify-email').send({ token });
    const again = await request(app).post('/auth/verify-email').send({ token });

    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_TOKEN');
  });

  it('rejects an expired token', async () => {
    await register();
    const token = tokenFrom(outbox.sent[0]);
    const row = mockPrisma.verificationTokens[0];
    if (row) row.expiresAt = new Date(Date.now() - 1000);

    const res = await request(app).post('/auth/verify-email').send({ token });

    expect(res.status).toBe(400);
    expect(user()?.emailVerifiedAt).toBeNull();
  });

  it('rejects unknown and malformed tokens', async () => {
    const unknown = await request(app).post('/auth/verify-email').send({ token: 'made-up' });
    const missing = await request(app).post('/auth/verify-email').send({});

    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('INVALID_TOKEN');
    expect(missing.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('does not accept a password-reset token', async () => {
    await register();
    const resetToken = await requestReset();

    const res = await request(app).post('/auth/verify-email').send({ token: resetToken });

    expect(res.status).toBe(400);
    expect(user()?.emailVerifiedAt).toBeNull();
  });

  it('lets only one of two concurrent requests with the same token succeed', async () => {
    await register();
    const token = tokenFrom(outbox.sent[0]);

    const [a, b] = await Promise.all([
      request(app).post('/auth/verify-email').send({ token }),
      request(app).post('/auth/verify-email').send({ token }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 400]);
  });

  it('still registers the user when the email cannot be sent', async () => {
    jest.spyOn(outbox, 'send').mockRejectedValueOnce(new Error('smtp down'));

    const res = await request(app).post('/auth/register').send(creds);
    await waitForBackgroundTasks();

    expect(res.status).toBe(201);
    expect(user()).toBeDefined();
  });
});

describe('POST /auth/resend-verification', () => {
  const generic = {
    message: 'If an unverified account exists for this email, a new verification email has been sent.',
  };

  it('sends a new email and invalidates the previous link', async () => {
    await register();
    const oldToken = tokenFrom(outbox.sent[0]);
    outbox.sent.length = 0;

    const res = await request(app).post('/auth/resend-verification').send({ email: creds.email });
    await waitForBackgroundTasks();

    expect(res.status).toBe(202);
    expect(res.body).toEqual(generic);
    const newToken = tokenFrom(outbox.sent[0]);
    expect(newToken).not.toBe('');
    expect(newToken).not.toBe(oldToken);
    expect(mockPrisma.verificationTokens).toHaveLength(1);

    expect((await request(app).post('/auth/verify-email').send({ token: oldToken })).status).toBe(400);
    expect((await request(app).post('/auth/verify-email').send({ token: newToken })).status).toBe(200);
  });

  it('answers identically and sends nothing for unknown emails', async () => {
    const res = await request(app).post('/auth/resend-verification').send({ email: 'nobody@example.com' });
    await waitForBackgroundTasks();

    expect(res.status).toBe(202);
    expect(res.body).toEqual(generic);
    expect(outbox.sent).toHaveLength(0);
  });

  it('sends nothing for already verified accounts', async () => {
    await register();
    await request(app).post('/auth/verify-email').send({ token: tokenFrom(outbox.sent[0]) });
    outbox.sent.length = 0;

    const res = await request(app).post('/auth/resend-verification').send({ email: creds.email });
    await waitForBackgroundTasks();

    expect(res.status).toBe(202);
    expect(outbox.sent).toHaveLength(0);
  });
});

describe('REQUIRE_EMAIL_VERIFICATION', () => {
  it('lets unverified users sign in by default', async () => {
    await register();

    const res = await login();

    expect(res.status).toBe(200);
    expect(res.body.user.emailVerified).toBe(false);
  });

  it('blocks unverified users, but only after a correct password', async () => {
    env.REQUIRE_EMAIL_VERIFICATION = true;
    await register();

    const blocked = await login();
    const wrongPassword = await login('definitely-wrong');

    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(blocked.body).not.toHaveProperty('accessToken');
    expect(wrongPassword.status).toBe(401); // no hint that the account exists or is unverified
    expect(mockPrisma.auditLogs.find((a) => a.metadata?.reason === 'email_not_verified')).toBeDefined();
  });

  it('allows sign-in once the address is verified', async () => {
    env.REQUIRE_EMAIL_VERIFICATION = true;
    await register();
    await request(app).post('/auth/verify-email').send({ token: tokenFrom(outbox.sent[0]) });

    expect((await login()).status).toBe(200);
  });
});

describe('POST /auth/forgot-password', () => {
  const generic = { message: 'If an account exists for this email, a password reset link has been sent.' };

  it('emails a one-time link (hash stored, 1 hour expiry)', async () => {
    await register();
    const token = await requestReset();

    expect(token).not.toBe('');
    expect(outbox.sent[0]?.text).toContain(`${env.APP_BASE_URL}/reset-password?token=${token}`);
    const stored = mockPrisma.verificationTokens.find((t) => t.type === 'PASSWORD_RESET');
    expect(stored?.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(mockPrisma.verificationTokens)).not.toContain(token);
    const expectedExpiry = Date.now() + 60 * 60 * 1000;
    expect(Math.abs((stored?.expiresAt.getTime() ?? 0) - expectedExpiry)).toBeLessThan(5000);
    expect(events()).toContain('PASSWORD_RESET_REQUESTED');
  });

  it('gives the same response for known and unknown emails (no enumeration)', async () => {
    await register();
    outbox.sent.length = 0;

    const known = await request(app).post('/auth/forgot-password').send({ email: creds.email });
    const unknown = await request(app).post('/auth/forgot-password').send({ email: 'nobody@example.com' });
    await waitForBackgroundTasks();

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(generic);
    expect(unknown.body).toEqual(known.body);
    expect(outbox.sent).toHaveLength(1);
    expect(outbox.sent[0]?.to).toBe(creds.email);
  });

  it('invalidates earlier reset links when a new one is requested', async () => {
    await register();
    const first = await requestReset();
    const second = await requestReset();

    const old = await request(app).post('/auth/reset-password').send({ token: first, password: 'brand-new-passphrase' });
    const fresh = await request(app).post('/auth/reset-password').send({ token: second, password: 'brand-new-passphrase' });

    expect(old.status).toBe(400);
    expect(fresh.status).toBe(200);
  });

  it('rejects a malformed email with 400', async () => {
    const res = await request(app).post('/auth/forgot-password').send({ email: 'nope' });

    expect(res.status).toBe(400);
  });
});

describe('POST /auth/reset-password', () => {
  const newPassword = 'brand-new-passphrase';

  it('changes the password', async () => {
    await register();
    const token = await requestReset();

    const res = await request(app).post('/auth/reset-password').send({ token, password: newPassword });

    expect(res.status).toBe(200);
    expect((await login(newPassword)).status).toBe(200);
    expect((await login(creds.password)).status).toBe(401);
    expect(user()?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(events()).toContain('PASSWORD_RESET_COMPLETED');
  });

  it('signs the user out everywhere', async () => {
    await register();
    const session = await login();
    const token = await requestReset();

    await request(app).post('/auth/reset-password').send({ token, password: newPassword });

    const refresh = await request(app).post('/auth/refresh').send({ refreshToken: session.body.refreshToken });
    expect(refresh.status).toBe(401);
  });

  it('notifies the user that the password changed', async () => {
    await register();
    const token = await requestReset();
    outbox.sent.length = 0;

    await request(app).post('/auth/reset-password').send({ token, password: newPassword });
    await waitForBackgroundTasks();

    expect(outbox.sent).toHaveLength(1);
    expect(outbox.sent[0]).toMatchObject({ to: creds.email, subject: 'Your password was changed' });
    expect(outbox.sent[0]?.text).not.toContain(newPassword);
  });

  it('clears failed-login counters and lockout', async () => {
    await register();
    const row = user();
    if (row) {
      row.failedLoginAttempts = 4;
      row.lockedUntil = new Date(Date.now() + 60_000);
    }
    const token = await requestReset();

    await request(app).post('/auth/reset-password').send({ token, password: newPassword });

    expect(user()).toMatchObject({ failedLoginAttempts: 0, lockedUntil: null });
  });

  it('verifies the email address, since the user proved they own the mailbox', async () => {
    await register();
    const token = await requestReset();

    await request(app).post('/auth/reset-password').send({ token, password: newPassword });

    expect(user()?.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('only works once', async () => {
    await register();
    const token = await requestReset();

    await request(app).post('/auth/reset-password').send({ token, password: newPassword });
    const again = await request(app).post('/auth/reset-password').send({ token, password: 'another-passphrase-1' });

    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_TOKEN');
    expect((await login(newPassword)).status).toBe(200);
  });

  it('lets only one of two concurrent resets with the same token win', async () => {
    await register();
    const token = await requestReset();

    const [a, b] = await Promise.all([
      request(app).post('/auth/reset-password').send({ token, password: 'first-new-passphrase' }),
      request(app).post('/auth/reset-password').send({ token, password: 'second-new-passphrase' }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 400]);
  });

  it('keeps the token usable after a weak-password rejection', async () => {
    await register();
    const token = await requestReset();

    const weak = await request(app).post('/auth/reset-password').send({ token, password: 'short' });
    const ok = await request(app).post('/auth/reset-password').send({ token, password: newPassword });

    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
    expect(ok.status).toBe(200);
  });

  it('rejects an expired token', async () => {
    await register();
    const token = await requestReset();
    const row = mockPrisma.verificationTokens.find((t) => t.type === 'PASSWORD_RESET');
    if (row) row.expiresAt = new Date(Date.now() - 1000);

    const res = await request(app).post('/auth/reset-password').send({ token, password: newPassword });

    expect(res.status).toBe(400);
    expect((await login(creds.password)).status).toBe(200);
  });

  it('does not accept an email-verification token', async () => {
    await register();
    const verificationToken = tokenFrom(outbox.sent[0]);

    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token: verificationToken, password: newPassword });

    expect(res.status).toBe(400);
    expect((await login(creds.password)).status).toBe(200);
  });
});
