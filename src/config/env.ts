import 'dotenv/config';
import { z } from 'zod';

// z.coerce.boolean() would turn the string "false" into true, so parse flags explicitly.
const flag = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((value) => value === 'true');
const booleanFlag = flag('false');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    CORS_ORIGIN: z.string().default('*'),
    DATABASE_URL: z.string().default('postgresql://auth:auth@localhost:5432/auth_service'),
    REDIS_URL: z.string().default('redis://localhost:6379'),

    // No default on purpose: a guessable fallback secret would be a real vulnerability.
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ISSUER: z.string().default('auth-service'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

    // Frontend base URL used to build the links in emails.
    APP_BASE_URL: z.string().url().default('http://localhost:3000'),
    REQUIRE_EMAIL_VERIFICATION: booleanFlag,
    EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().positive().default(24),
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(60),

    EMAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),
    EMAIL_FROM: z.string().min(3).default('Auth Service <no-reply@localhost>'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_SECURE: booleanFlag,

    // Abuse protection
    RATE_LIMIT_ENABLED: flag('true'),
    RATE_LIMIT_STORE: z.enum(['redis', 'memory']).default('redis'),
    // How many reverse proxies sit in front of the app (0 = none). Needed to see real client IPs.
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    MAX_FAILED_LOGINS: z.coerce.number().int().min(1).default(5),
    LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

    // Swagger UI at /docs and the raw spec at /openapi.json. Unset = on everywhere except production.
    API_DOCS_ENABLED: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
  })
  .superRefine((value, ctx) => {
    if (value.EMAIL_TRANSPORT === 'smtp' && !value.SMTP_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_HOST'],
        message: 'SMTP_HOST is required when EMAIL_TRANSPORT=smtp',
      });
    }
    if (value.NODE_ENV === 'production' && value.EMAIL_TRANSPORT === 'console') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_TRANSPORT'],
        message: 'the console transport prints one-time links to the logs; use smtp in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

export const env = parseEnv(process.env);
