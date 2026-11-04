import nodemailer from 'nodemailer';
import { parseEnv } from '../src/config/env';
import { SmtpEmailSender } from '../src/services/email.service';
import { passwordResetEmail, verificationEmail, buildLink } from '../src/services/email.templates';
import { runInBackground, waitForBackgroundTasks } from '../src/utils/background';

describe('SmtpEmailSender', () => {
  it('passes the message to the transport with the configured sender address', async () => {
    const transporter = nodemailer.createTransport({ jsonTransport: true });
    const sendMail = jest.spyOn(transporter, 'sendMail');
    const sender = new SmtpEmailSender(transporter, 'Auth <no-reply@example.com>');

    await sender.send({ to: 'ada@example.com', subject: 'Hello', text: 'Body' });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'Auth <no-reply@example.com>',
      to: 'ada@example.com',
      subject: 'Hello',
      text: 'Body',
    });
  });

  it('surfaces transport failures to the caller', async () => {
    const transporter = nodemailer.createTransport({ jsonTransport: true });
    jest.spyOn(transporter, 'sendMail').mockRejectedValueOnce(new Error('connection refused'));
    const sender = new SmtpEmailSender(transporter, 'no-reply@example.com');

    await expect(sender.send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toThrow('connection refused');
  });
});

describe('email templates', () => {
  it('builds frontend links with an encoded token and no double slash', () => {
    expect(buildLink('/verify-email', 'a-b_c')).toBe('http://localhost:3000/verify-email?token=a-b_c');
    expect(buildLink('/reset-password', 'x y')).toContain('token=x%20y');
  });

  it('states the expiry in the message', () => {
    expect(verificationEmail('a@b.com', 'https://x/y', 24).text).toContain('24 hours');
    expect(passwordResetEmail('a@b.com', 'https://x/y', 60).text).toContain('60 minutes');
  });
});

describe('environment validation', () => {
  const base = { JWT_ACCESS_SECRET: 'x'.repeat(40) };

  it('applies safe defaults', () => {
    const env = parseEnv(base);

    expect(env.EMAIL_TRANSPORT).toBe('console');
    expect(env.REQUIRE_EMAIL_VERIFICATION).toBe(false);
    expect(env.EMAIL_VERIFICATION_TTL_HOURS).toBe(24);
    expect(env.PASSWORD_RESET_TTL_MINUTES).toBe(60);
  });

  it('parses boolean flags literally ("false" must not become true)', () => {
    expect(parseEnv({ ...base, REQUIRE_EMAIL_VERIFICATION: 'false' }).REQUIRE_EMAIL_VERIFICATION).toBe(false);
    expect(parseEnv({ ...base, REQUIRE_EMAIL_VERIFICATION: 'true' }).REQUIRE_EMAIL_VERIFICATION).toBe(true);
    expect(() => parseEnv({ ...base, REQUIRE_EMAIL_VERIFICATION: 'yes' })).toThrow();
  });

  it('refuses the console email transport in production', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production' })).toThrow(/console transport/);
  });

  it('requires SMTP_HOST for the smtp transport', () => {
    expect(() => parseEnv({ ...base, EMAIL_TRANSPORT: 'smtp' })).toThrow(/SMTP_HOST/);
  });

  it('accepts a complete production configuration', () => {
    const env = parseEnv({
      ...base,
      NODE_ENV: 'production',
      EMAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'smtp.example.com',
    });

    expect(env.SMTP_PORT).toBe(587);
  });

  it('rejects a short JWT secret', () => {
    expect(() => parseEnv({ JWT_ACCESS_SECRET: 'replace-me' })).toThrow(/JWT_ACCESS_SECRET/);
  });
});

describe('runInBackground', () => {
  it('swallows task failures so they cannot crash the process', async () => {
    runInBackground('failing-task', async () => {
      throw new Error('boom');
    });

    await expect(waitForBackgroundTasks()).resolves.toBeUndefined();
  });

  it('waits for tasks that start other tasks', async () => {
    const order: string[] = [];
    runInBackground('outer', async () => {
      await Promise.resolve();
      runInBackground('inner', async () => {
        order.push('inner');
      });
      order.push('outer');
    });

    await waitForBackgroundTasks();

    expect(order).toEqual(['outer', 'inner']);
  });
});
