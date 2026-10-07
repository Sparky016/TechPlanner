import { vi } from 'vitest';

// The evaluator must use FakeLlmClient; set before setup imports the config.
vi.hoisted(() => {
  process.env.LLM_FAKE = '1';
});

import { resetDatabase } from './setup';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as acceptRiskPOST } from '@/app/api/sessions/[id]/issues/[issueId]/accept-risk/route';
import { POST as endClarificationPOST } from '@/app/api/sessions/[id]/end-clarification/route';
import { POST as evaluatePOST } from '@/app/api/sessions/[id]/evaluate/route';
import { GET as readinessGET } from '@/app/api/sessions/[id]/readiness/route';
import { SESSION_COOKIE, createSession } from '@/server/auth/session';
import { getConfig, resetConfigForTests } from '@/server/config';
import { encryptSecret } from '@/server/crypto/secrets';
import { db, query, withTransaction } from '@/server/db/pool';
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/server/http/csrf';
import { clearHandlersForTests, getHandlers } from '@/server/jobs/registry';
import { getQueue, stopQueue, subscribeHandlers } from '@/server/jobs/queue';
import { FakeLlmClient, getLlmClient, resetLlmClientForTests, type FakeStep } from '@/server/llm';
import { handleReadinessEvaluate } from '@/server/readiness/jobHandler';
import { registerHandler } from '@/server/jobs/registry';
import { JOB_NAMES } from '@/server/jobs/names';
import { scheduleEvaluation } from '@/server/readiness/schedule';
import { clearAccessCacheForTests } from '@/server/sessions/access';
import { acquireOrRenewLock } from '@/server/sessions/lock';
import { initWorkingCopy } from '@/server/spec/workingCopyRepo';
import type { SectionStatus } from '../../src/lib/readiness/types';
import { SECTION_NAMES } from '../../src/lib/spec/sections';

// Atlassian is mocked by stubbing global fetch.
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
let fake: FakeLlmClient;

async function createLockedSession(): Promise<{ id: string; tabId: string }> {
  keySeq++;
  const rows = await query<{ id: string }>(
    'INSERT INTO planning_session (primary_ticket_key, ticket_keys, facilitator_id) VALUES ($1, ARRAY[$1], $2) RETURNING id',
    [`RDY-${keySeq}`, ALICE.accountId],
  );
  const id = rows[0].id;
  await initWorkingCopy(id);
  const tabId = randomUUID();
  await acquireOrRenewLock(id, tabId);
  return { id, tabId };
}

function request(method: string, path: string, tabId?: string): NextRequest {
  const headers: Record<string, string> = {
    origin: getConfig().APP_BASE_URL,
    cookie: `${SESSION_COOKIE}=${cookie}; ${CSRF_COOKIE}=${CSRF}`,
    [CSRF_HEADER]: CSRF,
  };
  if (tabId) headers['x-tab-id'] = tabId;
  return new NextRequest(`${getConfig().APP_BASE_URL}${path}`, { method, headers });
}

function evaluatorScript(status: SectionStatus, extra: FakeStep[] = []): FakeStep[] {
  return [
    ...SECTION_NAMES.map(
      (section): FakeStep => ({
        type: 'tool-call',
        name: 'report_section_status',
        args: { section, status, reason: `${section}: ${status}` },
      }),
    ),
    ...extra,
    { type: 'done' },
  ];
}

function raise(severity: string, description: string): FakeStep {
  return { type: 'tool-call', name: 'raise_issue', args: { severity, section: 'Logging', description } };
}

async function evaluate(s: { id: string }): Promise<Response> {
  return evaluatePOST(request('POST', `/api/sessions/${s.id}/evaluate`), { params: Promise.resolve({ id: s.id }) });
}

async function readiness(s: { id: string }): Promise<Record<string, unknown>> {
  const res = await readinessGET(request('GET', `/api/sessions/${s.id}/readiness`), {
    params: Promise.resolve({ id: s.id }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function acceptRisk(s: { id: string; tabId: string }, issueId: string): Promise<Response> {
  return acceptRiskPOST(request('POST', `/api/sessions/${s.id}/issues/${issueId}/accept-risk`, s.tabId), {
    params: Promise.resolve({ id: s.id, issueId }),
  });
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
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

describe('scheduleEvaluation debounce', { timeout: 90000 }, () => {
  it('runs evaluateSession once for five schedule calls within 20 s', async () => {
    const s = await createLockedSession();
    fake.enqueue(evaluatorScript('complete'));

    clearHandlersForTests();
    registerHandler(JOB_NAMES.readinessEvaluate, handleReadinessEvaluate);

    const results = [];
    for (let i = 0; i < 5; i++) results.push(await scheduleEvaluation(s.id));
    expect(results).toEqual([true, false, false, false, false]);

    // Pending is visible while the job is queued.
    expect((await readiness(s)).evaluationPending).toBe(true);

    await getQueue();
    await subscribeHandlers(getHandlers());

    const count = async () =>
      Number((await query<{ n: string }>('SELECT count(*) AS n FROM evaluation WHERE session_id = $1', [s.id]))[0].n);
    const start = Date.now();
    while ((await count()) < 1) {
      if (Date.now() - start > 60000) throw new Error('timed out waiting for the debounced evaluation');
      await new Promise((r) => setTimeout(r, 250));
    }
    // Give a (wrongly) duplicated run the chance to appear.
    await new Promise((r) => setTimeout(r, 3000));
    expect(await count()).toBe(1);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15000);
    await stopQueue();
  });
});

describe('POST /evaluate and GET /readiness', () => {
  it('returns a fresh EvaluationResult that GET /readiness reflects', async () => {
    const s = await createLockedSession();
    fake.enqueue(evaluatorScript('complete', [raise('warning', 'No log levels defined')]));

    const res = await evaluate(s);
    expect(res.status).toBe(200);
    const result = (await res.json()) as { evaluationId: string; score: number; gatePasses: boolean; issues: unknown[] };
    expect(result.score).toBe(100);
    expect(result.gatePasses).toBe(true);
    expect(result.issues).toHaveLength(1);

    const state = await readiness(s);
    expect(state.score).toBe(result.score);
    expect(state.gatePasses).toBe(true);
    expect(state.clarificationEnded).toBe(false);
    expect(state.evaluationPending).toBe(false);
    expect(state.evaluatedAt).toEqual(expect.any(String));
    expect(state.issues).toEqual([
      expect.objectContaining({ severity: 'warning', section: 'Logging', status: 'open' }),
    ]);
    expect(state.openQuestions).toEqual([]);
    expect(Object.keys(state.statuses as object)).toHaveLength(SECTION_NAMES.length);
  });

  it('reports no evaluation before the first one', async () => {
    const s = await createLockedSession();
    const state = await readiness(s);
    expect(state.score).toBeNull();
    expect(state.evaluatedAt).toBeNull();
  });
});

describe('POST /issues/:issueId/accept-risk', () => {
  it('accepts a warning, audits it, and rejects a critical with 400', async () => {
    const s = await createLockedSession();
    fake.enqueue(
      evaluatorScript('complete', [raise('warning', 'No log levels defined'), raise('critical', 'Data loss risk')]),
    );
    await evaluate(s);
    const issues = await query<{ id: string; severity: string }>(
      'SELECT id, severity FROM issue WHERE session_id = $1',
      [s.id],
    );
    const warning = issues.find((i) => i.severity === 'warning')!;
    const critical = issues.find((i) => i.severity === 'critical')!;

    const ok = await acceptRisk(s, warning.id);
    expect(ok.status).toBe(200);
    const [row] = await query<{ status: string }>('SELECT status FROM issue WHERE id = $1', [warning.id]);
    expect(row.status).toBe('accepted-risk');
    const audits = await query<{ user_id: string; details: { issueId: string } }>(
      "SELECT user_id, details FROM audit_record WHERE action = 'issue.accepted_risk' AND session_id = $1",
      [s.id],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].user_id).toBe(ALICE.accountId);
    expect(audits[0].details.issueId).toBe(warning.id);

    const bad = await acceptRisk(s, critical.id);
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe('critical_requires_override');
    const [still] = await query<{ status: string }>('SELECT status FROM issue WHERE id = $1', [critical.id]);
    expect(still.status).toBe('open');
  });

  it('returns 404 for an unknown issue', async () => {
    const s = await createLockedSession();
    const res = await acceptRisk(s, randomUUID());
    expect(res.status).toBe(404);
  });
});

describe('POST /end-clarification', () => {
  it('sets clarification_ended and is idempotent; GET /readiness reports it', async () => {
    const s = await createLockedSession();
    for (let i = 0; i < 2; i++) {
      const res = await endClarificationPOST(request('POST', `/api/sessions/${s.id}/end-clarification`, s.tabId), {
        params: Promise.resolve({ id: s.id }),
      });
      expect(res.status).toBe(200);
    }
    const [row] = await query<{ clarification_ended: boolean }>(
      'SELECT clarification_ended FROM planning_session WHERE id = $1',
      [s.id],
    );
    expect(row.clarification_ended).toBe(true);
    expect((await readiness(s)).clarificationEnded).toBe(true);
  });

  it('requires the session lock', async () => {
    const s = await createLockedSession();
    const res = await endClarificationPOST(request('POST', `/api/sessions/${s.id}/end-clarification`, randomUUID()), {
      params: Promise.resolve({ id: s.id }),
    });
    expect(res.status).toBe(423);
  });
});
