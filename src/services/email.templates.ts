import { env } from '../config/env';
import type { EmailMessage } from './email.service';

/** Builds a link into the frontend, e.g. https://app.example.com/verify-email?token=... */
export function buildLink(path: string, token: string): string {
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}${path}?token=${encodeURIComponent(token)}`;
}

export function verificationEmail(to: string, link: string, ttlHours: number): EmailMessage {
  return {
    to,
    subject: 'Confirm your email address',
    text: [
      'Welcome! Please confirm your email address by opening this link:',
      '',
      link,
      '',
      `The link expires in ${ttlHours} hours. If you did not create an account, you can ignore this email.`,
    ].join('\n'),
  };
}

export function passwordResetEmail(to: string, link: string, ttlMinutes: number): EmailMessage {
  return {
    to,
    subject: 'Reset your password',
    text: [
      'We received a request to reset your password. Open this link to choose a new one:',
      '',
      link,
      '',
      `The link expires in ${ttlMinutes} minutes and can be used once.`,
      'If you did not request this, you can ignore this email: your password has not changed.',
    ].join('\n'),
  };
}

export function passwordChangedEmail(to: string): EmailMessage {
  return {
    to,
    subject: 'Your password was changed',
    text: [
      'The password for your account was just changed, and you were signed out of all devices.',
      '',
      'If this was not you, reset your password immediately and contact support.',
    ].join('\n'),
  };
}

export function accountLockedEmail(to: string, lockoutMinutes: number): EmailMessage {
  return {
    to,
    subject: 'Your account was temporarily locked',
    text: [
      `There were several failed sign-in attempts on your account, so it is locked for ${lockoutMinutes} minutes.`,
      '',
      'If this was you, wait and try again, or reset your password to unlock it right away.',
      'If it was not you, reset your password now: someone may be trying to guess it.',
    ].join('\n'),
  };
}
