import { resetDatabase } from './setup';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as callbackGET } from '@/app/auth/callback/route';
import { GET as loginGET } from '@/app/auth/login/route';
import { POST as logoutPOST } from '@/app/auth/logout/route';
import {
  ACCESSIBLE_RESOURCES_URL,
  AUTHORIZE_URL,
  ME_URL,
  OAUTH_SCOPES,
  TOKEN_URL,
  codeChallengeFor,
} from '@/server/auth/atlassianOAuth';
import { SESSION_COOKIE, getCurrentUser, hashSessionId, requireUser } from '@/server/auth/session';
import { ReauthRequiredError, getValidAccessToken } from '@/server/auth/tokens';
import { getConfig } from '@/server/config';
import { decryptSecret, encryptSecret } from '@/server/crypto/secrets';
import { db, query } from '@/server/db/pool';
import { HttpError } from '@/server/http/errors';

// Atlassian is mocked by stubbing global fetch (undici is not a direct dependency of this project).
interface MockState {
  calls: { authCode: number; refresh: number; resources: number; me: number };
  tokenStatus: number;
  refreshStatus: number;
  refreshDelayMs: number;
  resources: { id: string; url: string; name: string }[];
  refreshBodies: Record<string, string>[];
  issued: number;
}

let mock: MockState;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function atlassianFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url === TOKEN_URL && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    if (body.grant_type === 'authorization_code') {
      mock.calls.authCode += 1;
      if (mock.tokenStatus !== 200) return json({ error: 'invalid_grant' }, mock.tokenStatus);
      return json({
        access_token: 'access-initial',
        refresh_token: 'refresh-initial',
        expires_in: 3600,
        scope: OAUTH_SCOPES.join(' '),
        token_type: 'Bearer',
      });
    }
    if (body.grant_type === 'refresh_token') {
      mock.calls.refresh += 1;
      mock.refreshBodies.push(body);
      await new Promise((r) => setTimeout(r, mock.refreshDelayMs));
      if (mock.refreshStatus !== 200) return json({ error: 'invalid_grant' }, mock.refreshStatus);
      mock.issued += 1;
      return json({
        access_token: `access-rotated-${mock.issued}`,
        refresh_token: `refresh-rotated-${mock.issued}`,
        expires_in: 3600,
        scope: OAUTH_SCOPES.join(' '),
        token_type: 'Bearer',
      });
    }
  }
  if (url === ACCESSIBLE_RESOURCES_URL) {
    mock.calls.resources += 1;
    return json(mock.resources);
  }
  if (url === ME_URL) {
    mock.calls.me += 1;
    return json({ account_id: 'acc-123', name: 'Ada Lovelace', email: 'ada@example.com' });
  }
  return json({ error: 'unexpected request' }, 599);
}

const base = () => getConfig().APP_BASE_URL;

function setCookies(response: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of response.headers.getSetCookie()) out.set(c.slice(0, c.indexOf('=')), c);
  return out;
}

function cookieValue(setCookie: string): string {
  return setCookie.slice(setCookie.indexOf('=') + 1, setCookie.indexOf(';'));
}

async function startLogin(): Promise<{ state: string; oauthCookie: string; authorizeUrl: URL }> {
  const response = await loginGET();
  const authorizeUrl = new URL(response.headers.get('location')!);
  const oauthCookie = setCookies(response).get('tp_oauth')!;
  return { state: authorizeUrl.searchParams.get('state')!, oauthCookie: cookieValue(oauthCookie), authorizeUrl };
}

async function callback(query: string, cookie?: string): Promise<Response> {
  const headers = cookie ? { cookie } : undefined;
  return callbackGET(new Request(`${base()}/auth/callback?${query}`, { headers }));
}

async function auditRows(action: string) {
  return query<{ user_id: string | null; result: string; details: Record<string, unknown> }>(
    'SELECT user_id, result, details FROM audit_record WHERE action = $1 ORDER BY id',
    [action],
  );
}

async function login(): Promise<string> {
  const { state, oauthCookie } = await startLogin();
  const response = await callback(`code=good-code&state=${state}`, `tp_oauth=${oauthCookie}`);
  return cookieValue(setCookies(response).get(SESSION_COOKIE)!);
}

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(() => {
  mock = {
    calls: { authCode: 0, refresh: 0, resources: 0, me: 0 },
    tokenStatus: 200,
    refreshStatus: 200,
    refreshDelayMs: 0,
    resources: [{ id: getConfig().ATLASSIAN_CLOUD_ID, url: 'https://example.atlassian.net', name: 'example' }],
    refreshBodies: [],
    issued: 0,
  };
  vi.stubGlobal('fetch', vi.fn(atlassianFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.end();
});

describe('GET /auth/login', () => {
  it('redirects to the Atlassian authorize URL with state, PKCE and the SR-1.3 scopes', async () => {
    const response = await loginGET();
    expect(response.status).toBe(302);
    const url = new URL(response.headers.get('location')!);
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
    expect(url.searchParams.get('audience')).toBe('api.atlassian.com');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toBe(OAUTH_SCOPES.join(' '));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const cookie = setCookies(response).get('tp_oauth')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=600/);
    const [state, verifier] = cookieValue(cookie).split('.');
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('code_challenge')).toBe(codeChallengeFor(verifier));
  });
});

describe('GET /auth/callback', () => {
  it('AC1: stores encrypted tokens, creates user and session, sets tp_session and audits auth.login', async () => {
    const { state, oauthCookie } = await startLogin();
    const response = await callback(`code=good-code&state=${state}`, `tp_oauth=${oauthCookie}`);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${base()}/sessions`);
    const cookies = setCookies(response);
    const session = cookies.get(SESSION_COOKIE)!;
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Path=\//);
    expect(session).toMatch(/Secure/);
    expect(cookieValue(session)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookies.get('tp_oauth')).toMatch(/Max-Age=0/);

    const [user] = await query('SELECT atlassian_account_id, display_name, email FROM app_user');
    expect(user).toEqual({ atlassian_account_id: 'acc-123', display_name: 'Ada Lovelace', email: 'ada@example.com' });

    const [token] = await query<{ enc_access_token: Buffer; enc_refresh_token: Buffer; scopes: string[] }>(
      'SELECT enc_access_token, enc_refresh_token, scopes FROM oauth_token WHERE user_id = $1',
      ['acc-123'],
    );
    expect(token.enc_access_token.includes(Buffer.from('access-initial'))).toBe(false);
    expect(token.enc_refresh_token.includes(Buffer.from('refresh-initial'))).toBe(false);
    expect(decryptSecret(token.enc_access_token)).toBe('access-initial');
    expect(decryptSecret(token.enc_refresh_token)).toBe('refresh-initial');
    expect(token.scopes).toEqual([...OAUTH_SCOPES]);

    const sessions = await query<{ id_hash: Buffer }>('SELECT id_hash FROM app_session WHERE user_id = $1', ['acc-123']);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id_hash.includes(Buffer.from(cookieValue(session)))).toBe(false);

    const logins = await auditRows('auth.login');
    expect(logins).toHaveLength(1);
    expect(logins[0]).toMatchObject({ user_id: 'acc-123', result: 'success' });
    const allDetails = JSON.stringify(await query('SELECT details FROM audit_record'));
    for (const secret of ['good-code', 'access-initial', 'refresh-initial', state, oauthCookie]) {
      expect(allDetails).not.toContain(secret);
    }

    const current = await getCurrentUser(new Request(base(), { headers: { cookie: `tp_session=${cookieValue(session)}` } }));
    expect(current).toEqual({ accountId: 'acc-123', displayName: 'Ada Lovelace' });
  });

  it('AC2: rejects a mismatched state without calling Atlassian and audits auth.failure', async () => {
    const before = (await auditRows('auth.failure')).length;
    const { oauthCookie } = await startLogin();
    const response = await callback('code=good-code&state=forged-state', `tp_oauth=${oauthCookie}`);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${base()}/login?error=state`);
    expect(setCookies(response).has(SESSION_COOKIE)).toBe(false);
    expect(mock.calls.authCode).toBe(0);
    const failures = await auditRows('auth.failure');
    expect(failures).toHaveLength(before + 1);
    expect(failures.at(-1)).toMatchObject({ result: 'failure', details: { reason: 'state_mismatch' } });
  });

  it('AC2: rejects a callback with no state cookie', async () => {
    const before = (await auditRows('auth.failure')).length;
    const { state } = await startLogin();
    const response = await callback(`code=good-code&state=${state}`);
    expect(response.headers.get('location')).toBe(`${base()}/login?error=state`);
    expect(mock.calls.authCode).toBe(0);
    expect(await auditRows('auth.failure')).toHaveLength(before + 1);
  });

  it('AC2: rejects a grant without ATLASSIAN_CLOUD_ID and audits site_not_granted', async () => {
    mock.resources = [{ id: 'some-other-cloud', url: 'https://other.atlassian.net', name: 'other' }];
    const before = (await auditRows('auth.failure')).length;
    const sessionsBefore = await query('SELECT 1 FROM app_session');
    const { state, oauthCookie } = await startLogin();
    const response = await callback(`code=good-code&state=${state}`, `tp_oauth=${oauthCookie}`);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${base()}/login?error=site`);
    expect(setCookies(response).has(SESSION_COOKIE)).toBe(false);
    expect(await query('SELECT 1 FROM app_session')).toHaveLength(sessionsBefore.length);
    const failures = await auditRows('auth.failure');
    expect(failures).toHaveLength(before + 1);
    expect(failures.at(-1)).toMatchObject({ result: 'failure', details: { reason: 'site_not_granted' } });
  });

  it('audits a failed code exchange', async () => {
    mock.tokenStatus = 400;
    const { state, oauthCookie } = await startLogin();
    const response = await callback(`code=bad-code&state=${state}`, `tp_oauth=${oauthCookie}`);
    expect(response.headers.get('location')).toBe(`${base()}/login?error=oauth`);
    const failures = await auditRows('auth.failure');
    expect(failures.at(-1)).toMatchObject({ details: { reason: 'token_exchange_failed' } });
  });
});

async function setExpiringToken(userId: string, refreshToken: string | null): Promise<void> {
  await query(
    `UPDATE oauth_token SET enc_access_token = $2, enc_refresh_token = $3, expires_at = now() + interval '30 seconds'
      WHERE user_id = $1`,
    [userId, encryptSecret('access-expiring'), refreshToken === null ? null : encryptSecret(refreshToken)],
  );
}

describe('getValidAccessToken', () => {
  it('returns a fresh token without refreshing', async () => {
    await login();
    expect(await getValidAccessToken('acc-123')).toBe('access-initial');
    expect(mock.calls.refresh).toBe(0);
  });

  it('AC3: refreshes an expiring token once under 10 concurrent calls and persists the rotated refresh token', async () => {
    await login();
    await setExpiringToken('acc-123', 'refresh-current');
    mock.refreshDelayMs = 200;

    const results = await Promise.all(Array.from({ length: 10 }, () => getValidAccessToken('acc-123')));

    expect(mock.calls.refresh).toBe(1);
    expect(mock.refreshBodies[0].refresh_token).toBe('refresh-current');
    expect(new Set(results)).toEqual(new Set(['access-rotated-1']));

    const [row] = await query<{ enc_access_token: Buffer; enc_refresh_token: Buffer; secs: number }>(
      `SELECT enc_access_token, enc_refresh_token, extract(epoch FROM expires_at - now())::int AS secs
         FROM oauth_token WHERE user_id = $1`,
      ['acc-123'],
    );
    expect(decryptSecret(row.enc_access_token)).toBe('access-rotated-1');
    expect(decryptSecret(row.enc_refresh_token)).toBe('refresh-rotated-1');
    expect(row.secs).toBeGreaterThan(3000);

    // Subsequent calls use the stored token.
    expect(await getValidAccessToken('acc-123')).toBe('access-rotated-1');
    expect(mock.calls.refresh).toBe(1);
  });

  it('AC4: refresh failure deletes the token row, audits auth.refresh_failed and throws ReauthRequiredError', async () => {
    await login();
    await setExpiringToken('acc-123', 'refresh-revoked');
    mock.refreshStatus = 400;
    const before = (await auditRows('auth.refresh_failed')).length;

    await expect(getValidAccessToken('acc-123')).rejects.toBeInstanceOf(ReauthRequiredError);

    expect(await query('SELECT 1 FROM oauth_token WHERE user_id = $1', ['acc-123'])).toHaveLength(0);
    const failures = await auditRows('auth.refresh_failed');
    expect(failures).toHaveLength(before + 1);
    expect(failures.at(-1)).toMatchObject({ user_id: 'acc-123', result: 'failure' });
    expect(JSON.stringify(failures.at(-1)!.details)).not.toContain('refresh-revoked');

    // No token row at all: still a re-auth, without another refresh attempt.
    await expect(getValidAccessToken('acc-123')).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(mock.calls.refresh).toBe(1);
  });
});

describe('POST /auth/logout', () => {
  it('AC5: deletes the session row, clears the cookie, audits auth.logout and the old cookie no longer authenticates', async () => {
    const value = await login();
    const asUser = () => new Request(`${base()}/auth/logout`, { method: 'POST', headers: { cookie: `tp_session=${value}` } });
    expect(await getCurrentUser(asUser())).toEqual({ accountId: 'acc-123', displayName: 'Ada Lovelace' });
    const sessionsBefore = (await query('SELECT 1 FROM app_session')).length;
    const logoutsBefore = (await auditRows('auth.logout')).length;

    const response = await logoutPOST(asUser());

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${base()}/login`);
    const cleared = setCookies(response).get(SESSION_COOKIE)!;
    expect(cleared).toMatch(/^tp_session=;/);
    expect(cleared).toMatch(/Max-Age=0/);
    expect(await query('SELECT 1 FROM app_session')).toHaveLength(sessionsBefore - 1);
    const logouts = await auditRows('auth.logout');
    expect(logouts).toHaveLength(logoutsBefore + 1);
    expect(logouts.at(-1)).toMatchObject({ user_id: 'acc-123', result: 'success' });

    expect(await getCurrentUser(asUser())).toBeNull();
    const err = await requireUser(asUser()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
  });
});

describe('session lifetime', () => {
  it('rejects a session past its idle expiry and caps sliding at the absolute lifetime', async () => {
    const value = await login();
    const req = () => new Request(base(), { headers: { cookie: `tp_session=${value}` } });
    const idHash = hashSessionId(value);

    // Created 7 days minus 1 hour ago: sliding may only extend to the absolute cap.
    await query(
      `UPDATE app_session SET created_at = now() - interval '7 days' + interval '1 hour'
        WHERE id_hash = $1`,
      [idHash],
    );
    expect(await getCurrentUser(req())).not.toBeNull();
    const [{ remaining }] = await query<{ remaining: number }>(
      'SELECT extract(epoch FROM expires_at - now())::int AS remaining FROM app_session WHERE id_hash = $1',
      [idHash],
    );
    expect(remaining).toBeLessThanOrEqual(3600);
    expect(remaining).toBeGreaterThan(3500);

    await query("UPDATE app_session SET expires_at = now() - interval '1 second' WHERE id_hash = $1", [idHash]);
    expect(await getCurrentUser(req())).toBeNull();
  });
});
