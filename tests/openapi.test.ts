import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { OpenAPIV3 } from 'openapi-types';
import request from 'supertest';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { getOpenApiDocument } from '../src/docs/openapi';
import { setEmailSender, type EmailMessage, type EmailSender } from '../src/services/email.service';
import { MemoryRateLimitStore, setRateLimitStore } from '../src/services/rateLimitStore';
import { waitForBackgroundTasks } from '../src/utils/background';
import { createFakePrisma } from './helpers/fakePrisma';

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

type Method = 'get' | 'post' | 'patch';
const METHODS: Method[] = ['get', 'post', 'patch'];

const app = createApp();
const outbox = new Outbox();
const password = 'a-strong-passphrase';
const unknownId = '3f1c2b7e-8a4d-4c55-9a66-1d2e3f4a5b6c';

const clone = <T>(value: T): T => structuredClone(value);
const tokenFrom = (message: EmailMessage | undefined): string =>
  /token=([\w-]+)/.exec(message?.text ?? '')?.[1] ?? '';

beforeEach(() => {
  mockPrisma.reset();
  outbox.sent.length = 0;
  setEmailSender(outbox);
});

afterAll(() => {
  setEmailSender(undefined);
});

// ---- the document itself --------------------------------------------------------------------

describe('OpenAPI document', () => {
  it('is a valid OpenAPI 3 document with every reference resolvable', async () => {
    const parsed = await SwaggerParser.validate(clone(getOpenApiDocument()) as never);

    expect(parsed).toMatchObject({ openapi: '3.0.3', info: { title: 'Auth Service API' } });
  });

  it('gives every operation a unique id, a summary and a tag', () => {
    const operations = Object.values(getOpenApiDocument().paths).flatMap((item) =>
      METHODS.flatMap((method) => item?.[method] ?? []),
    );
    const ids = operations.map((operation) => operation.operationId);

    expect(operations.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const operation of operations) {
      expect(operation.operationId).toBeTruthy();
      expect(operation.summary).toBeTruthy();
      expect(operation.tags?.length).toBeGreaterThan(0);
    }
  });

  it('takes request limits from the zod schemas that enforce them', () => {
    const register = getOpenApiDocument().paths['/auth/register']?.post?.requestBody as OpenAPIV3.RequestBodyObject;
    const body = register.content['application/json']?.schema as OpenAPIV3.SchemaObject;
    const password = body.properties?.password as OpenAPIV3.SchemaObject;
    const limit = (
      getOpenApiDocument().paths['/admin/users']?.get?.parameters as OpenAPIV3.ParameterObject[]
    ).find((p) => p.name === 'limit')?.schema as OpenAPIV3.SchemaObject;

    expect(password).toMatchObject({ minLength: 10, maxLength: 128 });
    expect(body.required).toEqual(['email', 'password']);
    expect(body).not.toHaveProperty('additionalProperties');
    expect(limit).toMatchObject({ minimum: 1, maximum: 100, default: 20 });
  });
});

// ---- the docs match the routes ---------------------------------------------------------------

interface Layer {
  name: string;
  regexp: RegExp;
  route?: { path: string; methods: Record<string, boolean> };
  handle: { stack?: Layer[] };
}

/** Express 4 keeps the mount path of a router only inside a regular expression. */
function mountPrefix(layer: Layer): string {
  const match = /^\^((?:\\\/[\w-]+)+)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
  return match?.[1]?.replace(/\\\//g, '/') ?? '';
}

function collectRoutes(stack: Layer[], prefix = ''): string[] {
  return stack.flatMap((layer) => {
    const { route } = layer;
    if (route) {
      return Object.keys(route.methods).map((method) => `${method.toUpperCase()} ${prefix}${route.path}`);
    }
    if (layer.name === 'router' && layer.handle.stack) {
      return collectRoutes(layer.handle.stack, prefix + mountPrefix(layer));
    }
    return [];
  });
}

const toOpenApiPath = (path: string): string => path.replace(/:(\w+)/g, '{$1}');

describe('documentation matches the routes', () => {
  const actual = collectRoutes((app as unknown as { _router: { stack: Layer[] } })._router.stack)
    .map((route) => {
      const [method = '', path = ''] = route.split(' ');
      return `${method} ${toOpenApiPath(path)}`;
    })
    .filter((route) => route !== 'GET /openapi.json') // serves the spec itself
    .sort();

  const documented = Object.entries(getOpenApiDocument().paths)
    .flatMap(([path, item]) =>
      METHODS.filter((method) => item?.[method]).map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();

  it('finds the routes it is supposed to compare', () => {
    expect(actual.length).toBeGreaterThanOrEqual(13);
    expect(actual).toContain('POST /auth/login');
    expect(actual).toContain('PATCH /admin/users/{id}/role');
  });

  it('documents every route, and documents nothing that does not exist', () => {
    expect(documented).toEqual(actual);
  });

  it('marks exactly the protected routes as needing a bearer token', async () => {
    const doc = getOpenApiDocument();
    const secured = Object.entries(doc.paths).flatMap(([path, item]) =>
      METHODS.filter((method) => item?.[method]?.security?.length).map((method) => ({ method, path })),
    );

    expect(secured.map((s) => `${s.method} ${s.path}`).sort()).toEqual([
      'get /admin/users',
      'get /auth/me',
      'patch /admin/users/{id}/role',
      'post /auth/logout-all',
    ]);

    // ...and the server really does refuse them without a token.
    for (const { method, path } of secured) {
      const res = await request(app)[method](path.replace('{id}', unknownId));
      expect(`${method} ${path} -> ${res.status}`).toBe(`${method} ${path} -> 401`);
    }
  });
});

// ---- real responses match the documented ones ------------------------------------------------

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

let resolved: OpenAPIV3.Document;

beforeAll(async () => {
  resolved = (await SwaggerParser.dereference(clone(getOpenApiDocument()) as never)) as OpenAPIV3.Document;
});

/** Checks the real response against what the spec promises: status, headers and JSON body. */
function expectDocumented(method: Method, path: string, res: request.Response, expectedStatus: number): void {
  expect(res.status).toBe(expectedStatus);

  const operation = resolved.paths[path]?.[method];
  const documented = operation?.responses[String(res.status)] as OpenAPIV3.ResponseObject | undefined;
  if (!documented) {
    throw new Error(`${method.toUpperCase()} ${path} answered ${res.status}, which the spec does not list`);
  }

  for (const header of Object.keys(documented.headers ?? {})) {
    expect(`${header}: ${res.headers[header.toLowerCase()] ?? '(missing)'}`).not.toMatch(/\(missing\)$/);
  }

  const schema = documented.content?.['application/json']?.schema;
  if (!schema) {
    expect(res.text).toBe('');
    return;
  }
  const validate = ajv.compile(schema);
  if (!validate(res.body)) {
    throw new Error(
      `${method.toUpperCase()} ${path} ${res.status}: body does not match the spec (${ajv.errorsText(
        validate.errors,
      )})\n${JSON.stringify(res.body)}`,
    );
  }
}

async function signUp(email: string, role: 'USER' | 'ADMIN' = 'USER') {
  await request(app).post('/auth/register').send({ email, password });
  await waitForBackgroundTasks();
  const row = mockPrisma.users.find((u) => u.email === email);
  if (row) row.role = role;
  const res = await request(app).post('/auth/login').send({ email, password });
  return {
    id: row?.id ?? '',
    accessToken: res.body.accessToken as string,
    refreshToken: res.body.refreshToken as string,
  };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('real responses match the documentation', () => {
  it('health', async () => {
    expectDocumented('get', '/health', await request(app).get('/health'), 200);
  });

  it('register: 201, 409 and 400', async () => {
    const body = { email: 'ada@example.com', password };

    expectDocumented('post', '/auth/register', await request(app).post('/auth/register').send(body), 201);
    expectDocumented('post', '/auth/register', await request(app).post('/auth/register').send(body), 409);
    expectDocumented('post', '/auth/register', await request(app).post('/auth/register').send({}), 400);
  });

  it('login: 200, 401 and 400', async () => {
    await signUp('ada@example.com');

    const ok = await request(app).post('/auth/login').send({ email: 'ada@example.com', password });
    const wrong = await request(app).post('/auth/login').send({ email: 'ada@example.com', password: 'nope-nope-nope' });
    const bad = await request(app).post('/auth/login').send({ email: 'not-an-email' });

    expectDocumented('post', '/auth/login', ok, 200);
    expectDocumented('post', '/auth/login', wrong, 401);
    expectDocumented('post', '/auth/login', bad, 400);
  });

  it('login: 403 when the server requires a verified email', async () => {
    await signUp('ada@example.com');
    env.REQUIRE_EMAIL_VERIFICATION = true;
    try {
      const res = await request(app).post('/auth/login').send({ email: 'ada@example.com', password });
      expectDocumented('post', '/auth/login', res, 403);
    } finally {
      env.REQUIRE_EMAIL_VERIFICATION = false;
    }
  });

  it('me, refresh, logout and logout-all', async () => {
    const session = await signUp('ada@example.com');

    expectDocumented('get', '/auth/me', await request(app).get('/auth/me').set(bearer(session.accessToken)), 200);
    expectDocumented('get', '/auth/me', await request(app).get('/auth/me'), 401);

    const refreshed = await request(app).post('/auth/refresh').send({ refreshToken: session.refreshToken });
    expectDocumented('post', '/auth/refresh', refreshed, 200);
    expectDocumented(
      'post',
      '/auth/refresh',
      await request(app).post('/auth/refresh').send({ refreshToken: 'made-up-token' }),
      401,
    );
    expectDocumented('post', '/auth/refresh', await request(app).post('/auth/refresh').send({}), 400);

    expectDocumented(
      'post',
      '/auth/logout-all',
      await request(app).post('/auth/logout-all').set(bearer(session.accessToken)),
      200,
    );
    expectDocumented(
      'post',
      '/auth/logout',
      await request(app).post('/auth/logout').send({ refreshToken: refreshed.body.refreshToken }),
      204,
    );
    expectDocumented('post', '/auth/logout', await request(app).post('/auth/logout').send({}), 400);
  });

  it('verify-email: 200, then 400 for the used token', async () => {
    await request(app).post('/auth/register').send({ email: 'ada@example.com', password });
    await waitForBackgroundTasks();
    const token = tokenFrom(outbox.sent[0]);
    expect(token).not.toBe('');

    const ok = await request(app).post('/auth/verify-email').send({ token });
    expectDocumented('post', '/auth/verify-email', ok, 200);
    expect(ok.body.user.emailVerified).toBe(true);
    expectDocumented('post', '/auth/verify-email', await request(app).post('/auth/verify-email').send({ token }), 400);
  });

  it('resend-verification and forgot-password: 202 for any email, 400 for junk', async () => {
    await signUp('ada@example.com');

    for (const path of ['/auth/resend-verification', '/auth/forgot-password'] as const) {
      const known = await request(app).post(path).send({ email: 'ada@example.com' });
      const unknown = await request(app).post(path).send({ email: 'nobody@example.com' });

      expectDocumented('post', path, known, 202);
      expectDocumented('post', path, unknown, 202);
      expect(unknown.body).toEqual(known.body);
      expectDocumented('post', path, await request(app).post(path).send({ email: 'nope' }), 400);
    }
  });

  it('reset-password: 200, 400 for a bad token and 400 for a weak password', async () => {
    await signUp('ada@example.com');
    outbox.sent.length = 0;
    await request(app).post('/auth/forgot-password').send({ email: 'ada@example.com' });
    await waitForBackgroundTasks();
    const token = tokenFrom(outbox.sent[0]);
    expect(token).not.toBe('');

    expectDocumented(
      'post',
      '/auth/reset-password',
      await request(app).post('/auth/reset-password').send({ token, password: 'short' }),
      400,
    );
    expectDocumented(
      'post',
      '/auth/reset-password',
      await request(app).post('/auth/reset-password').send({ token: 'made-up', password: 'a-new-strong-passphrase' }),
      400,
    );
    expectDocumented(
      'post',
      '/auth/reset-password',
      await request(app).post('/auth/reset-password').send({ token, password: 'a-new-strong-passphrase' }),
      200,
    );
  });

  it('admin: list, change role, and every documented error', async () => {
    const admin = await signUp('admin@example.com', 'ADMIN');
    const user = await signUp('user@example.com');

    const list = await request(app).get('/admin/users?page=1&limit=10').set(bearer(admin.accessToken));
    expectDocumented('get', '/admin/users', list, 200);
    expectDocumented('get', '/admin/users', await request(app).get('/admin/users?limit=1000').set(bearer(admin.accessToken)), 400);
    expectDocumented('get', '/admin/users', await request(app).get('/admin/users'), 401);
    expectDocumented('get', '/admin/users', await request(app).get('/admin/users').set(bearer(user.accessToken)), 403);

    const role = (id: string, token: string, body: object) =>
      request(app).patch(`/admin/users/${id}/role`).set(bearer(token)).send(body);
    const path = '/admin/users/{id}/role';

    expectDocumented('patch', path, await role(user.id, admin.accessToken, { role: 'ADMIN' }), 200);
    expectDocumented('patch', path, await role('not-a-uuid', admin.accessToken, { role: 'ADMIN' }), 400);
    expectDocumented('patch', path, await role(admin.id, admin.accessToken, { role: 'USER' }), 403);
    expectDocumented('patch', path, await role(unknownId, admin.accessToken, { role: 'USER' }), 404);
    expectDocumented('patch', path, await request(app).patch(`/admin/users/${unknownId}/role`).send({ role: 'USER' }), 401);
  });

  it('rate limit: 429 with the documented headers and body', async () => {
    env.RATE_LIMIT_ENABLED = true;
    setRateLimitStore(new MemoryRateLimitStore());
    try {
      let last: request.Response | undefined;
      // Invalid bodies are cheap, and the limiter counts a request before it is validated.
      for (let i = 0; i < 21; i += 1) {
        last = await request(app).post('/auth/login').send({});
      }
      if (!last) throw new Error('no response');

      expectDocumented('post', '/auth/login', last, 429);
      expect(last.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    } finally {
      env.RATE_LIMIT_ENABLED = false;
      setRateLimitStore(undefined);
    }
  });
});

// ---- serving the docs -------------------------------------------------------------------------

describe('serving the documentation', () => {
  it('serves the spec as JSON at /openapi.json', async () => {
    const res = await request(app).get('/openapi.json');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.openapi).toBe('3.0.3');
    expect(Object.keys(res.body.paths)).toContain('/auth/login');
  });

  it('serves Swagger UI at /docs without needing a CDN', async () => {
    const res = await request(app).get('/docs/');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('swagger-ui');
    expect(res.text).not.toMatch(/https?:\/\/(?:unpkg|cdn)/);
  });

  describe('switching the docs on and off', () => {
    const original = { docs: env.API_DOCS_ENABLED, node: env.NODE_ENV };

    afterEach(() => {
      env.API_DOCS_ENABLED = original.docs;
      env.NODE_ENV = original.node;
    });

    const statuses = async () => {
      const instance = createApp(); // reads the settings when it is created
      return [(await request(instance).get('/openapi.json')).status, (await request(instance).get('/docs/')).status];
    };

    it('is on by default outside production', async () => {
      env.API_DOCS_ENABLED = undefined;
      env.NODE_ENV = 'development';

      expect(await statuses()).toEqual([200, 200]);
    });

    it('is off by default in production', async () => {
      env.API_DOCS_ENABLED = undefined;
      env.NODE_ENV = 'production';

      expect(await statuses()).toEqual([404, 404]);
    });

    it('can be published in production on purpose', async () => {
      env.API_DOCS_ENABLED = true;
      env.NODE_ENV = 'production';

      expect(await statuses()).toEqual([200, 200]);
    });

    it('can be switched off anywhere', async () => {
      env.API_DOCS_ENABLED = false;
      env.NODE_ENV = 'development';

      expect(await statuses()).toEqual([404, 404]);
    });
  });
});
