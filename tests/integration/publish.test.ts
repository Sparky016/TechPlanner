import { vi } from 'vitest';

// The mandatory evaluation must use FakeLlmClient; set before setup imports the config.
vi.hoisted(() => {
  process.env.LLM_FAKE = '1';
});

import { resetDatabase } from './setup';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as publishPOST } from '@/app/api/sessions/[id]/publish/route';
import { GET as runGET } from '@/app/api/sessions/[id]/publish/[runId]/route';
import { POST as retryPOST } from '@/app/api/sessions/[id]/publish/[runId]/retry/route';
import { resetSiteUrlCache } from '@/server/atlassian/jira';
import { SESSION_COOKIE, createSession } from '@/server/auth/session';
import { getConfig, resetConfigForTests } from '@/server/config';
import { encryptSecret } from '@/server/crypto/secrets';
import { db, query, withTransaction } from '@/server/db/pool';
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/server/http/csrf';
import { stopQueue } from '@/server/jobs/queue';
import { FakeLlmClient, getLlmClient, resetLlmClientForTests, type FakeStep } from '@/server/llm';
import { handlePublishRun } from '@/server/publish/jobHandler';
import type { PublishRun } from '@/server/publish/orchestrator';
import { resetSpaceIdCacheForTests } from '@/server/publish/steps/confluenceStep';
import { clearAccessCacheForTests } from '@/server/sessions/access';
import { acquireOrRenewLock } from '@/server/sessions/lock';
import { initWorkingCopy } from '@/server/spec/workingCopyRepo';
import type { SectionStatus, SectionStatuses } from '../../src/lib/readiness/types';
import { SECTION_NAMES } from '../../src/lib/spec/sections';

// All Atlassian calls are mocked by stubbing global fetch (undici is not a direct dependency of this project).
// DOWNSTREAM_WEBHOOK_URL is unset, so the downstream step runs in label-only mode.

const CLOUD = getConfig().ATLASSIAN_CLOUD_ID;
const JIRA = `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/`;
const CONFLUENCE = `https://api.atlassian.com/ex/confluence/${CLOUD}/wiki/api/v2`;
const RESOURCES = 'https://api.atlassian.com/oauth/token/accessible-resources';
const SITE = 'https://example.atlassian.net';
const ALICE = { accountId: 'acc-alice', displayName: 'Alice' };
const CSRF = issueCsrfToken().token;
const JUSTIFICATION = 'Customer deadline; scope agreed verbally with PO';
const STEP_ORDER = ['confluence', 'jira_attach', 'jira_description', 'jira_comment', 'jira_label', 'downstream'];

interface FakeIssue {
  attachments: { id: string; filename: string }[];
  description: unknown;
  comments: { id: string; body: unknown }[];
  labels: string[];
}

interface FakePage {
  id: string;
  title: string;
  version: number;
  body: string;
}

let fake: FakeLlmClient;
let cookie: string;
let keySeq = 0;
let idSeq = 0;
let issues: Map<string, FakeIssue>;
let pages: Map<string, FakePage>;
let failConfluence: boolean;
let requests: { method: string; url: string }[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function pageJson(p: FakePage) {
  return { id: p.id, title: p.title, version: { number: p.version }, _links: { webui: `/spaces/TEST/pages/${p.id}` } };
}

function issueOf(key: string): FakeIssue {
  let issue = issues.get(key);
  if (!issue) {
    issue = { attachments: [], description: null, comments: [], labels: [] };
    issues.set(key, issue);
  }
  return issue;
}

async function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const method = (init.method ?? 'GET').toUpperCase();
  requests.push({ method, url });
  const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;

  if (url === RESOURCES) return json([{ id: CLOUD, url: SITE }]);

  if (url.startsWith(CONFLUENCE)) {
    const path = url.slice(CONFLUENCE.length);
    if (failConfluence) return json({ message: 'Confluence is down' }, 500);
    if (method === 'GET' && path.startsWith('/spaces?keys=')) return json({ results: [{ id: 'space-1', key: 'TEST' }] });
    if (method === 'POST' && path === '/pages') {
      const p = { id: `page-${++idSeq}`, title: String(body!.title), version: 1, body: '' };
      pages.set(p.id, p);
      return json(pageJson(p));
    }
    const m = /^\/pages\/([^/?]+)$/.exec(path);
    const p = m ? pages.get(decodeURIComponent(m[1])) : undefined;
    if (p && method === 'GET') return json(pageJson(p));
    if (p && method === 'PUT') {
      p.version = (body!.version as { number: number }).number;
      return json(pageJson(p));
    }
  }

  if (url.startsWith(JIRA)) {
    const [path, search = ''] = url.slice(JIRA.length).split('?');
    const [rawKey, sub] = path.split('/');
    const key = decodeURIComponent(rawKey);
    const issue = issueOf(key);
    if (!sub && method === 'GET' && search === 'fields=summary') return json({ key, fields: { summary: 'Summary' } });
    if (!sub && method === 'GET' && search === 'fields=attachment') return json({ fields: { attachment: issue.attachments } });
    if (!sub && method === 'GET' && search === 'fields=description') return json({ fields: { description: issue.description } });
    if (!sub && method === 'PUT') {
      const fields = body!.fields as { description?: unknown } | undefined;
      if (fields?.description !== undefined) issue.description = fields.description;
      const update = body!.update as { labels?: { add: string }[] } | undefined;
      for (const l of update?.labels ?? []) if (!issue.labels.includes(l.add)) issue.labels.push(l.add);
      return new Response(null, { status: 204 });
    }
    if (sub === 'attachments' && method === 'POST') {
      const file = (init.body as FormData).get('file') as File;
      const a = { id: `att-${++idSeq}`, filename: file.name };
      issue.attachments.push(a);
      return json([a]);
    }
    if (sub === 'comment' && method === 'GET') return json({ total: issue.comments.length, comments: issue.comments });
    if (sub === 'comment' && method === 'POST') {
      const c = { id: `c-${++idSeq}`, body: body!.body };
      issue.comments.push(c);
      return json(c);
    }
  }

  return json({ message: `unmocked ${method} ${url}` }, 599);
}

function script(statuses: SectionStatuses): FakeStep[] {
  return [
    ...SECTION_NAMES.map(
      (section): FakeStep => ({
        type: 'tool-call',
        name: 'report_section_status',
        args: { section, status: statuses[section], reason: `${section}: ${statuses[section]}` },
      }),
    ),
    { type: 'done' },
  ];
}

function statuses(missing: string[] = []): SectionStatuses {
  const out = {} as SectionStatuses;
  for (const n of SECTION_NAMES) out[n] = (missing.includes(n) ? 'missing' : 'complete') as SectionStatus;
  return out;
}

const passing = () => fake.enqueue(script(statuses()));
const failing = () => fake.enqueue(script(statuses(['Scope'])));

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

type S = { id: string; tabId: string; keys: string[] };

async function createLockedSession(): Promise<S> {
  keySeq++;
  const keys = [`PUB-${keySeq * 10 + 1}`, `PUB-${keySeq * 10 + 2}`];
  const rows = await query<{ id: string }>(
    'INSERT INTO planning_session (primary_ticket_key, ticket_keys, facilitator_id) VALUES ($1, $2, $3) RETURNING id',
    [keys[0], keys, ALICE.accountId],
  );
  const id = rows[0].id;
  await initWorkingCopy(id);
  for (const key of keys) {
    await query(
      `INSERT INTO source_snapshot (session_id, kind, ref, title, content_text, ingest_status, detail, retrieved_at)
       VALUES ($1, 'jira_issue', $2, $3, '', 'ingested', $4, '2026-01-01T00:00:00Z')`,
      [id, key, `Summary of ${key}`, JSON.stringify({ url: `${SITE}/browse/${key}` })],
    );
  }
  const tabId = randomUUID();
  await acquireOrRenewLock(id, tabId);
  return { id, tabId, keys };
}

function request(method: string, path: string, opts: { tabId?: string; body?: unknown; csrf?: boolean } = {}) {
  const headers: Record<string, string> = {
    origin: getConfig().APP_BASE_URL,
    cookie: `${SESSION_COOKIE}=${cookie}; ${CSRF_COOKIE}=${CSRF}`,
    'content-type': 'application/json',
  };
  if (opts.csrf !== false) headers[CSRF_HEADER] = CSRF;
  if (opts.tabId) headers['x-tab-id'] = opts.tabId;
  return new NextRequest(`${getConfig().APP_BASE_URL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

const publish = (s: S, body: unknown = {}, opts: { tabId?: string; csrf?: boolean } = {}) =>
  publishPOST(request('POST', `/api/sessions/${s.id}/publish`, { tabId: opts.tabId ?? s.tabId, body, csrf: opts.csrf }), {
    params: Promise.resolve({ id: s.id }),
  });

const retry = (s: S, runId: string, body: unknown = {}) =>
  retryPOST(request('POST', `/api/sessions/${s.id}/publish/${runId}/retry`, { tabId: s.tabId, body }), {
    params: Promise.resolve({ id: s.id, runId }),
  });

async function getRun(s: S, runId: string): Promise<PublishRun> {
  const res = await runGET(request('GET', `/api/sessions/${s.id}/publish/${runId}`), {
    params: Promise.resolve({ id: s.id, runId }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { run: PublishRun }).run;
}

/** Publishes and runs the queued job inline (the worker is not subscribed in tests). */
async function publishAndRun(s: S, body: unknown = {}): Promise<string> {
  const res = await publish(s, body);
  expect(res.status).toBe(202);
  const { runId } = (await res.json()) as { runId: string };
  await handlePublishRun({ runId });
  return runId;
}

async function retryAndRun(s: S, runId: string, body: { confluenceAction?: 'overwrite' | 'cancel' } = {}) {
  const res = await retry(s, runId, body);
  expect(res.status).toBe(202);
  await handlePublishRun({ runId, ...(body.confluenceAction ? { options: body } : {}) });
}

function stepStatuses(run: PublishRun): Record<string, string> {
  return Object.fromEntries(run.steps.map((st) => [st.name, st.status]));
}

async function audits(sessionId: string, action: string) {
  return query<{ details: Record<string, unknown>; result: string; correlation_id: string | null }>(
    'SELECT details, result, correlation_id FROM audit_record WHERE session_id = $1 AND action = $2 ORDER BY id',
    [sessionId, action],
  );
}

async function sessionStatus(id: string): Promise<string> {
  const rows = await query<{ status: string }>('SELECT status FROM planning_session WHERE id = $1', [id]);
  return rows[0].status;
}

beforeAll(async () => {
  await resetDatabase();
  await db.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
  resetConfigForTests();
  resetLlmClientForTests();
  fake = getLlmClient() as FakeLlmClient;
  await seedUser(ALICE);
  cookie = await withTransaction((client) => createSession(client, ALICE.accountId));
});

beforeEach(() => {
  fake.reset();
  clearAccessCacheForTests();
  resetSiteUrlCache();
  resetSpaceIdCacheForTests();
  issues = new Map();
  pages = new Map();
  idSeq = 0;
  failConfluence = false;
  requests = [];
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await stopQueue();
  await db.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
  await db.end();
});

describe('publish orchestration', { timeout: 30000 }, () => {
  it('AC1: an open critical issue without a valid override returns 409 gate_failed', async () => {
    const s = await createLockedSession();
    failing();
    const res = await publish(s);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string }; openCriticalIssues: { section: string }[] };
    expect(body.error.code).toBe('gate_failed');
    expect(body.openCriticalIssues).toEqual([expect.objectContaining({ section: 'Scope' })]);

    // Short justification, or no confirmation, is still rejected.
    failing();
    expect((await publish(s, { confirmOverride: true, overrideJustification: '   too short          ' })).status).toBe(409);
    failing();
    expect((await publish(s, { overrideJustification: JUSTIFICATION })).status).toBe(409);

    expect(await query('SELECT 1 FROM publish_run WHERE session_id = $1', [s.id])).toHaveLength(0);
    expect(await query('SELECT 1 FROM revision WHERE session_id = $1', [s.id])).toHaveLength(0);
    expect(await audits(s.id, 'readiness.override')).toHaveLength(0);
    expect(requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('AC1: confirmOverride with a 20+ char justification proceeds and writes readiness.override', async () => {
    const s = await createLockedSession();
    failing();
    const runId = await publishAndRun(s, { confirmOverride: true, overrideJustification: `  ${JUSTIFICATION}  ` });

    const [override] = await audits(s.id, 'readiness.override');
    expect(override.details).toEqual({
      justification: JUSTIFICATION,
      openCriticalIssues: [expect.objectContaining({ section: 'Scope', description: 'Scope is missing' })],
    });
    const run = await getRun(s, runId);
    expect(run.overrideJustification).toBe(JUSTIFICATION);
    expect(run.status).toBe('completed');
    // The override reaches the Jira comment.
    const comment = JSON.stringify(issues.get(s.keys[0])!.comments[0].body);
    expect(comment).toContain(JUSTIFICATION);
  });

  it('AC2: a successful publish creates a published revision, runs all six steps in order and completes', async () => {
    const s = await createLockedSession();
    passing();
    const runId = await publishAndRun(s);

    const revisions = await query<{ number: number; trigger: string; published: boolean }>(
      'SELECT number, trigger, published FROM revision WHERE session_id = $1',
      [s.id],
    );
    expect(revisions).toEqual([{ number: 1, trigger: 'publish', published: true }]);

    const run = await getRun(s, runId);
    expect(run.status).toBe('completed');
    expect(run.revisionNumber).toBe(1);
    expect(run.overrideJustification).toBeNull();
    expect(run.steps.map((st) => st.name)).toEqual(STEP_ORDER);
    for (const st of run.steps) expect(st).toMatchObject({ status: 'success', attempts: 1, lastError: null });
    expect(run.steps[0].result).toMatchObject({ pageId: 'page-1', url: `${SITE}/wiki/spaces/TEST/pages/page-1` });
    expect(await sessionStatus(s.id)).toBe('published');

    // Step order from the step audit records.
    const trail = await query<{ action: string; details: { step?: string } }>(
      `SELECT action, details FROM audit_record WHERE session_id = $1
         AND action IN ('confluence.updated', 'jira.updated', 'downstream.triggered') ORDER BY id`,
      [s.id],
    );
    const order = trail
      .map((a) => (a.action === 'jira.updated' ? a.details.step! : a.action.split('.')[0]))
      .filter((name, i, all) => i === 0 || all[i - 1] !== name);
    expect(order).toEqual(STEP_ORDER);

    for (const key of s.keys) {
      const issue = issues.get(key)!;
      expect(issue.attachments.map((a) => a.filename)).toEqual([`${key}-spec-r1.md`]);
      expect(issue.comments).toHaveLength(1);
      expect(issue.labels).toEqual(['spec-published']);
      expect(JSON.stringify(issue.description)).toContain(`${SITE}/wiki/spaces/TEST/pages/page-1`);
    }
    expect(pages.get('page-1')!.title).toBe(`${s.keys[0]}: Summary of ${s.keys[0]} — Technical Specification`);

    const started = await audits(s.id, 'publish.started');
    expect(started).toHaveLength(1);
    expect(started[0].details).toMatchObject({ runId, revision: 1, override: false });
    const completed = await audits(s.id, 'publish.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ result: 'success', correlation_id: runId });
    expect(await audits(s.id, 'publish.failed')).toHaveLength(0);
  });

  it('AC3/AC4: a Confluence failure leaves a partial run; retry runs only the non-successful steps once', async () => {
    const s = await createLockedSession();
    failConfluence = true;
    passing();
    const runId = await publishAndRun(s);

    let run = await getRun(s, runId);
    expect(run.status).toBe('failed');
    expect(stepStatuses(run)).toEqual({
      confluence: 'failed',
      jira_attach: 'success',
      jira_description: 'waiting',
      jira_comment: 'waiting',
      jira_label: 'success',
      downstream: 'pending',
    });
    expect(run.steps[0].lastError).toMatchObject({ code: 'atlassian_500' });
    expect(await sessionStatus(s.id)).toBe('partially_published');
    const [failed] = await audits(s.id, 'publish.failed');
    expect(failed.details).toMatchObject({ failedSteps: ['confluence', 'jira_description', 'jira_comment', 'downstream'] });
    for (const key of s.keys) {
      expect(issues.get(key)!.attachments).toHaveLength(1);
      expect(issues.get(key)!.labels).toEqual(['spec-published']);
      expect(issues.get(key)!.comments).toHaveLength(0);
    }

    // Fix Confluence and retry.
    failConfluence = false;
    requests = [];
    await retryAndRun(s, runId);
    run = await getRun(s, runId);
    expect(run.status).toBe('completed');
    expect(Object.values(stepStatuses(run))).toEqual(STEP_ORDER.map(() => 'success'));
    const attempts = Object.fromEntries(run.steps.map((st) => [st.name, st.attempts]));
    expect(attempts).toEqual({
      confluence: 2,
      jira_attach: 1,
      jira_description: 1,
      jira_comment: 1,
      jira_label: 1,
      downstream: 1,
    });
    // Successful steps were not re-run: no attachment or label calls on retry.
    expect(requests.some((r) => r.url.endsWith('/attachments') || r.url.includes('fields=attachment'))).toBe(false);
    for (const key of s.keys) {
      expect(issues.get(key)!.attachments).toHaveLength(1);
      expect(issues.get(key)!.comments).toHaveLength(1);
    }
    expect(await sessionStatus(s.id)).toBe('published');
    expect(await audits(s.id, 'publish.completed')).toHaveLength(1);

    // A completed run cannot be retried.
    expect((await retry(s, runId)).status).toBe(409);
  });

  it('AC4: re-delivering the publish job after a crash mid-run does not duplicate attachments or comments', async () => {
    const s = await createLockedSession();
    passing();
    const runId = await publishAndRun(s);
    // Simulate a worker crash after the steps ran but before they were recorded as successful.
    await query(
      `UPDATE publish_run SET status = 'running',
         steps = (SELECT jsonb_agg(CASE WHEN st->>'name' IN ('jira_attach', 'jira_comment')
                                        THEN jsonb_set(st, '{status}', '"running"') ELSE st END)
                    FROM jsonb_array_elements(steps) st)
       WHERE id = $1`,
      [runId],
    );
    await handlePublishRun({ runId });
    expect((await getRun(s, runId)).status).toBe('completed');
    for (const key of s.keys) {
      expect(issues.get(key)!.attachments).toHaveLength(1);
      expect(issues.get(key)!.comments).toHaveLength(1);
    }
  });

  it('republish updates the same page; an external edit fails Confluence until retried with overwrite', async () => {
    const s = await createLockedSession();
    passing();
    await publishAndRun(s);
    pages.get('page-1')!.version = 7; // edited in Confluence

    passing();
    const runId = await publishAndRun(s);
    let run = await getRun(s, runId);
    expect(run.revisionNumber).toBe(2);
    expect(run.steps[0]).toMatchObject({ status: 'failed', lastError: { code: 'page_changed_externally' } });
    expect(await sessionStatus(s.id)).toBe('partially_published');

    await retryAndRun(s, runId, { confluenceAction: 'cancel' });
    run = await getRun(s, runId);
    expect(run.status).toBe('failed');
    expect(run.steps[0].status).toBe('cancelled');

    await retryAndRun(s, runId, { confluenceAction: 'overwrite' });
    run = await getRun(s, runId);
    expect(run.status).toBe('completed');
    expect(pages.size).toBe(1);
    expect(pages.get('page-1')!.version).toBe(8);
    for (const key of s.keys) {
      expect(issues.get(key)!.attachments.map((a) => a.filename)).toEqual([`${key}-spec-r1.md`, `${key}-spec-r2.md`]);
      expect(issues.get(key)!.comments).toHaveLength(2);
    }
    expect(await sessionStatus(s.id)).toBe('published');
  });

  it('AC5: a publish after an overridden publish re-checks the gate', async () => {
    const s = await createLockedSession();
    failing();
    const first = await publishAndRun(s, { confirmOverride: true, overrideJustification: JUSTIFICATION });
    expect((await getRun(s, first)).status).toBe('completed');

    failing();
    const res = await publish(s);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('gate_failed');

    // Once the gate passes, the new run carries no override.
    passing();
    const second = await publishAndRun(s);
    expect((await getRun(s, second)).overrideJustification).toBeNull();
    expect(await audits(s.id, 'readiness.override')).toHaveLength(1);
  });

  it('AC6: publish without the session lock returns 423 and without CSRF returns 403', async () => {
    const s = await createLockedSession();
    const locked = await publish(s, {}, { tabId: randomUUID() });
    expect(locked.status).toBe(423);
    expect(((await locked.json()) as { error: { code: string } }).error.code).toBe('session_locked');

    const noCsrf = await publish(s, {}, { csrf: false });
    expect(noCsrf.status).toBe(403);
    expect(fake.calls).toHaveLength(0);
    expect(await query('SELECT 1 FROM publish_run WHERE session_id = $1', [s.id])).toHaveLength(0);
  });

  it('GET returns 404 for an unknown or foreign run', async () => {
    const s = await createLockedSession();
    const other = await createLockedSession();
    passing();
    const runId = await publishAndRun(other);
    for (const id of [runId, 'not-a-uuid', randomUUID()]) {
      const res = await runGET(request('GET', `/api/sessions/${s.id}/publish/${id}`), {
        params: Promise.resolve({ id: s.id, runId: id }),
      });
      expect(res.status).toBe(404);
    }
  });
});
