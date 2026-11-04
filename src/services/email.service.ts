import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Development transport: prints the email to the logs so links can be clicked locally.
 * Config validation forbids it in production because the logs would then contain live tokens.
 */
export class ConsoleEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    logger.info({ to: message.to, subject: message.subject }, `[email:console]\n${message.text}`);
  }
}

export class SmtpEmailSender implements EmailSender {
  constructor(
    private readonly transporter: Transporter,
    private readonly from: string,
  ) {}

  static fromEnv(): SmtpEmailSender {
    const transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } : undefined,
    });
    return new SmtpEmailSender(transporter, env.EMAIL_FROM);
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}

let sender: EmailSender | undefined;

export function getEmailSender(): EmailSender {
  sender ??= env.EMAIL_TRANSPORT === 'smtp' ? SmtpEmailSender.fromEnv() : new ConsoleEmailSender();
  return sender;
}

/** Swap the sender (tests), or pass undefined to go back to the configured one. */
export function setEmailSender(next: EmailSender | undefined): void {
  sender = next;
}
