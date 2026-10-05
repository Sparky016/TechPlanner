import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Modules below read config at load time (db pool); give them a valid environment first. No connection is made.
vi.hoisted(() => {
  Object.assign(process.env, {
    ATLASSIAN_CLIENT_ID: 'client-id',
    ATLASSIAN_CLIENT_SECRET: 'client-secret',
    ATLASSIAN_CLOUD_ID: 'cloud-id',
    OAUTH_REDIRECT_URI: 'http://localhost:3000/auth/callback',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    DATABASE_URL: 'postgres://techplanner:techplanner@localhost:5432/techplanner_t13',
    COPILOT_GITHUB_TOKEN: 'ghp_x',
    FACILITATOR_MODEL: 'model-a',
    EVALUATOR_MODEL: 'model-b',
    CONFLUENCE_SPACE_KEY: 'ENG',
    CONFLUENCE_PARENT_PAGE_ID: '12345',
    APP_BASE_URL: 'http://localhost:3000',
  });
});

vi.mock('@/server/auth/session', () => ({ getCurrentUser: vi.fn() }));
vi.mock('@/server/audit/audit', () => ({ recordAudit: vi.fn() }));

import { GET as csrfRoute } from '@/app/api/csrf/route';
import { recordAudit } from '@/server/audit/audit';
import { getCurrentUser } from '@/server/auth/session';
import { ReauthRequiredError } from '@/server/auth/tokens';
import { resetConfigForTests } from '@/server/config';
import { HttpError } from '@/server/http/errors';
import { getCorrelationId } from '@/server/observability/context';
import { logger } from '@/server/observability/logger';
import { httpRequestDuration } from '@/server/observability/metrics';
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken, verifyCsrf } from './csrf';
import { withApiHandler } from './handler';

const BASE = 'http://localhost:3000';
const USER = { accountId: 'acc-1', displayName: 'Ada' };
const TOKEN = issueCsrfToken().token;
const OTHER_TOKEN = issueCsrfToken().token;

const getCurrentUserMock = vi.mocked(getCurrentUser);
const recordAuditMock = vi.mocked(recordAudit);
const noParams = { params: Promise.resolve({}) };

function request(method: string, init: { path?: string; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest(`${BASE}${init.path ?? '/api/thing'}`, {
    method,
    headers: init.headers,
  });
}

const CSRF_OK: Record<string, string> = {
  origin: BASE,
  cookie: `${CSRF_COOKIE}=${TOKEN}`,
  [CSRF_HEADER]: TOKEN,
};

function validPost(): NextRequest {
  return request('POST', { headers: CSRF_OK });
}

const ok = withApiHandler({}, async ({ user }) => Response.json({ hello: user?.displayName ?? null }));

beforeEach(() => {
  resetConfigForTests();
  getCurrentUserMock.mockReset().mockResolvedValue(USER);
  recordAuditMock.mockReset().mockResolvedValue({ id: '1', hash: 'h' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CSRF (AC1)', () => {
  it('returns the handler response when token and Origin are valid', async () => {
    const res = await ok(validPost(), noParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: 'Ada' });
  });

  it.each([
    ['no header token', { cookie: `${CSRF_COOKIE}=${TOKEN}`, origin: BASE }],
    ['no cookie token', { [CSRF_HEADER]: TOKEN, origin: BASE }],
    [
      'mismatched tokens',
      {
        cookie: `${CSRF_COOKIE}=${TOKEN}`,
        [CSRF_HEADER]: OTHER_TOKEN,
        origin: BASE,
      },
    ],
    ['malformed tokens', { cookie: `${CSRF_COOKIE}=abc`, [CSRF_HEADER]: 'abc', origin: BASE }],
  ])('returns 403 with %s', async (_label, headers) => {
    const res = await ok(request('POST', { headers }), noParams);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('csrf_token');
    expect(body.error.correlationId).toBe(res.headers.get('x-correlation-id'));
  });

  it.each([
    ['a foreign Origin', { origin: 'https://evil.example' }],
    ['a different port', { origin: 'http://localhost:4000' }],
    ['Origin null', { origin: 'null' }],
    ['a foreign Referer and no Origin', { referer: 'https://evil.example/page' }],
  ])('returns 403 with %s even when tokens match', async (_label, extra) => {
    const headers: Record<string, string> = {
      cookie: `${CSRF_COOKIE}=${TOKEN}`,
      [CSRF_HEADER]: TOKEN,
      ...extra,
    };
    const res = await ok(request('POST', { headers }), noParams);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('csrf_origin');
  });

  it('rejects a request carrying neither Origin nor Referer', async () => {
    const res = await ok(
      request('DELETE', {
        headers: { cookie: `${CSRF_COOKIE}=${TOKEN}`, [CSRF_HEADER]: TOKEN },
      }),
      noParams,
    );
    expect(res.status).toBe(403);
  });

  it('accepts a same-origin Referer when Origin is absent', async () => {
    const headers = {
      referer: `${BASE}/sessions/1`,
      cookie: `${CSRF_COOKIE}=${TOKEN}`,
      [CSRF_HEADER]: TOKEN,
    };
    expect((await ok(request('PUT', { headers }), noParams)).status).toBe(200);
  });

  it('checks CSRF before authentication and never calls the handler', async () => {
    const handler = vi.fn();
    const wrapped = withApiHandler({}, handler);
    const res = await wrapped(request('POST', { headers: { origin: BASE } }), noParams);
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(getCurrentUserMock).not.toHaveBeenCalled();
  });

  it('skips CSRF for GET/HEAD by default, and honours csrf:false / csrf:true overrides', async () => {
    expect((await ok(request('GET'), noParams)).status).toBe(200);
    expect((await ok(request('HEAD'), noParams)).status).toBe(200);
    const off = withApiHandler({ csrf: false }, async () => new Response(null, { status: 204 }));
    expect((await off(request('POST'), noParams)).status).toBe(204);
    const on = withApiHandler({ csrf: true }, async () => new Response(null, { status: 204 }));
    expect((await on(request('GET'), noParams)).status).toBe(403);
  });

  it('verifyCsrf throws HttpError 403', () => {
    expect(() => verifyCsrf(request('POST'))).toThrow(HttpError);
  });

  it('GET /api/csrf returns a token and sets a matching tp_csrf cookie that passes verification', async () => {
    const res = await csrfRoute(request('GET', { path: '/api/csrf' }), noParams);
    expect(res.status).toBe(200);
    const { token } = await res.json();
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${CSRF_COOKIE}=${token}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(() =>
      verifyCsrf(
        request('POST', {
          headers: {
            origin: BASE,
            cookie: `${CSRF_COOKIE}=${token}`,
            [CSRF_HEADER]: token,
          },
        }),
      ),
    ).not.toThrow();
  });

  it('GET /api/csrf requires authentication', async () => {
    getCurrentUserMock.mockResolvedValue(null);
    expect((await csrfRoute(request('GET', { path: '/api/csrf' }), noParams)).status).toBe(401);
  });
});

describe('authentication and error mapping (AC2)', () => {
  it('returns 401 unauthenticated with correlationId when no user', async () => {
    getCurrentUserMock.mockResolvedValue(null);
    const handler = vi.fn();
    const res = await withApiHandler({}, handler)(request('GET'), noParams);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        message: 'Not authenticated',
        code: 'unauthenticated',
        correlationId: expect.any(String),
      },
    });
    expect(body.error.correlationId).toBe(res.headers.get('x-correlation-id'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('allows anonymous access when auth:false and passes user null', async () => {
    getCurrentUserMock.mockResolvedValue(null);
    const res = await withApiHandler({ auth: false }, async ({ user }) => Response.json({ user }))(
      request('GET'),
      noParams,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });

  it('maps ReauthRequiredError to 401 reauth_required', async () => {
    const res = await withApiHandler({}, async () => {
      throw new ReauthRequiredError();
    })(request('GET'), noParams);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('reauth_required');
    expect(body.error.correlationId).toBe(res.headers.get('x-correlation-id'));
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it('maps HttpError to its status and code', async () => {
    const res = await withApiHandler({}, async () => {
      throw new HttpError(409, 'Locked by someone else', 'locked');
    })(request('GET'), noParams);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({
      message: 'Locked by someone else',
      code: 'locked',
    });
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it('maps zod errors to 400 with a field list', async () => {
    const schema = z.object({
      title: z.string().min(1),
      nested: z.object({ n: z.number() }),
    });
    const res = await withApiHandler({}, async () => {
      schema.parse({ title: '', nested: { n: 'x' } });
      return new Response();
    })(request('GET'), noParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.correlationId).toEqual(expect.any(String));
    expect(body.error.fields.map((f: { path: string }) => f.path).sort()).toEqual(['nested.n', 'title']);
  });

  it('passes resolved params, user and correlation id to the handler and runs it in context', async () => {
    let seen: unknown;
    const res = await withApiHandler<{ id: string }>({}, async (ctx) => {
      seen = {
        params: ctx.params,
        user: ctx.user,
        cid: ctx.correlationId,
        ctxCid: getCorrelationId(),
      };
      return new Response(null, { status: 204 });
    })(request('GET', { path: '/api/sessions/abc' }), {
      params: Promise.resolve({ id: 'abc' }),
    });
    const cid = res.headers.get('x-correlation-id');
    expect(seen).toEqual({
      params: { id: 'abc' },
      user: USER,
      cid,
      ctxCid: cid,
    });
  });

  it('sets x-correlation-id even on immutable redirect responses', async () => {
    const res = await withApiHandler({}, async () => Response.redirect(`${BASE}/elsewhere`, 303))(
      request('GET'),
      noParams,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/elsewhere`);
    expect(res.headers.get('x-correlation-id')).toEqual(expect.any(String));
  });
});

describe('unhandled errors (AC3)', () => {
  it('returns a generic 500, logs the stack and writes one error audit record with the correlation id', async () => {
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const boom = new Error('db password is hunter2');
    const res = await withApiHandler<{ id: string }>({}, async () => {
      throw boom;
    })(request('POST', { path: '/api/sessions/s-1', headers: CSRF_OK }), {
      params: Promise.resolve({ id: 's-1' }),
    });

    expect(res.status).toBe(500);
    const header = res.headers.get('x-correlation-id');
    expect(header).toEqual(expect.any(String));
    const body = await res.json();
    expect(body).toEqual({
      error: {
        message: 'Unexpected error',
        code: 'internal_error',
        correlationId: header,
      },
    });
    expect(JSON.stringify(body)).not.toContain('hunter2');

    expect(recordAuditMock).toHaveBeenCalledTimes(1);
    expect(recordAuditMock).toHaveBeenCalledWith({
      action: 'error',
      result: 'failure',
      userId: 'acc-1',
      userDisplayName: 'Ada',
      details: {
        route: '/api/sessions/[id]',
        status: 500,
        code: 'internal_error',
        correlationId: header,
      },
      correlationId: header,
    });
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ err: boom }), expect.any(String));
  });

  it('still returns 500 with correlationId when the audit write itself fails', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    recordAuditMock.mockRejectedValue(new Error('database down'));
    const res = await withApiHandler({}, async () => {
      throw new Error('x');
    })(request('GET'), noParams);
    expect(res.status).toBe(500);
    expect((await res.json()).error.correlationId).toBe(res.headers.get('x-correlation-id'));
  });

  it('returns 500 when the session lookup fails', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    getCurrentUserMock.mockRejectedValue(new Error('pool exhausted'));
    const res = await ok(request('GET'), noParams);
    expect(res.status).toBe(500);
    expect(recordAuditMock).toHaveBeenCalledTimes(1);
  });

  it('observes http_request_duration_seconds with a templated route label', async () => {
    await withApiHandler<{ id: string }>({}, async () => new Response(null, { status: 204 }))(
      request('GET', { path: '/api/sessions/1b2c' }),
      {
        params: Promise.resolve({ id: '1b2c' }),
      },
    );
    const metric = await httpRequestDuration.get();
    const count = metric.values.find(
      (v) =>
        v.metricName === 'http_request_duration_seconds_count' &&
        v.labels.route === '/api/sessions/[id]' &&
        v.labels.method === 'GET' &&
        v.labels.status === '204',
    );
    expect(count?.value).toBeGreaterThanOrEqual(1);
  });
});
