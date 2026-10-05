import { resetDatabase } from './setup';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as compareGET } from '@/app/api/sessions/[id]/revisions/compare/route';
import { POST as restorePOST } from '@/app/api/sessions/[id]/revisions/[n]/restore/route';
import { GET as listGET, POST as savePOST } from '@/app/api/sessions/[id]/revisions/route';
import { SESSION_COOKIE, createSession } from '@/server/auth/session';
import { getConfig } from '@/server/config';
import { encryptSecret } from '@/server/crypto/secrets';
import { db, query, withTransaction } from '@/server/db/pool';
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/server/http/csrf';
import { clearAccessCacheForTests } from '@/server/sessions/access';
import { acquireOrRenewLock } from '@/server/sessions/lock';
import { SECTION_NAMES } from '../../src/lib/spec/sections';
import { getWorkingCopy, initWorkingCopy, updateSectionByUser } from '@/server/spec/workingCopyRepo';

// Atlassian is mocked by stubbing global fetch (undici is not a direct dependency of this project).
const ISSUE_PREFIX = `https://api.atlassian.com/ex/jira/${getConfig().ATLASSIAN_CLOUD_ID}/rest/api/3/issue/`;
const ALICE = { accountId: 'acc-alice', displayName: 'Alice' };
const CSRF = issueCsrfToken().token;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(ISSUE_PREFIX)) return json({ key: 'X', fields: { summary: 'Summary' } });
  return json({ error: 'unexpected request' }, 599);
});

let cookie: string;
let keySeq = 0;

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

async function createLockedSession(): Promise<{ id: string; tabId: string }> {
  keySeq++;
  const rows = await query<{ id: string }>(
    'INSERT INTO planning_session (primary_ticket_key, ticket_keys) VALUES ($1, ARRAY[$1]) RETURNING id',
    [`REV-${keySeq}`],
  );
  const id = rows[0].id;
  await initWorkingCopy(id);
  const tabId = randomUUID();
  await acquireOrRenewLock(id, tabId);
  return { id, tabId };
}

function request(method: string, path: string, opts: { tabId?: string } = {}): NextRequest {
  const headers: Record<string, string> = {
    origin: getConfig().APP_BASE_URL,
    cookie: `${SESSION_COOKIE}=${cookie}; ${CSRF_COOKIE}=${CSRF}`,
    [CSRF_HEADER]: CSRF,
  };
  if (opts.tabId) headers['x-tab-id'] = opts.tabId;
  return new NextRequest(`${getConfig().APP_BASE_URL}${path}`, { method, headers });
}

const saveDraft = (s: { id: string; tabId: string }) =>
  savePOST(request('POST', `/api/sessions/${s.id}/revisions`, { tabId: s.tabId }), {
    params: Promise.resolve({ id: s.id }),
  });

const list = (s: { id: string }) =>
  listGET(request('GET', `/api/sessions/${s.id}/revisions`), { params: Promise.resolve({ id: s.id }) });

const compare = (s: { id: string }, a: string, b: string) =>
  compareGET(request('GET', `/api/sessions/${s.id}/revisions/compare?a=${a}&b=${b}`), {
    params: Promise.resolve({ id: s.id }),
  });

const restore = (s: { id: string; tabId: string }, n: string) =>
  restorePOST(request('POST', `/api/sessions/${s.id}/revisions/${n}/restore`, { tabId: s.tabId }), {
    params: Promise.resolve({ id: s.id, n }),
  });

async function edit(s: { id: string }, section: (typeof SECTION_NAMES)[number], body: string): Promise<void> {
  const wc = (await getWorkingCopy(s.id))!;
  await updateSectionByUser(s.id, section, body, wc.version);
}

beforeAll(async () => {
  await resetDatabase();
  await seedUser(ALICE);
  cookie = await withTransaction((client) => createSession(client, ALICE.accountId));
});

beforeEach(() => {
  clearAccessCacheForTests();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.end();
});

describe('revisions API', () => {
  it('AC1: Save Draft snapshots the working copy as the next revision and writes draft.saved', async () => {
    const s = await createLockedSession();
    await edit(s, 'Scope', 'In scope');
    const first = await saveDraft(s);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ number: 1 });
    await edit(s, 'Risks', 'A risk');
    expect(await (await saveDraft(s)).json()).toEqual({ number: 2 });

    const [row] = await query<{ sections: Record<string, string>; trigger: string; author_id: string }>(
      'SELECT sections, trigger, author_id FROM revision WHERE session_id = $1 AND number = 2',
      [s.id],
    );
    expect(Object.keys(row.sections).sort()).toEqual([...SECTION_NAMES].sort());
    expect(row.sections['Scope']).toBe('In scope');
    expect(row.sections['Risks']).toBe('A risk');
    expect(row).toMatchObject({ trigger: 'save', author_id: ALICE.accountId });

    const audits = await query<{ details: unknown }>(
      "SELECT details FROM audit_record WHERE action = 'draft.saved' AND session_id = $1 ORDER BY id",
      [s.id],
    );
    expect(audits.map((a) => a.details)).toEqual([{ number: 1 }, { number: 2 }]);

    const res = await list(s);
    const body = (await res.json()) as { revisions: Record<string, unknown>[] };
    expect(body.revisions.map((r) => r.number)).toEqual([2, 1]);
    expect(body.revisions[0]).toMatchObject({
      author: { accountId: ALICE.accountId, displayName: 'Alice' },
      trigger: 'save',
      readinessScore: null,
      published: false,
    });
  });

  it('AC1: readiness score is taken from the latest evaluation', async () => {
    const s = await createLockedSession();
    await query(
      "INSERT INTO evaluation (session_id, section_statuses, score, created_at) VALUES ($1, '{}', 40, now() - interval '1 hour')",
      [s.id],
    );
    await query("INSERT INTO evaluation (session_id, section_statuses, score) VALUES ($1, '{}', 72)", [s.id]);
    await saveDraft(s);
    const body = (await (await list(s)).json()) as { revisions: { readinessScore: number }[] };
    expect(body.revisions[0].readinessScore).toBe(72);
  });

  it('AC2: concurrent Save Draft calls produce distinct sequential numbers', async () => {
    const s = await createLockedSession();
    const results = await Promise.all(Array.from({ length: 8 }, () => saveDraft(s)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = (await Promise.all(results.map(async (r) => ((await r.json()) as { number: number }).number))).sort(
      (a, b) => a - b,
    );
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('AC3: compare marks only differing sections changed, in SECTION_NAMES order', async () => {
    const s = await createLockedSession();
    await edit(s, 'Scope', 'one\ntwo\n');
    await saveDraft(s);
    await edit(s, 'Scope', 'one\nthree\n');
    await edit(s, 'Security', 'TLS everywhere');
    await saveDraft(s);

    const res = await compare(s, '1', '2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sections: { section: string; changed: boolean; hunks: { value: string; added?: boolean; removed?: boolean }[] }[];
    };
    expect(body.sections.map((x) => x.section)).toEqual([...SECTION_NAMES]);
    expect(body.sections.filter((x) => x.changed).map((x) => x.section)).toEqual(['Scope', 'Security']);
    const scope = body.sections.find((x) => x.section === 'Scope')!;
    expect(scope.hunks.find((h) => h.removed)?.value).toBe('two\n');
    expect(scope.hunks.find((h) => h.added)?.value).toBe('three\n');

    expect((await compare(s, '1', '99')).status).toBe(404);
    expect((await compare(s, 'x', '1')).status).toBe(400);
  });

  it('AC4: restore sets the working copy to the revision and adds a restore revision; earlier revisions unchanged', async () => {
    const s = await createLockedSession();
    await edit(s, 'Scope', 'original');
    await saveDraft(s);
    await edit(s, 'Scope', 'changed');
    await edit(s, 'Risks', 'new risk');
    await saveDraft(s);
    const before = await query('SELECT * FROM revision WHERE session_id = $1 ORDER BY number', [s.id]);

    const res = await restore(s, '1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ number: 3, restoredFrom: 1 });

    const wc = (await getWorkingCopy(s.id))!;
    expect(wc.sections['Scope'].body).toBe('original');
    expect(wc.sections['Risks'].body).toBe('');

    const after = await query<{ number: number; trigger: string; restored_from: number | null; sections: unknown }>(
      'SELECT * FROM revision WHERE session_id = $1 ORDER BY number',
      [s.id],
    );
    expect(after.slice(0, 2)).toEqual(before);
    expect(after[2]).toMatchObject({ number: 3, trigger: 'restore', restored_from: 1 });
    expect(after[2].sections).toEqual(after[0].sections);

    const audits = await query<{ details: unknown }>(
      "SELECT details FROM audit_record WHERE action = 'revision.restored' AND session_id = $1",
      [s.id],
    );
    expect(audits.map((a) => a.details)).toEqual([{ from: 1, newNumber: 3 }]);

    expect((await restore(s, '42')).status).toBe(404);
    expect((await restore({ id: s.id, tabId: randomUUID() }, '1')).status).toBe(423);
  });

  it('AC5: Save Draft makes no Atlassian HTTP call', async () => {
    const s = await createLockedSession();
    await list(s); // warms the session-access cache (the only Jira call the API ever makes)
    fetchMock.mockClear();
    expect((await saveDraft(s)).status).toBe(201);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
