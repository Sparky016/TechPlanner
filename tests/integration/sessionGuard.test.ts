import { resetDatabase } from './setup';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as lockPOST } from '@/app/api/sessions/[id]/lock/route';
import { POST as takeOverPOST } from '@/app/api/sessions/[id]/lock/take-over/route';
import { SESSION_COOKIE, createSession } from '@/server/auth/session';
import { ReauthRequiredError } from '@/server/auth/tokens';
import { getConfig } from '@/server/config';
import { encryptSecret } from '@/server/crypto/secrets';
import { db, query, withTransaction } from '@/server/db/pool';
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/server/http/csrf';
import { HttpError } from '@/server/http/errors';
import { clearAccessCacheForTests, requireSessionAccess } from '@/server/sessions/access';
import { acquireOrRenewLock, requireLock, takeOverLock } from '@/server/sessions/lock';
import { getSessionById } from '@/server/sessions/repo';

// Atlassian is mocked by stubbing global fetch (undici is not a direct dependency of this project).
const ISSUE_PREFIX = `https://api.atlassian.com/ex/jira/${getConfig().ATLASSIAN_CLOUD_ID}/rest/api/3/issue/`;
const ALICE = { accountId: 'acc-alice', displayName: 'Alice' };
const BOB = { accountId: 'acc-bob', displayName: 'Bob' };
const CSRF = issueCsrfToken().token;

// Per-user issue key -> HTTP status Jira returns; unlisted keys return 200.
let jiraStatus: Record<string, Record<string, number>>;
let issueCalls: { auth: string | null; url: string }[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(ISSUE_PREFIX)) {
    const auth = new Headers(init?.headers).get('Authorization');
    issueCalls.push({ auth, url });
    const user = auth?.replace('Bearer token-', '') ?? '';
    const key = decodeURIComponent(url.slice(ISSUE_PREFIX.length).split('?')[0]);
    const status = jiraStatus[user]?.[key] ?? 200;
    if (status === 200) return json({ key, fields: { summary: 'Summary' } });
    return json({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }, status);
  }
  return json({ error: 'unexpected request' }, 599);
}

async function seedUser(user: { accountId: string; displayName: string }): Promise<void> {
  await query('INSERT INTO app_user (atlassian_account_id, display_name) VALUES ($1, $2)', [
    user.accountId,
    user.displayName,
  ]);
  await query(
    `INSERT INTO oauth_token (user_id, enc_access_token, enc_refresh_token, expires_at, scopes)
     VALUES ($1, $2, NULL, now() + interval '1 hour', ARRAY['read:jira-work'])`,
    [user.accountId, encryptSecret(`token-${user.accountId}`)],
  );
}

async function createPlanningSession(primaryKey: string): Promise<string> {
  const rows = await query<{ id: string }>(
    'INSERT INTO planning_session (primary_ticket_key, ticket_keys) VALUES ($1, ARRAY[$1, $2]) RETURNING id',
    [primaryKey, `${primaryKey}-LINKED`],
  );
  return rows[0].id;
}

async function sessionCookieFor(userId: string): Promise<string> {
  return withTransaction((client) => createSession(client, userId));
}

function post(path: string, cookie: string, tabId?: string): NextRequest {
  const headers: Record<string, string> = {
    origin: getConfig().APP_BASE_URL,
    cookie: `${SESSION_COOKIE}=${cookie}; ${CSRF_COOKIE}=${CSRF}`,
    [CSRF_HEADER]: CSRF,
  };
  if (tabId) headers['x-tab-id'] = tabId;
  return new NextRequest(`${getConfig().APP_BASE_URL}${path}`, { method: 'POST', headers });
}

function routeArg(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function takeOverAudits(sessionId: string) {
  return query<{ user_id: string; details: Record<string, unknown>; ticket_ids: string[] }>(
    "SELECT user_id, details, ticket_ids FROM audit_record WHERE action = 'session.lock_taken_over' AND session_id = $1",
    [sessionId],
  );
}

async function expectHttpError(promise: Promise<unknown>, status: number, code?: string): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(status);
  if (code) expect((err as HttpError).code).toBe(code);
}

beforeAll(async () => {
  await resetDatabase();
  await seedUser(ALICE);
  await seedUser(BOB);
});

beforeEach(() => {
  jiraStatus = {};
  issueCalls = [];
  clearAccessCacheForTests();
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.end();
});

describe('getSessionById', () => {
  it('maps the row and returns null for unknown or malformed ids', async () => {
    const id = await createPlanningSession('MAP-1');
    expect(await getSessionById(id)).toMatchObject({
      id,
      primaryTicketKey: 'MAP-1',
      ticketKeys: ['MAP-1', 'MAP-1-LINKED'],
      status: 'draft',
      clarificationEnded: false,
      lockHolder: null,
      lockExpiresAt: null,
    });
    expect(await getSessionById(randomUUID())).toBeNull();
    expect(await getSessionById('not-a-uuid')).toBeNull();
  });
});

describe('requireSessionAccess', () => {
  it('returns the session when the user can read the primary ticket, calling Jira as that user', async () => {
    const id = await createPlanningSession('ACC-1');
    const session = await requireSessionAccess({ user: ALICE }, id);
    expect(session.id).toBe(id);
    expect(issueCalls).toEqual([{ auth: 'Bearer token-acc-alice', url: `${ISSUE_PREFIX}ACC-1?fields=summary` }]);
  });

  it('AC1: Jira 404 -> 404, and a second call within 5 minutes does not hit Jira', async () => {
    const id = await createPlanningSession('ACC-2');
    jiraStatus[BOB.accountId] = { 'ACC-2': 404 };
    await expectHttpError(requireSessionAccess({ user: BOB }, id), 404, 'not_found');
    expect(issueCalls).toHaveLength(1);
    await expectHttpError(requireSessionAccess({ user: BOB }, id), 404, 'not_found');
    expect(issueCalls).toHaveLength(1);
  });

  it('caches an allowed result per user and ticket for 5 minutes, then asks Jira again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const id = await createPlanningSession('ACC-3');
    await requireSessionAccess({ user: ALICE }, id);
    await requireSessionAccess({ user: ALICE }, id);
    expect(issueCalls).toHaveLength(1);
    // A different user is checked separately.
    await requireSessionAccess({ user: BOB }, id);
    expect(issueCalls).toHaveLength(2);
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    await requireSessionAccess({ user: ALICE }, id);
    expect(issueCalls).toHaveLength(3);
  });

  it('maps Jira 403 to 404', async () => {
    const id = await createPlanningSession('ACC-4');
    jiraStatus[BOB.accountId] = { 'ACC-4': 403 };
    await expectHttpError(requireSessionAccess({ user: BOB }, id), 404, 'not_found');
  });

  it('unknown and malformed session ids -> 404 without calling Jira', async () => {
    await expectHttpError(requireSessionAccess({ user: ALICE }, randomUUID()), 404, 'not_found');
    await expectHttpError(requireSessionAccess({ user: ALICE }, 'nope'), 404, 'not_found');
    expect(issueCalls).toHaveLength(0);
  });

  it('propagates other Atlassian errors and does not cache them', async () => {
    const id = await createPlanningSession('ACC-5');
    jiraStatus[ALICE.accountId] = { 'ACC-5': 500 };
    await expect(requireSessionAccess({ user: ALICE }, id)).rejects.toMatchObject({
      name: 'AtlassianApiError',
      status: 500,
    });
    jiraStatus[ALICE.accountId] = {};
    await expect(requireSessionAccess({ user: ALICE }, id)).resolves.toMatchObject({ id });
    expect(issueCalls).toHaveLength(2);
  });

  it('propagates ReauthRequiredError when the user has no Atlassian token', async () => {
    const id = await createPlanningSession('ACC-6');
    await query("INSERT INTO app_user (atlassian_account_id, display_name) VALUES ('acc-notoken', 'No Token')");
    await expect(
      requireSessionAccess({ user: { accountId: 'acc-notoken', displayName: 'No Token' } }, id),
    ).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it('rejects a missing user with 401', async () => {
    const id = await createPlanningSession('ACC-7');
    await expectHttpError(requireSessionAccess({ user: null }, id), 401, 'unauthenticated');
  });
});

describe('session lock', () => {
  it('acquires a free lock, renews it for the same tab, and reports other for a second tab', async () => {
    const id = await createPlanningSession('LCK-1');
    const tabA = randomUUID();
    const tabB = randomUUID();
    const first = await acquireOrRenewLock(id, tabA);
    expect(first.holder).toBe('you');
    expect(first.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);
    const renewed = await acquireOrRenewLock(id, tabA);
    expect(renewed.holder).toBe('you');
    expect(renewed.expiresAt!.getTime()).toBeGreaterThanOrEqual(first.expiresAt!.getTime());
    const other = await acquireOrRenewLock(id, tabB);
    expect(other).toEqual({ holder: 'other', expiresAt: renewed.expiresAt });
    await expect(requireLock(id, tabA)).resolves.toBeUndefined();
    await expectHttpError(requireLock(id, tabB), 423, 'session_locked');
  });

  it('AC2: two tabs racing acquireOrRenewLock -> exactly one gets you', async () => {
    for (let round = 0; round < 10; round++) {
      const id = await createPlanningSession(`RACE-${round + 1}`);
      const tabs = [randomUUID(), randomUUID()];
      const results = await Promise.all(tabs.map((tab) => acquireOrRenewLock(id, tab)));
      expect(results.filter((r) => r.holder === 'you')).toHaveLength(1);
      expect(results.filter((r) => r.holder === 'other')).toHaveLength(1);
      const winner = tabs[results.findIndex((r) => r.holder === 'you')];
      expect((await getSessionById(id))!.lockHolder).toBe(winner);
    }
  });

  it('AC3: an expired lock can be acquired by another tab', async () => {
    const id = await createPlanningSession('LCK-3');
    const tabA = randomUUID();
    const tabB = randomUUID();
    await acquireOrRenewLock(id, tabA);
    await query("UPDATE planning_session SET lock_expires_at = now() - interval '1 second' WHERE id = $1", [id]);
    await expectHttpError(requireLock(id, tabA), 423, 'session_locked');
    expect((await acquireOrRenewLock(id, tabB)).holder).toBe('you');
    expect((await getSessionById(id))!.lockHolder).toBe(tabB);
  });

  it('AC4: take-over transfers the lock and audits it; the previous tab then gets 423', async () => {
    const id = await createPlanningSession('LCK-4');
    const tabA = randomUUID();
    const tabB = randomUUID();
    await acquireOrRenewLock(id, tabA);
    const result = await takeOverLock(id, tabB, { user: ALICE, correlationId: 'corr-1' });
    expect(result.holder).toBe('you');
    expect((await getSessionById(id))!.lockHolder).toBe(tabB);
    await expectHttpError(requireLock(id, tabA), 423, 'session_locked');
    await expect(requireLock(id, tabB)).resolves.toBeUndefined();
    expect(await takeOverAudits(id)).toEqual([
      {
        user_id: ALICE.accountId,
        details: { previousHolder: tabA, newHolder: tabB },
        ticket_ids: ['LCK-4', 'LCK-4-LINKED'],
      },
    ]);
  });

  it('acquire and take-over on an unknown session -> 404', async () => {
    await expectHttpError(acquireOrRenewLock(randomUUID(), randomUUID()), 404, 'not_found');
    await expectHttpError(takeOverLock(randomUUID(), randomUUID(), { user: ALICE }), 404, 'not_found');
  });
});

describe('POST /api/sessions/:id/lock and /lock/take-over', () => {
  it('acquires, reports other to a second tab, and take-over transfers the lock with an audit', async () => {
    const id = await createPlanningSession('RTE-1');
    const cookie = await sessionCookieFor(ALICE.accountId);
    const tabA = randomUUID();
    const tabB = randomUUID();

    const a = await lockPOST(post(`/api/sessions/${id}/lock`, cookie, tabA), routeArg(id));
    expect(a.status).toBe(200);
    const aBody = (await a.json()) as { holder: string; expiresAt: string };
    expect(aBody.holder).toBe('you');
    expect(Number.isNaN(Date.parse(aBody.expiresAt))).toBe(false);

    const b = await lockPOST(post(`/api/sessions/${id}/lock`, cookie, tabB), routeArg(id));
    expect(await b.json()).toEqual({ holder: 'other', expiresAt: aBody.expiresAt });

    const t = await takeOverPOST(post(`/api/sessions/${id}/lock/take-over`, cookie, tabB), routeArg(id));
    expect(t.status).toBe(200);
    expect(((await t.json()) as { holder: string }).holder).toBe('you');
    const audits = await takeOverAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0].details).toEqual({ previousHolder: tabA, newHolder: tabB });

    const again = await lockPOST(post(`/api/sessions/${id}/lock`, cookie, tabA), routeArg(id));
    expect(((await again.json()) as { holder: string }).holder).toBe('other');
  });

  it('returns 404 to a user who cannot read the ticket, without touching the lock or audit', async () => {
    const id = await createPlanningSession('RTE-2');
    jiraStatus[BOB.accountId] = { 'RTE-2': 404 };
    const cookie = await sessionCookieFor(BOB.accountId);
    const lock = await lockPOST(post(`/api/sessions/${id}/lock`, cookie, randomUUID()), routeArg(id));
    expect(lock.status).toBe(404);
    expect(((await lock.json()) as { error: { code: string } }).error.code).toBe('not_found');
    const take = await takeOverPOST(post(`/api/sessions/${id}/lock/take-over`, cookie, randomUUID()), routeArg(id));
    expect(take.status).toBe(404);
    expect((await getSessionById(id))!.lockHolder).toBeNull();
    expect(await takeOverAudits(id)).toHaveLength(0);
  });

  it('returns 404 for unknown and malformed session ids', async () => {
    const cookie = await sessionCookieFor(ALICE.accountId);
    const unknown = randomUUID();
    expect(
      (await lockPOST(post(`/api/sessions/${unknown}/lock`, cookie, randomUUID()), routeArg(unknown))).status,
    ).toBe(404);
    expect((await lockPOST(post('/api/sessions/garbage/lock', cookie, randomUUID()), routeArg('garbage'))).status).toBe(
      404,
    );
  });

  it('requires a valid x-tab-id header', async () => {
    const id = await createPlanningSession('RTE-3');
    const cookie = await sessionCookieFor(ALICE.accountId);
    const missing = await lockPOST(post(`/api/sessions/${id}/lock`, cookie), routeArg(id));
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('tab_id_required');
    const bad = await takeOverPOST(post(`/api/sessions/${id}/lock/take-over`, cookie, 'tab-1'), routeArg(id));
    expect(bad.status).toBe(400);
  });

  it('requires authentication', async () => {
    const id = await createPlanningSession('RTE-4');
    const res = await lockPOST(post(`/api/sessions/${id}/lock`, 'bogus', randomUUID()), routeArg(id));
    expect(res.status).toBe(401);
  });
});
