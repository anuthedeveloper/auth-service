import type { OpenAPIV3 } from 'openapi-types';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  changeRoleSchema,
  listUsersQuerySchema,
  userIdParamSchema,
} from '../modules/admin/admin.schemas';
import {
  emailOnlySchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '../modules/auth/auth.schemas';

/** Version of the HTTP API (not the npm package). Bump it when the contract changes. */
export const API_VERSION = '1.0.0';

type Schema = OpenAPIV3.SchemaObject;
type Ref = OpenAPIV3.ReferenceObject;

// ---- helpers -------------------------------------------------------------------------------

/**
 * Request shapes come straight from the zod schemas that validate them at runtime, so limits such
 * as password length can't drift from the documentation.
 */
// Called through a narrow type: its generic signature makes the compiler recurse too deeply
// ("Type instantiation is excessively deep", TS2589) when given an arbitrary ZodTypeAny.
const convertZod = zodToJsonSchema as unknown as (schema: ZodTypeAny, options: object) => unknown;

function schemaOf(schema: ZodTypeAny): Schema {
  const json = convertZod(schema, { target: 'openApi3', $refStrategy: 'none' }) as Schema;
  // zod drops unknown keys instead of rejecting them, so "additionalProperties: false" would mislead.
  delete json.additionalProperties;
  return json;
}

function parametersFrom(
  schema: ZodTypeAny,
  location: 'query' | 'path',
  descriptions: Record<string, string>,
): OpenAPIV3.ParameterObject[] {
  const { properties = {}, required = [] } = schemaOf(schema);
  return Object.entries(properties).map(([name, value]) => ({
    name,
    in: location,
    required: location === 'path' || required.includes(name),
    description: descriptions[name],
    schema: value as Schema,
  }));
}

const ref = (name: string): Ref => ({ $ref: `#/components/schemas/${name}` });
const responseRef = (name: string): Ref => ({ $ref: `#/components/responses/${name}` });

const jsonContent = (schema: Schema | Ref, example?: unknown): Record<string, OpenAPIV3.MediaTypeObject> => ({
  'application/json': { schema, ...(example === undefined ? {} : { example }) },
});

const jsonBody = (schema: ZodTypeAny, example: unknown): OpenAPIV3.RequestBodyObject => ({
  required: true,
  content: jsonContent(schemaOf(schema), example),
});

const errorExample = (code: string, message: string, details?: unknown) => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

const errorResponse = (
  description: string,
  code: string,
  message: string,
  headers?: Record<string, OpenAPIV3.HeaderObject>,
): OpenAPIV3.ResponseObject => ({
  description,
  headers,
  content: jsonContent(ref('Error'), errorExample(code, message)),
});

const bearer: OpenAPIV3.SecurityRequirementObject[] = [{ bearerAuth: [] }];

const noStoreHeader: OpenAPIV3.HeaderObject = {
  description: 'Always `no-store`: responses that carry tokens must not be cached.',
  schema: { type: 'string', enum: ['no-store'] },
};

const wwwAuthenticateHeader: OpenAPIV3.HeaderObject = {
  description: 'Always `Bearer`.',
  schema: { type: 'string', enum: ['Bearer'] },
};

const exampleUser = {
  id: '3f1c2b7e-8a4d-4c55-9a66-1d2e3f4a5b6c',
  email: 'ada@example.com',
  role: 'USER',
  emailVerified: false,
  createdAt: '2026-10-25T09:30:00.000Z',
};

const genericAccepted = (description: string): OpenAPIV3.ResponseObject => ({
  description,
  content: jsonContent(ref('Message'), {
    message: 'If an account exists for this email, instructions have been sent.',
  }),
});

// ---- components ----------------------------------------------------------------------------

const schemas: Record<string, Schema> = {
  User: {
    type: 'object',
    required: ['id', 'email', 'role', 'emailVerified', 'createdAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      email: { type: 'string', format: 'email' },
      role: { type: 'string', enum: ['USER', 'ADMIN'] },
      emailVerified: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  AuthResponse: {
    type: 'object',
    required: ['user', 'accessToken', 'refreshToken', 'tokenType', 'expiresIn'],
    properties: {
      user: ref('User'),
      accessToken: { type: 'string', description: 'Short-lived signed JWT. Send it as a Bearer token.' },
      refreshToken: {
        type: 'string',
        description: 'Opaque, single-use token for `POST /auth/refresh`. Store it securely.',
      },
      tokenType: { type: 'string', enum: ['Bearer'] },
      expiresIn: { type: 'integer', description: 'Access token lifetime in seconds.', example: 900 },
    },
  },
  UserPage: {
    type: 'object',
    required: ['users', 'page', 'limit', 'total'],
    properties: {
      users: { type: 'array', items: ref('User') },
      page: { type: 'integer' },
      limit: { type: 'integer' },
      total: { type: 'integer', description: 'Number of users across all pages.' },
    },
  },
  Message: {
    type: 'object',
    required: ['message'],
    properties: { message: { type: 'string' } },
  },
  Error: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: {
            type: 'string',
            description: 'Stable identifier for programs, e.g. `VALIDATION_ERROR` or `UNAUTHORIZED`.',
          },
          message: { type: 'string', description: 'Human-readable explanation.' },
          details: {
            description:
              'Optional extra information: a list of `{ path, message }` for validation errors, or `{ retryAfterSeconds }` for rate limits.',
          },
        },
      },
    },
  },
};

const responses: Record<string, OpenAPIV3.ResponseObject> = {
  ValidationError: {
    description: 'The request body, query or path is invalid, or a one-time link is invalid or expired.',
    content: jsonContent(
      ref('Error'),
      errorExample('VALIDATION_ERROR', 'Request validation failed', [
        { path: 'password', message: 'Password must be at least 10 characters' },
      ]),
    ),
  },
  Unauthorized: errorResponse(
    'Missing, malformed, invalid or expired access token.',
    'UNAUTHORIZED',
    'Missing or malformed Authorization header',
    { 'WWW-Authenticate': wwwAuthenticateHeader },
  ),
  Forbidden: errorResponse('Signed in, but not allowed to do this.', 'FORBIDDEN', 'Insufficient permissions'),
  NotFound: errorResponse('The resource does not exist.', 'NOT_FOUND', 'User not found'),
  TooManyRequests: {
    description: 'A rate limit was exceeded. Wait for `Retry-After` seconds before trying again.',
    headers: {
      'Retry-After': { description: 'Seconds until the limit resets.', schema: { type: 'integer' } },
      'RateLimit-Limit': { description: 'Requests allowed per window.', schema: { type: 'integer' } },
      'RateLimit-Remaining': { description: 'Requests left in this window.', schema: { type: 'integer' } },
      'RateLimit-Reset': { description: 'Seconds until the window resets.', schema: { type: 'integer' } },
    },
    content: jsonContent(ref('Error'), {
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many requests, please try again later',
        details: { retryAfterSeconds: 540 },
      },
    }),
  },
};

// ---- paths ---------------------------------------------------------------------------------

const paths: OpenAPIV3.PathsObject = {
  '/health': {
    get: {
      tags: ['Health'],
      summary: 'Liveness check',
      description: 'Always cheap and never rate limited, so load balancers can poll it.',
      operationId: 'getHealth',
      responses: {
        '200': {
          description: 'The service is running.',
          content: jsonContent(
            {
              type: 'object',
              required: ['status', 'uptime', 'timestamp'],
              properties: {
                status: { type: 'string', enum: ['ok'] },
                uptime: { type: 'integer', description: 'Seconds since the process started.' },
                timestamp: { type: 'string', format: 'date-time' },
              },
            },
            { status: 'ok', uptime: 3600, timestamp: '2026-10-25T09:30:00.000Z' },
          ),
        },
      },
    },
  },

  '/auth/register': {
    post: {
      tags: ['Auth'],
      summary: 'Create an account',
      description: [
        'Creates a `USER` account and emails a verification link. The email is trimmed and lower-cased.',
        'Any `role` field in the body is ignored: new accounts are always `USER`.',
        '',
        'Rate limit: 10 per hour per IP.',
      ].join('\n'),
      operationId: 'register',
      requestBody: jsonBody(registerSchema, { email: 'ada@example.com', password: 'a-strong-passphrase' }),
      responses: {
        '201': {
          description: 'Account created.',
          content: jsonContent(
            { type: 'object', required: ['user'], properties: { user: ref('User') } },
            { user: exampleUser },
          ),
        },
        '400': responseRef('ValidationError'),
        '409': errorResponse(
          'An account with this email already exists.',
          'CONFLICT',
          'An account with this email already exists',
        ),
      },
    },
  },

  '/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Sign in',
      description: [
        'Returns an access token and a refresh token and starts a new session.',
        '',
        'A wrong password, an unknown email and a locked account all return the same `401`, so the response never reveals whether an account exists.',
        'After 5 wrong passwords (configurable) the account locks for 15 minutes (configurable) and the owner is emailed. While locked, even the correct password is refused.',
        '`403 EMAIL_NOT_VERIFIED` is only returned when the server requires verified emails, and only after the correct password.',
        '',
        'Rate limit: 20 per 15 minutes per IP.',
      ].join('\n'),
      operationId: 'login',
      requestBody: jsonBody(loginSchema, { email: 'ada@example.com', password: 'a-strong-passphrase' }),
      responses: {
        '200': {
          description: 'Signed in.',
          headers: { 'Cache-Control': noStoreHeader },
          content: jsonContent(ref('AuthResponse'), {
            user: exampleUser,
            accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
            refreshToken: 'q3v0Yw2n8x5L1c9u7mHk4eZtB6sPdA0RfJgW_oNiXyE',
            tokenType: 'Bearer',
            expiresIn: 900,
          }),
        },
        '400': responseRef('ValidationError'),
        '401': errorResponse(
          'Wrong email or password, or the account is temporarily locked.',
          'UNAUTHORIZED',
          'Invalid email or password',
          { 'WWW-Authenticate': wwwAuthenticateHeader },
        ),
        '403': errorResponse(
          'The password was correct, but the email address is not verified yet.',
          'EMAIL_NOT_VERIFIED',
          'Please verify your email address before signing in',
        ),
      },
    },
  },

  '/auth/refresh': {
    post: {
      tags: ['Auth'],
      summary: 'Get a new access token',
      description: [
        'Exchanges a refresh token for a new access token **and a new refresh token**. The old refresh token stops working.',
        '',
        'If an old, already-used refresh token is presented again, it was copied or stolen: the whole session is revoked and the user must sign in again.',
        'A session ends for good 7 days after login (configurable), however often it is refreshed.',
        '',
        'Rate limit: 100 per 15 minutes per IP.',
      ].join('\n'),
      operationId: 'refreshToken',
      requestBody: jsonBody(refreshSchema, { refreshToken: 'q3v0Yw2n8x5L1c9u7mHk4eZtB6sPdA0RfJgW_oNiXyE' }),
      responses: {
        '200': {
          description: 'New token pair.',
          headers: { 'Cache-Control': noStoreHeader },
          content: jsonContent(ref('AuthResponse')),
        },
        '400': responseRef('ValidationError'),
        '401': errorResponse(
          'The refresh token is unknown, expired, already used or revoked.',
          'INVALID_REFRESH_TOKEN',
          'Invalid or expired refresh token',
          { 'WWW-Authenticate': wwwAuthenticateHeader },
        ),
      },
    },
  },

  '/auth/logout': {
    post: {
      tags: ['Auth'],
      summary: 'Sign out this session',
      description:
        'Ends the session that owns the refresh token. Other devices stay signed in. Idempotent: an unknown or already-revoked token also returns `204`, so nothing is revealed.',
      operationId: 'logout',
      requestBody: jsonBody(refreshSchema, { refreshToken: 'q3v0Yw2n8x5L1c9u7mHk4eZtB6sPdA0RfJgW_oNiXyE' }),
      responses: {
        '204': { description: 'Signed out. No body.' },
        '400': responseRef('ValidationError'),
      },
    },
  },

  '/auth/logout-all': {
    post: {
      tags: ['Auth'],
      summary: 'Sign out everywhere',
      description:
        'Revokes every session of the signed-in user. Existing access tokens keep working until they expire (15 minutes by default).',
      operationId: 'logoutAll',
      security: bearer,
      responses: {
        '200': {
          description: 'All sessions revoked.',
          content: jsonContent(
            {
              type: 'object',
              required: ['sessionsRevoked'],
              properties: { sessionsRevoked: { type: 'integer' } },
            },
            { sessionsRevoked: 2 },
          ),
        },
        '401': responseRef('Unauthorized'),
      },
    },
  },

  '/auth/me': {
    get: {
      tags: ['Auth'],
      summary: 'Current user',
      operationId: 'getMe',
      security: bearer,
      responses: {
        '200': {
          description: 'The signed-in user.',
          content: jsonContent(
            { type: 'object', required: ['user'], properties: { user: ref('User') } },
            { user: exampleUser },
          ),
        },
        '401': responseRef('Unauthorized'),
      },
    },
  },

  '/auth/verify-email': {
    post: {
      tags: ['Account'],
      summary: 'Verify an email address',
      description: [
        'Confirms the address with the token from the verification email. Tokens are single-use and expire after 24 hours.',
        'An unknown, expired, used or wrong-type token returns `400 INVALID_TOKEN`.',
        '',
        'Rate limit: 10 per 15 minutes per IP.',
      ].join('\n'),
      operationId: 'verifyEmail',
      requestBody: jsonBody(verifyEmailSchema, { token: 'Zk3p0V8mQ1xT5nL2cYw7uHbE4sGdA9RfJ6oN_iXyMtU' }),
      responses: {
        '200': {
          description: 'Email verified.',
          content: jsonContent(
            { type: 'object', required: ['user'], properties: { user: ref('User') } },
            { user: { ...exampleUser, emailVerified: true } },
          ),
        },
        '400': responseRef('ValidationError'),
      },
    },
  },

  '/auth/resend-verification': {
    post: {
      tags: ['Account'],
      summary: 'Send a new verification email',
      description: [
        'Always answers `202` with the same body, whether or not the account exists or is already verified, so it cannot be used to find out who has an account. The email is sent after the response.',
        'A new link invalidates the previous one.',
        '',
        'Rate limit: 10 per hour per IP and 3 per hour per email address.',
      ].join('\n'),
      operationId: 'resendVerification',
      requestBody: jsonBody(emailOnlySchema, { email: 'ada@example.com' }),
      responses: {
        '202': genericAccepted('Accepted. An email is sent if there is an unverified account for this address.'),
        '400': responseRef('ValidationError'),
      },
    },
  },

  '/auth/forgot-password': {
    post: {
      tags: ['Account'],
      summary: 'Request a password reset email',
      description: [
        'Always answers `202` with the same body, whether or not the account exists. The email is sent after the response, so response time reveals nothing either.',
        'The link expires after 60 minutes, can be used once, and a newer link invalidates the older one.',
        '',
        'Rate limit: 10 per hour per IP and 3 per hour per email address.',
      ].join('\n'),
      operationId: 'forgotPassword',
      requestBody: jsonBody(emailOnlySchema, { email: 'ada@example.com' }),
      responses: {
        '202': genericAccepted('Accepted. A reset email is sent if the account exists.'),
        '400': responseRef('ValidationError'),
      },
    },
  },

  '/auth/reset-password': {
    post: {
      tags: ['Account'],
      summary: 'Set a new password',
      description: [
        'Sets a new password using the token from the reset email.',
        '',
        'Afterwards the user is signed out on every device, any account lockout is lifted, the email address counts as verified, and the owner gets a "password changed" email.',
        'A weak new password is rejected with `400 VALIDATION_ERROR` without using up the token.',
        '',
        'Rate limit: 10 per 15 minutes per IP.',
      ].join('\n'),
      operationId: 'resetPassword',
      requestBody: jsonBody(resetPasswordSchema, {
        token: 'Zk3p0V8mQ1xT5nL2cYw7uHbE4sGdA9RfJ6oN_iXyMtU',
        password: 'a-new-strong-passphrase',
      }),
      responses: {
        '200': {
          description: 'Password changed.',
          content: jsonContent(ref('Message'), { message: 'Password updated. Please sign in again.' }),
        },
        '400': responseRef('ValidationError'),
      },
    },
  },

  '/admin/users': {
    get: {
      tags: ['Admin'],
      summary: 'List users',
      description: 'Oldest accounts first. Requires the `ADMIN` role.',
      operationId: 'listUsers',
      security: bearer,
      parameters: parametersFrom(listUsersQuerySchema, 'query', {
        page: '1-based page number.',
        limit: 'Users per page.',
      }),
      responses: {
        '200': {
          description: 'One page of users.',
          content: jsonContent(ref('UserPage'), { users: [exampleUser], page: 1, limit: 20, total: 1 }),
        },
        '400': responseRef('ValidationError'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
      },
    },
  },

  '/admin/users/{id}/role': {
    patch: {
      tags: ['Admin'],
      summary: "Change a user's role",
      description: [
        "Requires the `ADMIN` role. An admin can't change their own role, so the last admin can't lock everyone out.",
        "Changing a role signs the user out everywhere; the new role applies to the tokens they get next. Setting the role a user already has does nothing.",
      ].join('\n'),
      operationId: 'changeUserRole',
      security: bearer,
      parameters: parametersFrom(userIdParamSchema, 'path', { id: 'Id of the user to change.' }),
      requestBody: jsonBody(changeRoleSchema, { role: 'ADMIN' }),
      responses: {
        '200': {
          description: 'The updated user.',
          content: jsonContent(
            { type: 'object', required: ['user'], properties: { user: ref('User') } },
            { user: { ...exampleUser, role: 'ADMIN' } },
          ),
        },
        '400': responseRef('ValidationError'),
        '401': responseRef('Unauthorized'),
        '403': errorResponse(
          'Not an admin, or an admin trying to change their own role.',
          'FORBIDDEN',
          'You cannot change your own role',
        ),
        '404': responseRef('NotFound'),
      },
    },
  },
};

// Every route except /health sits behind the global rate limit, so any of them can answer 429.
for (const [path, item] of Object.entries(paths)) {
  if (path === '/health' || !item) continue;
  for (const method of ['get', 'post', 'patch'] as const) {
    const operation = item[method];
    if (operation) {
      operation.responses['429'] ??= responseRef('TooManyRequests');
    }
  }
}

// ---- document ------------------------------------------------------------------------------

const description = [
  'Reusable authentication and authorization API: registration, email verification, JWT access tokens with rotating refresh tokens, password reset, role-based access control and abuse protection.',
  '',
  '## Using the API',
  '1. `POST /auth/register`, then open the link in the verification email (`POST /auth/verify-email`).',
  '2. `POST /auth/login` returns an `accessToken` (a short-lived JWT) and a `refreshToken` (opaque, single-use).',
  '3. Send `Authorization: Bearer <accessToken>` on protected routes. The **Authorize** button above does this for you.',
  '4. When the access token expires, call `POST /auth/refresh`. Each refresh returns a new refresh token and invalidates the old one; replaying an old one ends the whole session.',
  '',
  '## Errors',
  'Every error has the same shape: `{ "error": { "code", "message", "details"? } }`. `code` is stable and meant for programs; `message` is for people. Unknown fields in request bodies are ignored.',
  '',
  '## Rate limiting',
  'Limits are per client IP, and per email address on the endpoints that send email. When one is exceeded the API answers `429` with a `Retry-After` header. Limited routes also send `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`.',
].join('\n');

function buildOpenApiDocument(): OpenAPIV3.Document {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Auth Service API',
      version: API_VERSION,
      description,
      license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
    },
    servers: [{ url: '/', description: 'This server' }],
    tags: [
      { name: 'Health', description: 'Liveness check.' },
      { name: 'Auth', description: 'Register, sign in, refresh and sign out.' },
      { name: 'Account', description: 'Email verification and password reset.' },
      { name: 'Admin', description: 'User management. Requires the `ADMIN` role.' },
    ],
    paths,
    components: {
      schemas,
      responses,
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'The `accessToken` from `POST /auth/login` or `POST /auth/refresh`.',
        },
      },
    },
  };
}

let cached: OpenAPIV3.Document | undefined;

/** Built once and reused: the document never changes while the process runs. */
export function getOpenApiDocument(): OpenAPIV3.Document {
  cached ??= buildOpenApiDocument();
  return cached;
}
