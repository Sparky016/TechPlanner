import { resetDatabase } from './setup';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as acceptPOST } from '@/app/api/sessions/[id]/suggestions/[sid]/accept/route';
import { POST as rejectPOST } from '@/app/api/sessions/[id]/suggestions/[sid]/reject/route';
import { GET as workingCopyGET } from '@/app/api/sessions/[id]/working-copy/route';
import { PATCH as sectionPATCH } from '@/app/api/sessions/[id]/working-copy/sections/[section]/route';
import { SESSION_COOKIE, createSession } from '@/server/auth/session';
import { getConfig } from '@/server/config';
import { encryptSecret } from '@/server/crypto/secrets';
import { db, query, withTransaction } from '@/server/db/pool';
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/server/http/csrf';
import { clearAccessCacheForTests } from '@/server/sessions/access';
import { acquireOrRenewLock } from '@/server/sessions/lock';
import { flushEditAudits, unifiedDiff } from '@/server/spec/editAudit';
import { applyAiPatch, getWorkingCopy, initWorkingCopy } from '@/server/spec/workingCopyRepo';

// Atlassian is mocked by stubbing global fetch (undici is not a direct dependency of this project).
const ISSUE_PREFIX = `https://api.atlassian.com/ex/jira/${getConfig().ATLASSIAN_CLOUD_ID}/rest/api/3/issue/`;
const ALICE = { accountId: 'acc-alice', displayName: 'Alice' };
const CSRF = issueCsrfToken().token;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(ISSUE_PREFIX)) return json({ key: 'X', fields: { summary: 'Summary' } });
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

let cookie: string;
let keySeq = 0;

// A planning session with an initialised working copy and a lock held by the returned tab.
async function createLockedSession(): Promise<{ id: string; tabId: string }> {
  keySeq++;
  const rows = await query<{ id: string }>(
    'INSERT INTO planning_session (primary_ticket_key, ticket_keys) VALUES ($1, ARRAY[$1]) RETURNING id',
    [`WC-${keySeq}`],
  );
  const id = rows[0].id;
  await initWorkingCopy(id);
  const tabId = randomUUID();
  await acquireOrRenewLock(id, tabId);
  return { id, tabId };
}

function request(
  method: string,
  path: string,
  opts: { tabId?: string; body?: unknown; csrf?: boolean } = {},
): NextRequest {
  const csrf = opts.csrf ?? true;
  const headers: Record<string, string> = {
    origin: getConfig().APP_BASE_URL,
    cookie: csrf ? `${SESSION_COOKIE}=${cookie}; ${CSRF_COOKIE}=${CSRF}` : `${SESSION_COOKIE}=${cookie}`,
  };
  if (csrf) headers[CSRF_HEADER] = CSRF;
  if (opts.tabId) headers['x-tab-id'] = opts.tabId;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(`${getConfig().APP_BASE_URL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

async function patchSection(
  s: { id: string; tabId?: string },
  slug: string,
  body: unknown,
  opts: { csrf?: boolean } = {},
): Promise<Response> {
  return sectionPATCH(
    request('PATCH', `/api/sessions/${s.id}/working-copy/sections/${slug}`, { tabId: s.tabId, body, ...opts }),
    { params: Promise.resolve({ id: s.id, section: slug }) },
  );
}

async function audits(sessionId: string, action: string) {
  return query<{ user_id: string; details: Record<string, unknown>; ticket_ids: string[] }>(
    'SELECT user_id, details, ticket_ids FROM audit_record WHERE action = $1 AND session_id = $2 ORDER BY id',
    [action, sessionId],
  );
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

beforeAll(async () => {
  await resetDatabase();
  await seedUser(ALICE);
  cookie = await withTransaction((client) => createSession(client, ALICE.accountId));
});

beforeEach(() => {
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

describe('GET /api/sessions/:id/working-copy', () => {
  it('returns version, sections keyed by name and pending suggestions', async () => {
    const s = await createLockedSession();
    await patchSection(s, 'scope', { body: 'In scope', expectedVersion: 0 });
    const { suggestionId } = (await applyAiPatch(
      s.id,
      { section: 'Scope', op: 'append', content: 'AI addition' },
      new Date(0),
    )) as { disposition: 'suggested'; suggestionId: string };

    const res = await workingCopyGET(request('GET', `/api/sessions/${s.id}/working-copy`), {
      params: Promise.resolve({ id: s.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: number;
      sections: Record<string, { body: string; lastUserEditAt: string | null }>;
      pendingSuggestions: { id: string; section: string; patch: unknown }[];
    };
    expect(body.version).toBe(1);
    expect(Object.keys(body.sections)).toHaveLength(27);
    expect(body.sections['Scope'].body).toBe('In scope');
    expect(body.sections['Scope'].lastUserEditAt).not.toBeNull();
    expect(body.sections['Risks']).toEqual({ body: '', lastUserEditAt: null });
    expect(body.pendingSuggestions).toEqual([
      expect.objectContaining({
        id: suggestionId,
        section: 'Scope',
        patch: { section: 'Scope', op: 'append', content: 'AI addition' },
      }),
    ]);
  });
});

describe('PATCH /api/sessions/:id/working-copy/sections/:section', () => {
  it('AC1: current version -> new version; stale version -> 409 version_conflict', async () => {
    const s = await createLockedSession();
    const ok = await patchSection(s, 'executive-summary', { body: 'First', expectedVersion: 0 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ version: 1 });

    const stale = await patchSection(s, 'executive-summary', { body: 'Second', expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('version_conflict');
    expect((await getWorkingCopy(s.id))!.sections['Executive Summary'].body).toBe('First');

    const next = await patchSection(s, 'executive-summary', { body: 'Second', expectedVersion: 1 });
    expect(await next.json()).toEqual({ version: 2 });
  });

  it('unknown slug -> 404; oversized body -> 413; malformed body -> 400', async () => {
    const s = await createLockedSession();
    const unknown = await patchSection(s, 'no-such-section', { body: 'x', expectedVersion: 0 });
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe('unknown_section');
    const big = await patchSection(s, 'scope', { body: 'x'.repeat(100_001), expectedVersion: 0 });
    expect(big.status).toBe(413);
    const max = await patchSection(s, 'scope', { body: 'x'.repeat(100_000), expectedVersion: 0 });
    expect(max.status).toBe(200);
    const bad = await patchSection(s, 'scope', { body: 1, expectedVersion: 'one' });
    expect(bad.status).toBe(400);
  });

  it('AC5: no lock -> 423; no CSRF -> 403; nothing is written', async () => {
    const s = await createLockedSession();
    const noLock = await patchSection({ id: s.id, tabId: randomUUID() }, 'scope', { body: 'x', expectedVersion: 0 });
    expect(noLock.status).toBe(423);
    expect(await errorCode(noLock)).toBe('session_locked');
    const noCsrf = await patchSection(s, 'scope', { body: 'x', expectedVersion: 0 }, { csrf: false });
    expect(noCsrf.status).toBe(403);
    expect((await getWorkingCopy(s.id))!.version).toBe(0);
  });

  it('AC2: ten PATCHes within 30 s write no more than one user.edit; flushEditAudits writes the trailing diff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    const s = await createLockedSession();
    let version = 0;
    for (let i = 1; i <= 10; i++) {
      vi.setSystemTime(t0 + i * 2_000);
      const res = await patchSection(s, 'risks', { body: `Risk draft ${i}`, expectedVersion: version });
      version = ((await res.json()) as { version: number }).version;
    }
    expect((await audits(s.id, 'user.edit')).length).toBeLessThanOrEqual(1);
    expect(await audits(s.id, 'user.edit')).toHaveLength(0);

    // 30 s after the first edit: the next PATCH records baseline (empty) -> new body.
    vi.setSystemTime(t0 + 2_000 + 30_000);
    let res = await patchSection(s, 'risks', { body: 'Risk A\nRisk B', expectedVersion: version });
    version = ((await res.json()) as { version: number }).version;
    let edits = await audits(s.id, 'user.edit');
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ user_id: ALICE.accountId, ticket_ids: [expect.stringMatching(/^WC-/)] });
    expect(edits[0].details).toEqual({ section: 'Risks', diff: unifiedDiff('Risks', '', 'Risk A\nRisk B') });

    // A trailing edit inside the new window is not audited until flushed.
    vi.setSystemTime(t0 + 2_000 + 35_000);
    res = await patchSection(s, 'risks', { body: 'Risk A\nRisk C', expectedVersion: version });
    expect(res.status).toBe(200);
    expect(await audits(s.id, 'user.edit')).toHaveLength(1);

    expect(await flushEditAudits(s.id, { user: ALICE, ticketIds: [] })).toBe(1);
    edits = await audits(s.id, 'user.edit');
    expect(edits).toHaveLength(2);
    expect(edits[1].details).toEqual({
      section: 'Risks',
      diff: unifiedDiff('Risks', 'Risk A\nRisk B', 'Risk A\nRisk C'),
    });
    expect(edits[1].details.diff).toContain('-Risk B\n+Risk C');
    // Nothing left to flush.
    expect(await flushEditAudits(s.id, { user: ALICE, ticketIds: [] })).toBe(0);
  });

  it('user.edit windows are per section', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    const s = await createLockedSession();
    await patchSection(s, 'scope', { body: 'S1', expectedVersion: 0 });
    await patchSection(s, 'security', { body: 'Sec1', expectedVersion: 1 });
    vi.setSystemTime(t0 + 30_000);
    await patchSection(s, 'scope', { body: 'S2', expectedVersion: 2 });
    await patchSection(s, 'security', { body: 'Sec2', expectedVersion: 3 });
    const edits = await audits(s.id, 'user.edit');
    expect(edits.map((e) => e.details.section)).toEqual(['Scope', 'Security']);
  });

  it('AC3: draft.updated is written at most once per 5 minutes per session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    const s = await createLockedSession();
    let version = 0;
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(t0 + i * 60_000);
      const res = await patchSection(s, 'apis', { body: `API ${i}`, expectedVersion: version });
      version = ((await res.json()) as { version: number }).version;
    }
    let drafts = await audits(s.id, 'draft.updated');
    expect(drafts).toHaveLength(1);
    expect(drafts[0].details).toEqual({ version: 1 });

    vi.setSystemTime(t0 + 5 * 60_000);
    const res = await patchSection(s, 'apis', { body: 'API 5', expectedVersion: version });
    version = ((await res.json()) as { version: number }).version;
    drafts = await audits(s.id, 'draft.updated');
    expect(drafts).toHaveLength(2);
    expect(drafts[1].details).toEqual({ version });
  });
});

describe('POST /api/sessions/:id/suggestions/:sid/accept and /reject', () => {
  async function suggest(s: { id: string }, content: string): Promise<string> {
    const result = await applyAiPatch(s.id, { section: 'Assumptions', op: 'replace', content }, new Date(0));
    expect(result.disposition).toBe('suggested');
    return (result as { suggestionId: string }).suggestionId;
  }

  function decide(kind: 'accept' | 'reject', s: { id: string; tabId?: string }, sid: string, body?: unknown) {
    const handler = kind === 'accept' ? acceptPOST : rejectPOST;
    return handler(request('POST', `/api/sessions/${s.id}/suggestions/${sid}/${kind}`, { tabId: s.tabId, body }), {
      params: Promise.resolve({ id: s.id, sid }),
    });
  }

  it('AC4: accept with editedContent applies the edited text and writes ai.suggestion.accepted', async () => {
    const s = await createLockedSession();
    await patchSection(s, 'assumptions', { body: 'Mine', expectedVersion: 0 });
    const sid = await suggest(s, 'AI text');

    const res = await decide('accept', s, sid, { editedContent: 'AI text, edited' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 2 });
    expect((await getWorkingCopy(s.id))!.sections['Assumptions'].body).toBe('AI text, edited');
    const accepted = await audits(s.id, 'ai.suggestion.accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0].details).toEqual({ suggestionId: sid, section: 'Assumptions', edited: true });

    // Already decided -> 409.
    const again = await decide('accept', s, sid, {});
    expect(again.status).toBe(409);
  });

  it('accept without a body applies the suggestion as proposed', async () => {
    const s = await createLockedSession();
    await patchSection(s, 'assumptions', { body: 'Mine', expectedVersion: 0 });
    const sid = await suggest(s, 'AI text');
    const res = await decide('accept', s, sid);
    expect(res.status).toBe(200);
    expect((await getWorkingCopy(s.id))!.sections['Assumptions'].body).toBe('AI text');
    expect((await audits(s.id, 'ai.suggestion.accepted'))[0].details).toMatchObject({ edited: false });
  });

  it('reject leaves the working copy unchanged and writes ai.suggestion.rejected', async () => {
    const s = await createLockedSession();
    await patchSection(s, 'assumptions', { body: 'Mine', expectedVersion: 0 });
    const sid = await suggest(s, 'AI text');
    const res = await decide('reject', s, sid);
    expect(res.status).toBe(204);
    const wc = (await getWorkingCopy(s.id))!;
    expect(wc.version).toBe(1);
    expect(wc.sections['Assumptions'].body).toBe('Mine');
    const rejected = await audits(s.id, 'ai.suggestion.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].details).toEqual({ suggestionId: sid, section: 'Assumptions', edited: false });
  });

  it("another session's suggestion, an unknown id, or a missing lock is refused", async () => {
    const a = await createLockedSession();
    const b = await createLockedSession();
    await patchSection(b, 'assumptions', { body: 'B', expectedVersion: 0 });
    const sidB = await suggest(b, 'AI text');
    expect((await decide('accept', a, sidB)).status).toBe(404);
    expect((await decide('reject', a, sidB)).status).toBe(404);
    expect((await decide('accept', a, 'not-a-uuid')).status).toBe(404);
    expect((await decide('accept', { id: b.id, tabId: randomUUID() }, sidB)).status).toBe(423);
    const [row] = await query<{ status: string }>('SELECT status FROM pending_suggestion WHERE id = $1', [sidB]);
    expect(row.status).toBe('pending');
  });
});
