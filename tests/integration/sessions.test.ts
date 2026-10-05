import { resetDatabase } from './setup';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as detailGET } from '@/app/api/sessions/[id]/route';
import { POST as refreshPOST } from '@/app/api/sessions/[id]/refresh-sources/route';
import { GET as listGET, POST as createPOST } from '@/app/api/sessions/route';
import { resetSiteUrlCache } from '@/server/atlassian/jira';
import { SESSION_COOKIE, createSession as createAppSession } from '@/server/auth/session';
import { getConfig } from '@/server/config';
import { encryptSecret } from '@/server/crypto/secrets';
import { db, query, withTransaction } from '@/server/db/pool';
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/server/http/csrf';
import { clearAccessCacheForTests } from '@/server/sessions/access';
import { acquireOrRenewLock } from '@/server/sessions/lock';
import { MAX_DIFF_CHARS, unifiedDiffExcerpt } from '@/server/sessions/refreshSources';
import { SECTION_NAMES } from '@/lib/spec/sections';

// Atlassian is mocked by stubbing global fetch (undici is not a direct dependency of this project).
const CLOUD_ID = getConfig().ATLASSIAN_CLOUD_ID;
const SITE = 'https://example.atlassian.net';
const JIRA_PREFIX = `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/`;
const CONFLUENCE_PREFIX = `https://api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages/`;
const RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';
const ALICE = { accountId: 'acc-alice', displayName: 'Alice' };
const BOB = { accountId: 'acc-bob', displayName: 'Bob' };
const CSRF = issueCsrfToken().token;

interface FakeIssue {
  summary: string;
  description: string;
  remoteLinks?: { url: string; title: string; type: string }[];
  attachments?: { id: string; filename: string; mimeType: string; content: string }[];
}

let issues: Record<string, FakeIssue>;
let pages: Record<string, { status: number; title: string; storage: string }>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function adf(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] })),
  };
}

function notFound(): Response {
  return json({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }, 404);
}

function jiraResponse(path: string): Response {
  const attachment = /^attachment\/content\/(.+)$/.exec(path);
  if (attachment) {
    const id = decodeURIComponent(attachment[1]);
    const meta = Object.values(issues)
      .flatMap((i) => i.attachments ?? [])
      .find((a) => a.id === id);
    return meta ? new Response(meta.content, { status: 200 }) : notFound();
  }
  const match = /^issue\/([^/]+)(\/comment|\/remotelink)?$/.exec(path);
  if (!match) return json({ error: 'unexpected jira path' }, 599);
  const key = decodeURIComponent(match[1]);
  const issue = issues[key];
  if (!issue) return notFound();
  if (match[2] === '/comment') return json({ total: 0, comments: [] });
  if (match[2] === '/remotelink') {
    return json(
      (issue.remoteLinks ?? []).map((r) => ({ object: { url: r.url, title: r.title }, application: { type: r.type } })),
    );
  }
  return json({
    key,
    fields: {
      summary: issue.summary,
      description: adf(issue.description),
      attachment: (issue.attachments ?? []).map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.content.length,
        content: `${SITE}/attachment/${a.id}`,
      })),
    },
  });
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url === RESOURCES_URL) return json([{ id: CLOUD_ID, url: SITE }]);
  if (url.startsWith(JIRA_PREFIX)) return jiraResponse(url.slice(JIRA_PREFIX.length).split('?')[0]);
  if (url.startsWith(CONFLUENCE_PREFIX)) {
    const id = url.slice(CONFLUENCE_PREFIX.length).split('?')[0];
    const page = pages[id];
    if (!page || page.status !== 200) return json({ message: 'Page not found' }, page?.status ?? 404);
    return json({
      id,
      title: page.title,
      version: { number: 1 },
      body: { storage: { value: page.storage } },
      _links: { webui: `/spaces/ENG/pages/${id}` },
    });
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

async function cookieFor(userId: string): Promise<string> {
  return withTransaction((client) => createAppSession(client, userId));
}

function request(
  method: 'GET' | 'POST',
  path: string,
  opts: { cookie?: string; csrf?: boolean; body?: unknown; tabId?: string } = {},
): NextRequest {
  const cookies: string[] = [];
  const headers: Record<string, string> = {};
  if (opts.cookie) cookies.push(`${SESSION_COOKIE}=${opts.cookie}`);
  if (opts.csrf ?? method === 'POST') {
    headers.origin = getConfig().APP_BASE_URL;
    cookies.push(`${CSRF_COOKIE}=${CSRF}`);
    headers[CSRF_HEADER] = CSRF;
  }
  if (cookies.length > 0) headers.cookie = cookies.join('; ');
  if (opts.tabId) headers['x-tab-id'] = opts.tabId;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(`${getConfig().APP_BASE_URL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

const noParams = { params: Promise.resolve({}) };
function routeArg(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function create(cookie: string, body: unknown): Promise<Response> {
  return createPOST(request('POST', '/api/sessions', { cookie, body }), noParams);
}

async function createOk(cookie: string, ticketKeys: string[], confirmDuplicate?: boolean): Promise<string> {
  const res = await create(cookie, { ticketKeys, confirmDuplicate });
  expect(res.status).toBe(201);
  return ((await res.json()) as { session: { id: string } }).session.id;
}

async function snapshots(sessionId: string) {
  return query<{ kind: string; ref: string; ingest_status: string; detail: Record<string, unknown> }>(
    'SELECT kind, ref, ingest_status, detail FROM source_snapshot WHERE session_id = $1 ORDER BY id',
    [sessionId],
  );
}

let alice: string;
let bob: string;

beforeAll(async () => {
  await resetDatabase();
  await seedUser(ALICE);
  await seedUser(BOB);
  alice = await cookieFor(ALICE.accountId);
  bob = await cookieFor(BOB.accountId);
});

beforeEach(() => {
  issues = {};
  pages = {};
  clearAccessCacheForTests();
  resetSiteUrlCache();
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.end();
});

describe('POST /api/sessions', () => {
  it('AC1: creates the session with primary = first key, snapshots, empty working copy and draft.created audit', async () => {
    issues['ABC-1'] = { summary: 'Primary', description: 'Build the thing' };
    issues['ABC-2'] = {
      summary: 'Secondary',
      description: 'Related work',
      attachments: [{ id: '900', filename: 'notes.txt', mimeType: 'text/plain', content: 'Attachment notes' }],
    };
    const res = await create(alice, { ticketKeys: ['abc-1', 'ABC-2', 'ABC-1'] });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as {
      session: { id: string; primaryTicketKey: string; ticketKeys: string[] };
    };
    expect(session.primaryTicketKey).toBe('ABC-1');
    expect(session.ticketKeys).toEqual(['ABC-1', 'ABC-2']);

    const [row] = await query<{ facilitator_id: string; status: string }>(
      'SELECT facilitator_id, status FROM planning_session WHERE id = $1',
      [session.id],
    );
    expect(row).toEqual({ facilitator_id: ALICE.accountId, status: 'draft' });

    const snaps = await snapshots(session.id);
    expect(snaps.map((s) => [s.kind, s.ref, s.ingest_status])).toEqual([
      ['jira_issue', 'ABC-1', 'ingested'],
      ['jira_issue', 'ABC-2', 'ingested'],
      ['attachment', '900', 'ingested'],
    ]);
    const [issueText] = await query<{ content_text: string }>(
      "SELECT content_text FROM source_snapshot WHERE session_id = $1 AND ref = 'ABC-1'",
      [session.id],
    );
    expect(issueText.content_text).toContain('Build the thing');

    const [wc] = await query<{ sections: Record<string, { body: string }>; version: number }>(
      'SELECT sections, version FROM working_copy WHERE session_id = $1',
      [session.id],
    );
    expect(Object.keys(wc.sections)).toHaveLength(SECTION_NAMES.length);
    expect(Object.keys(wc.sections)).toHaveLength(27);
    expect(Object.values(wc.sections).every((s) => s.body === '')).toBe(true);
    expect(wc.version).toBe(0);

    const audits = await query<{ user_id: string; ticket_ids: string[]; result: string }>(
      "SELECT user_id, ticket_ids, result FROM audit_record WHERE action = 'draft.created' AND session_id = $1",
      [session.id],
    );
    expect(audits).toEqual([{ user_id: ALICE.accountId, ticket_ids: ['ABC-1', 'ABC-2'], result: 'success' }]);
  });

  it('AC2: an unreadable key returns 422 listing it and creates nothing', async () => {
    issues['OK-1'] = { summary: 'Readable', description: 'x' };
    const before = await query('SELECT id FROM planning_session');
    const res = await create(alice, { ticketKeys: ['OK-1', 'NOPE-1'] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { unreadable: string[]; error: { code: string; correlationId: string } };
    expect(body.unreadable).toEqual(['NOPE-1']);
    expect(body.error.code).toBe('tickets_unreadable');
    expect(body.error.correlationId).toBeTruthy();
    expect(await query('SELECT id FROM planning_session')).toHaveLength(before.length);
  });

  it('AC2: invalid key format returns 400 listing the invalid keys, without calling Jira', async () => {
    const res = await create(alice, { ticketKeys: ['ABC-1', 'not a key', '123'] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { invalidKeys: string[] }).invalidKeys).toEqual(['NOT A KEY', '123']);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    const tooMany = await create(alice, { ticketKeys: Array.from({ length: 11 }, (_, i) => `ABC-${i + 1}`) });
    expect(tooMany.status).toBe(400);
    expect((await create(alice, { ticketKeys: [] })).status).toBe(400);
    expect((await create(alice, { nope: true })).status).toBe(400);
  });

  it('AC3: an existing session for the primary ticket returns 409; confirmDuplicate creates a second', async () => {
    issues['DUP-1'] = { summary: 'Dup', description: 'x' };
    issues['DUP-2'] = { summary: 'Other', description: 'y' };
    const first = await createOk(alice, ['DUP-1']);

    const conflict = await create(alice, { ticketKeys: ['DUP-1', 'DUP-2'] });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { existingSessionIds: string[] }).existingSessionIds).toEqual([first]);

    // A different primary ticket is not a duplicate.
    await createOk(alice, ['DUP-2', 'DUP-1']);

    const second = await createOk(alice, ['DUP-1'], true);
    expect(second).not.toBe(first);
    expect(await query("SELECT id FROM planning_session WHERE primary_ticket_key = 'DUP-1'")).toHaveLength(2);
  });

  it('AC4: a failing Confluence page fetch is stored as unavailable while creation succeeds', async () => {
    issues['CNF-1'] = {
      summary: 'With pages',
      description: `See ${SITE}/wiki/x/AbCd for background`,
      remoteLinks: [
        { url: `${SITE}/wiki/spaces/ENG/pages/111/Good`, title: 'Good', type: 'com.atlassian.confluence' },
        { url: `${SITE}/wiki/spaces/ENG/pages/222/Gone`, title: 'Gone', type: 'com.atlassian.confluence' },
      ],
    };
    pages['111'] = { status: 200, title: 'Good page', storage: '<p>Design notes</p>' };
    pages['222'] = { status: 404, title: '', storage: '' };

    const id = await createOk(alice, ['CNF-1']);
    const byRef = new Map((await snapshots(id)).map((s) => [s.ref, s]));
    expect(byRef.get('111')).toMatchObject({ kind: 'confluence_page', ingest_status: 'ingested' });
    expect(byRef.get('222')).toMatchObject({
      kind: 'confluence_page',
      ingest_status: 'unavailable',
      detail: { reason: 'atlassian_404' },
    });
    expect(byRef.get(`${SITE}/wiki/x/AbCd`)).toMatchObject({
      ingest_status: 'unavailable',
      detail: { reason: 'unsupported_link' },
    });

    // The detail endpoint lists the sources with their ingest status.
    const detail = await detailGET(request('GET', `/api/sessions/${id}`, { cookie: alice }), routeArg(id));
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      session: { id: string; clarificationEnded: boolean };
      sources: { kind: string; ref: string; ingestStatus: string; detail: { reason?: string } }[];
      publish: { status: string; latestRun: unknown };
    };
    expect(body.session).toMatchObject({ id, clarificationEnded: false });
    expect(body.publish).toEqual({ status: 'draft', latestRun: null });
    expect(body.sources.map((s) => [s.kind, s.ref, s.ingestStatus])).toEqual([
      ['jira_issue', 'CNF-1', 'ingested'],
      ['confluence_page', '111', 'ingested'],
      ['confluence_page', '222', 'unavailable'],
      ['confluence_page', `${SITE}/wiki/x/AbCd`, 'unavailable'],
    ]);
  });
});

describe('GET /api/sessions and /api/sessions/:id', () => {
  it('lists only sessions the current user facilitates, filtered by status and ticket', async () => {
    issues['LST-1'] = { summary: 'Mine', description: 'x' };
    issues['LST-2'] = { summary: 'Linked', description: 'y' };
    issues['LST-9'] = { summary: 'Bobs', description: 'z' };
    const mine = await createOk(alice, ['LST-1', 'LST-2']);
    const bobs = await createOk(bob, ['LST-9']);

    const list = async (cookie: string, qs = '') => {
      const res = await listGET(request('GET', `/api/sessions${qs}`, { cookie }), noParams);
      expect(res.status).toBe(200);
      return ((await res.json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id);
    };
    expect(await list(alice)).toContain(mine);
    expect(await list(alice)).not.toContain(bobs);
    expect(await list(alice, '?ticket=lst-2')).toEqual([mine]);
    expect(await list(alice, '?status=draft&ticket=LST-1')).toEqual([mine]);
    expect(await list(alice, '?status=published&ticket=LST-1')).toEqual([]);
    expect((await listGET(request('GET', '/api/sessions?status=bogus', { cookie: alice }), noParams)).status).toBe(400);

    // Any user who can read the primary ticket may open the session by id (D-12).
    const opened = await detailGET(request('GET', `/api/sessions/${bobs}`, { cookie: alice }), routeArg(bobs));
    expect(opened.status).toBe(200);
  });

  it('returns 404 for a session whose primary ticket the user cannot read, and for unknown ids', async () => {
    issues['HID-1'] = { summary: 'Hidden', description: 'x' };
    const id = await createOk(alice, ['HID-1']);
    delete issues['HID-1'];
    clearAccessCacheForTests();
    expect((await detailGET(request('GET', `/api/sessions/${id}`, { cookie: alice }), routeArg(id))).status).toBe(404);
    const unknown = randomUUID();
    expect(
      (await detailGET(request('GET', `/api/sessions/${unknown}`, { cookie: alice }), routeArg(unknown))).status,
    ).toBe(404);
  });
});

describe('POST /api/sessions/:id/refresh-sources', () => {
  it('AC5: a changed description appends one system message containing the change', async () => {
    issues['REF-1'] = { summary: 'Refresh me', description: 'Line one\nOld requirement\nLine three' };
    const id = await createOk(alice, ['REF-1']);
    const tab = randomUUID();
    await acquireOrRenewLock(id, tab);

    // Without the lock (another tab) the refresh is rejected.
    const locked = await refreshPOST(
      request('POST', `/api/sessions/${id}/refresh-sources`, { cookie: alice, tabId: randomUUID() }),
      routeArg(id),
    );
    expect(locked.status).toBe(423);

    issues['REF-1'].description = 'Line one\nNew requirement\nLine three';
    const res = await refreshPOST(
      request('POST', `/api/sessions/${id}/refresh-sources`, { cookie: alice, tabId: tab }),
      routeArg(id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: { kind: string; ref: string }[]; messageSeq: number };
    expect(body.changed).toEqual([{ kind: 'jira_issue', ref: 'REF-1', title: 'Refresh me' }]);
    expect(body.messageSeq).toBe(1);

    const messages = await query<{ role: string; content: string }>(
      'SELECT role, content FROM conversation_message WHERE session_id = $1 ORDER BY seq',
      [id],
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('-Old requirement');
    expect(messages[0].content).toContain('+New requirement');
    expect(messages[0].content).toContain('REF-1');

    // The new batch is now the current source set (no duplicates in the detail view).
    const detail = await detailGET(request('GET', `/api/sessions/${id}`, { cookie: alice }), routeArg(id));
    expect(((await detail.json()) as { sources: unknown[] }).sources).toHaveLength(1);

    // A refresh with no changes stores a new batch but appends no message.
    const unchanged = await refreshPOST(
      request('POST', `/api/sessions/${id}/refresh-sources`, { cookie: alice, tabId: tab }),
      routeArg(id),
    );
    expect(((await unchanged.json()) as { messageSeq: number | null }).messageSeq).toBeNull();
    expect(await query('SELECT 1 FROM conversation_message WHERE session_id = $1', [id])).toHaveLength(1);
  });

  it('reports added and removed sources', async () => {
    issues['ADD-1'] = { summary: 'Add', description: 'x' };
    pages['333'] = { status: 200, title: 'New page', storage: '<p>Fresh</p>' };
    const id = await createOk(alice, ['ADD-1']);
    const tab = randomUUID();
    await acquireOrRenewLock(id, tab);
    issues['ADD-1'].remoteLinks = [
      { url: `${SITE}/wiki/spaces/ENG/pages/333/New`, title: 'New', type: 'com.atlassian.confluence' },
    ];
    const res = await refreshPOST(
      request('POST', `/api/sessions/${id}/refresh-sources`, { cookie: alice, tabId: tab }),
      routeArg(id),
    );
    const body = (await res.json()) as { added: { ref: string }[]; removed: unknown[] };
    expect(body.added.map((a) => a.ref)).toEqual(['333']);
    const [msg] = await query<{ content: string }>('SELECT content FROM conversation_message WHERE session_id = $1', [
      id,
    ]);
    expect(msg.content).toContain('Added sources:');
    expect(msg.content).toContain('333');
  });

  it('caps the diff excerpt at 4000 chars including the truncation marker', () => {
    const oldText = Array.from({ length: 2000 }, (_, i) => `old line ${i}`).join('\n');
    const newText = Array.from({ length: 2000 }, (_, i) => `new line ${i}`).join('\n');
    const excerpt = unifiedDiffExcerpt(oldText, newText);
    expect(MAX_DIFF_CHARS).toBe(4000);
    expect(excerpt.length).toBeLessThanOrEqual(4000);
    expect(excerpt.endsWith('(diff truncated)')).toBe(true);
    expect(unifiedDiffExcerpt('a', 'b')).toBe('@@ -1,1 +1,1 @@\n-a\n+b');
  });
});

describe('AC6: authentication and CSRF', () => {
  it('rejects POSTs without CSRF with 403', async () => {
    issues['CSR-1'] = { summary: 'x', description: 'x' };
    const noCsrf = await createPOST(
      request('POST', '/api/sessions', { cookie: alice, csrf: false, body: { ticketKeys: ['CSR-1'] } }),
      noParams,
    );
    expect(noCsrf.status).toBe(403);
    expect(await query("SELECT 1 FROM planning_session WHERE primary_ticket_key = 'CSR-1'")).toHaveLength(0);

    const id = await createOk(alice, ['CSR-1']);
    const tab = randomUUID();
    await acquireOrRenewLock(id, tab);
    const refresh = await refreshPOST(
      request('POST', `/api/sessions/${id}/refresh-sources`, { cookie: alice, csrf: false, tabId: tab }),
      routeArg(id),
    );
    expect(refresh.status).toBe(403);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const id = randomUUID();
    expect((await listGET(request('GET', '/api/sessions'), noParams)).status).toBe(401);
    expect(
      (await createPOST(request('POST', '/api/sessions', { body: { ticketKeys: ['ABC-1'] } }), noParams)).status,
    ).toBe(401);
    expect((await detailGET(request('GET', `/api/sessions/${id}`), routeArg(id))).status).toBe(401);
    expect(
      (
        await refreshPOST(
          request('POST', `/api/sessions/${id}/refresh-sources`, { cookie: 'bogus', tabId: randomUUID() }),
          routeArg(id),
        )
      ).status,
    ).toBe(401);
  });
});
