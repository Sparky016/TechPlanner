import { vi } from 'vitest';

// The facilitator must use FakeLlmClient; set before setup imports the config.
vi.hoisted(() => {
  process.env.LLM_FAKE = '1';
});

import { resetDatabase } from './setup';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as messagesPOST } from '@/app/api/sessions/[id]/messages/route';
import { POST as answerPOST } from '@/app/api/sessions/[id]/questions/[qid]/answer/route';
import { POST as reopenPOST } from '@/app/api/sessions/[id]/questions/[qid]/reopen/route';
import { POST as resolvePOST } from '@/app/api/sessions/[id]/questions/[qid]/resolve/route';
import { SESSION_COOKIE, createSession } from '@/server/auth/session';
import { getConfig, resetConfigForTests } from '@/server/config';
import { encryptSecret } from '@/server/crypto/secrets';
import { db, query, withTransaction } from '@/server/db/pool';
import { RESOLVED_QUESTIONS_RULE } from '@/server/facilitator/prompt';
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/server/http/csrf';
import { stopQueue } from '@/server/jobs/queue';
import { FakeLlmClient, getLlmClient, resetLlmClientForTests, type FakeStep } from '@/server/llm';
import { clearAccessCacheForTests } from '@/server/sessions/access';
import { acquireOrRenewLock } from '@/server/sessions/lock';
import { initWorkingCopy } from '@/server/spec/workingCopyRepo';

// Question lifecycle (GI-12, GI-14, GI-16, GI-17, GI-19, GI-21): answer (streamed turn), resolve, reopen.
// Sessions are marked ingested with SQL rather than via /ingest. Atlassian (the access check) is mocked by
// stubbing global fetch.

const ISSUE_PREFIX = `https://api.atlassian.com/ex/jira/${getConfig().ATLASSIAN_CLOUD_ID}/rest/api/3/issue/`;
const ALICE = { accountId: 'acc-alice', displayName: 'Alice' };
const CSRF = issueCsrfToken().token;

let cookie: string;
let keySeq = 0;
let fake: FakeLlmClient;

interface TestSession {
  id: string;
  tabId: string;
}

async function createLockedSession(opts: { ingested?: boolean } = {}): Promise<TestSession> {
  keySeq++;
  const rows = await query<{ id: string }>(
    `INSERT INTO planning_session (primary_ticket_key, ticket_keys, facilitator_id, ingested_at, analyzed_at)
     VALUES ($1, ARRAY[$1], $2, CASE WHEN $3 THEN now() END, CASE WHEN $3 THEN now() END) RETURNING id`,
    [`QST-${keySeq}`, ALICE.accountId, opts.ingested ?? true],
  );
  const id = rows[0].id;
  await initWorkingCopy(id);
  const tabId = randomUUID();
  await acquireOrRenewLock(id, tabId);
  return { id, tabId };
}

async function insertQuestion(
  s: TestSession,
  text: string,
  fields: { status?: string; answerText?: string; resolution?: string } = {},
): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO ai_question (session_id, section, text, status, answer_text, answered_via, resolution, resolved_at)
     VALUES ($1, 'Security', $2, $3, $4::text, CASE WHEN $4::text IS NOT NULL THEN 'facilitator' END, $5::text,
             CASE WHEN $5::text IS NOT NULL THEN now() END)
     RETURNING id`,
    [s.id, text, fields.status ?? 'open', fields.answerText ?? null, fields.resolution ?? null],
  );
  return row.id;
}

function request(path: string, opts: { tabId?: string; body?: unknown } = {}): NextRequest {
  const headers: Record<string, string> = {
    origin: getConfig().APP_BASE_URL,
    cookie: `${SESSION_COOKIE}=${cookie}; ${CSRF_COOKIE}=${CSRF}`,
    [CSRF_HEADER]: CSRF,
  };
  if (opts.tabId) headers['x-tab-id'] = opts.tabId;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(`${getConfig().APP_BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

type Route = (req: NextRequest, ctx: { params: Promise<{ id: string; qid: string }> }) => Promise<Response>;

function call(route: Route, action: string, s: TestSession, qid: string, body?: unknown, tabId = s.tabId): Promise<Response> {
  return route(request(`/api/sessions/${s.id}/questions/${qid}/${action}`, { tabId, body }), {
    params: Promise.resolve({ id: s.id, qid }),
  });
}

const answer = (s: TestSession, qid: string, text: unknown, tabId?: string) =>
  call(answerPOST, 'answer', s, qid, { text }, tabId);
const resolve = (s: TestSession, qid: string, body?: unknown) => call(resolvePOST, 'resolve', s, qid, body);
const reopen = (s: TestSession, qid: string) => call(reopenPOST, 'reopen', s, qid);

function sendMessage(s: TestSession, text: string): Promise<Response> {
  return messagesPOST(request(`/api/sessions/${s.id}/messages`, { tabId: s.tabId, body: { text } }), {
    params: Promise.resolve({ id: s.id }),
  });
}

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

async function readSse(res: Response): Promise<SseFrame[]> {
  const raw = await res.text();
  const frames: SseFrame[] = [];
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n').filter((l) => l !== '' && !l.startsWith(':'));
    if (lines.length === 0) continue;
    const event = lines.find((l) => l.startsWith('event: '))?.slice('event: '.length) ?? 'message';
    const data = lines.find((l) => l.startsWith('data: '))?.slice('data: '.length) ?? 'null';
    frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
  }
  return frames;
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

function patch(section: string, content: string): FakeStep {
  return { type: 'tool-call', name: 'apply_section_patch', args: { section, op: 'replace', content } };
}

interface QuestionState {
  status: string;
  answer_text: string | null;
  answered_at: Date | null;
  answered_via: string | null;
  resolution: string | null;
  resolved_at: Date | null;
  dismiss_reason: string | null;
}

async function question(qid: string): Promise<QuestionState> {
  const [row] = await query<QuestionState>(
    `SELECT status, answer_text, answered_at, answered_via, resolution, resolved_at, dismiss_reason
       FROM ai_question WHERE id = $1`,
    [qid],
  );
  return row;
}

async function messages(s: TestSession): Promise<{ role: string; content: string; question_id: string | null }[]> {
  return query('SELECT role, content, question_id FROM conversation_message WHERE session_id = $1 ORDER BY seq', [s.id]);
}

async function audits(s: TestSession, action: string): Promise<{ result: string; correlation_id: string; details: Record<string, unknown> }[]> {
  return query(
    'SELECT result, correlation_id, details FROM audit_record WHERE session_id = $1 AND action = $2 ORDER BY id',
    [s.id, action],
  );
}

/** Holds every fake LLM run until `open()` is called. */
function gateFakeRun(): { open: () => void; restore: () => void } {
  const original = fake.run.bind(fake);
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  fake.run = async function* (opts) {
    await gate;
    yield* original(opts);
  };
  return { open, restore: () => (fake.run = original) };
}

beforeAll(async () => {
  await resetDatabase();
  await db.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
  resetConfigForTests();
  resetLlmClientForTests();
  fake = getLlmClient() as FakeLlmClient;
  await query('INSERT INTO app_user (atlassian_account_id, display_name) VALUES ($1, $2)', [
    ALICE.accountId,
    ALICE.displayName,
  ]);
  await query(
    `INSERT INTO oauth_token (user_id, enc_access_token, enc_refresh_token, expires_at, scopes)
     VALUES ($1, $2, NULL, now() + interval '1 hour', ARRAY['read:jira-work'])`,
    [ALICE.accountId, encryptSecret('token-alice')],
  );
  cookie = await withTransaction((client) => createSession(client, ALICE.accountId));
});

beforeEach(() => {
  fake.reset();
  clearAccessCacheForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = url.startsWith(ISSUE_PREFIX) ? { key: 'X', fields: { summary: 'Summary' } } : { error: 'unexpected' };
      return new Response(JSON.stringify(body), {
        status: url.startsWith(ISSUE_PREFIX) ? 200 : 599,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await stopQueue();
  await db.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
  await db.end();
});

describe('POST /questions/:qid/answer (SSE)', () => {
  it('stores the answer, persists it as the last message with question_id and streams an answer turn (AC1)', async () => {
    const s = await createLockedSession();
    const qid = await insertQuestion(s, 'Which IdP?');
    fake.enqueue([{ type: 'text-delta', text: 'Recorded Okta. ' }, patch('Security', 'SSO via Okta (SAML).'), { type: 'done' }]);

    const res = await answer(s, qid, 'Okta, via SAML');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const correlationId = res.headers.get('x-correlation-id');
    const frames = await readSse(res);
    expect(frames.map((f) => f.event)).toEqual(['token', 'patch', 'done']);
    expect(frames[1].data).toMatchObject({ section: 'Security' });
    expect(frames[2].data).toMatchObject({ messageSeq: 2 });

    expect(await question(qid)).toMatchObject({
      status: 'answered',
      answer_text: 'Okta, via SAML',
      answered_at: expect.any(Date),
      answered_via: 'facilitator',
      resolution: null,
    });
    expect(await messages(s)).toEqual([
      { role: 'facilitator', content: 'Okta, via SAML', question_id: qid },
      { role: 'ai', content: 'Recorded Okta. ', question_id: null },
    ]);

    // The model got ANSWER_TEXT naming the question, the answer as the last message, and the answer in context.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].system).toContain(`The facilitator answered question ${qid}: "Which IdP?".`);
    expect(fake.calls[0].system).not.toContain('This is an overview discussion');
    expect(fake.calls[0].messages.at(-1)).toEqual({ role: 'user', content: 'Okta, via SAML' });
    expect(fake.calls[0].messages[0].content).toContain(
      `## Answered questions\n\n- (${qid}) [Security] Which IdP?\n  Answer (facilitator): Okta, via SAML`,
    );

    const answered = await audits(s, 'question.answered');
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ result: 'success', correlation_id: correlationId });
    expect(answered[0].details).toMatchObject({ questionId: qid, section: 'Security', answerLength: 14 });
    const turns = await audits(s, 'ai.suggestion');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ result: 'success', correlation_id: correlationId });
    expect(turns[0].details).toMatchObject({ turnKind: 'answer', questionId: qid, messageSeq: 2 });
  });

  it('keeps the answer on LLM failure; re-answering replaces answer_text and runs a new turn (AC2)', async () => {
    const s = await createLockedSession();
    const qid = await insertQuestion(s, 'Which region?');
    fake.enqueue([{ type: 'error', code: 'llm_unavailable', message: 'AI unavailable', retryable: true }]);

    const res = await answer(s, qid, 'EU');
    expect(res.status).toBe(200);
    const frames = await readSse(res);
    expect(frames.map((f) => f.event)).toEqual(['error']);
    expect(frames[0].data).toMatchObject({ code: 'llm_unavailable' });
    expect(await question(qid)).toMatchObject({ status: 'answered', answer_text: 'EU', answered_via: 'facilitator' });
    expect(await messages(s)).toEqual([{ role: 'facilitator', content: 'EU', question_id: qid }]);
    expect((await audits(s, 'ai.suggestion'))[0]).toMatchObject({
      result: 'failure',
      details: { turnKind: 'answer', questionId: qid, errorCode: 'llm_unavailable' },
    });

    // Edit answer: allowed from answered; replaces answer_text, keeps the earlier answer in the history.
    fake.enqueue([patch('Scope', 'EU and UK.'), { type: 'done' }]);
    const again = await answer(s, qid, 'EU and UK');
    expect(again.status).toBe(200);
    expect((await readSse(again)).map((f) => f.event)).toEqual(['patch', 'done']);
    expect(await question(qid)).toMatchObject({ status: 'answered', answer_text: 'EU and UK' });
    expect(await messages(s)).toEqual([
      { role: 'facilitator', content: 'EU', question_id: qid },
      { role: 'facilitator', content: 'EU and UK', question_id: qid },
      { role: 'ai', content: '', question_id: null },
    ]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].messages.at(-1)).toEqual({ role: 'user', content: 'EU and UK' });
    expect((await audits(s, 'question.answered')).map((a) => a.details.answerLength)).toEqual([2, 9]);
    expect((await audits(s, 'ai.suggestion')).map((a) => a.result)).toEqual(['failure', 'success']);
  });

  it('rejects resolved questions, oversize, empty and unknown answers without persisting anything', async () => {
    const s = await createLockedSession();
    const resolved = await insertQuestion(s, 'Resolved?', { status: 'resolved', resolution: 'not_relevant' });
    const legacy = await insertQuestion(s, 'Dismissed?', { status: 'dismissed' });
    const open = await insertQuestion(s, 'Open?');

    for (const qid of [resolved, legacy]) {
      const res = await answer(s, qid, 'Late answer');
      expect(res.status).toBe(409);
      expect(await errorCode(res)).toBe('question_resolved');
    }
    const big = await answer(s, open, 'x'.repeat(10_001));
    expect(big.status).toBe(413);
    expect(await errorCode(big)).toBe('body_too_large');
    expect((await answer(s, open, '   ')).status).toBe(400);
    expect((await answer(s, open, 'ok', randomUUID())).status).toBe(423);
    const unknown = await answer(s, randomUUID(), 'ok');
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe('question_not_found');
    expect((await answer(s, 'not-a-uuid', 'ok')).status).toBe(404);

    expect(fake.calls).toHaveLength(0);
    expect(await messages(s)).toEqual([]);
    expect(await question(open)).toMatchObject({ status: 'open', answer_text: null });
    expect(await audits(s, 'question.answered')).toEqual([]);

    // The turn lock was released by every rejection.
    fake.enqueue([patch('Security', 'Done'), { type: 'done' }]);
    expect((await readSse(await answer(s, open, 'Fine'))).at(-1)?.event).toBe('done');
  });

  it('returns 409 not_ingested before ingest and persists nothing (GI-23)', async () => {
    const s = await createLockedSession({ ingested: false });
    const qid = await insertQuestion(s, 'Which IdP?');
    const res = await answer(s, qid, 'Okta');
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('not_ingested');
    expect(await question(qid)).toMatchObject({ status: 'open', answer_text: null });
    expect(await messages(s)).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it('returns 409 turn_in_progress while another turn streams and persists nothing (GI-22)', async () => {
    const s = await createLockedSession();
    const qid = await insertQuestion(s, 'Which IdP?');
    const gate = gateFakeRun();
    try {
      fake.enqueue([patch('Scope', 'Message turn'), { type: 'done' }]);
      const message = await sendMessage(s, 'First');
      expect(message.status).toBe(200);

      const blocked = await answer(s, qid, 'Okta');
      expect(blocked.status).toBe(409);
      expect(await errorCode(blocked)).toBe('turn_in_progress');

      gate.open();
      expect((await readSse(message)).at(-1)?.event).toBe('done');
    } finally {
      gate.restore();
    }
    expect(await question(qid)).toMatchObject({ status: 'open', answer_text: null });
    expect((await messages(s)).map((m) => m.content)).not.toContain('Okta');
    expect(await audits(s, 'question.answered')).toEqual([]);
  });
});

describe('POST /questions/:qid/resolve and /reopen', () => {
  it('resolves answered as answered and open as not_relevant; reopen restores answered / open (AC3)', async () => {
    const s = await createLockedSession();
    const answered = await insertQuestion(s, 'Which IdP?', { status: 'answered', answerText: 'Okta' });
    const open = await insertQuestion(s, 'Mobile app?');

    const r1 = await resolve(s, answered);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ id: answered, status: 'resolved', resolution: 'answered', reason: null });
    expect(await question(answered)).toMatchObject({
      status: 'resolved',
      resolution: 'answered',
      resolved_at: expect.any(Date),
      answer_text: 'Okta',
    });

    const r2 = await resolve(s, open, { reason: 'Web only' });
    expect(r2.status).toBe(200);
    const correlationId = r2.headers.get('x-correlation-id');
    expect(await r2.json()).toEqual({ id: open, status: 'resolved', resolution: 'not_relevant', reason: 'Web only' });
    expect(await question(open)).toMatchObject({ status: 'resolved', resolution: 'not_relevant', dismiss_reason: 'Web only' });

    const resolvedAudits = await audits(s, 'question.resolved');
    expect(resolvedAudits.map((a) => a.details)).toEqual([
      { questionId: answered, section: 'Security', resolution: 'answered', reason: null },
      { questionId: open, section: 'Security', resolution: 'not_relevant', reason: 'Web only' },
    ]);
    expect(resolvedAudits[1].correlation_id).toBe(correlationId);
    expect(fake.calls).toHaveLength(0);

    // The next turn's context lists both as resolved, with the do-not-re-ask rule.
    fake.enqueue([patch('Scope', 'Overview'), { type: 'done' }]);
    expect((await readSse(await sendMessage(s, 'Overview'))).at(-1)?.event).toBe('done');
    const context = fake.calls[0].messages[0].content;
    expect(context).toContain(`## Resolved questions\n\n${RESOLVED_QUESTIONS_RULE}`);
    expect(context).toContain(`- (${answered}) [Security] Which IdP?\n  Resolution: answered\n  Answer (facilitator): Okta`);
    expect(context).toContain(`- (${open}) [Security] Mobile app?\n  Resolution: not relevant (reason: Web only)`);
    expect(context).toContain('## Open AI questions\n\nNone.');
    expect(fake.calls[0].system).toContain('This is an overview discussion.');

    const o1 = await reopen(s, answered);
    expect(o1.status).toBe(200);
    expect(await o1.json()).toEqual({ id: answered, status: 'answered' });
    expect(await question(answered)).toMatchObject({
      status: 'answered',
      resolution: null,
      resolved_at: null,
      answer_text: 'Okta',
    });
    const o2 = await reopen(s, open);
    expect(await o2.json()).toEqual({ id: open, status: 'open' });
    expect(await question(open)).toMatchObject({ status: 'open', resolution: null, resolved_at: null, dismiss_reason: null });
    expect((await audits(s, 'question.reopened')).map((a) => a.details)).toEqual([
      { questionId: answered, section: 'Security', status: 'answered' },
      { questionId: open, section: 'Security', status: 'open' },
    ]);
  });

  it('returns its 409 for every invalid transition, 404 for unknown and 413 for a long reason (AC3)', async () => {
    const s = await createLockedSession();
    const resolved = await insertQuestion(s, 'Resolved?', { status: 'resolved', resolution: 'not_relevant' });
    const open = await insertQuestion(s, 'Open?');
    const answered = await insertQuestion(s, 'Answered?', { status: 'answered', answerText: 'Yes' });

    const again = await resolve(s, resolved);
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe('question_not_open');
    for (const qid of [open, answered]) {
      const res = await reopen(s, qid);
      expect(res.status).toBe(409);
      expect(await errorCode(res)).toBe('question_not_resolved');
    }
    expect((await resolve(s, randomUUID())).status).toBe(404);
    expect((await reopen(s, 'nope')).status).toBe(404);
    const long = await resolve(s, open, { reason: 'r'.repeat(501) });
    expect(long.status).toBe(413);
    expect(await errorCode(long)).toBe('body_too_large');
    expect((await call(resolvePOST, 'resolve', s, open, undefined, randomUUID())).status).toBe(423);

    expect(await question(open)).toMatchObject({ status: 'open' });
    expect(await question(answered)).toMatchObject({ status: 'answered' });
    expect(await audits(s, 'question.resolved')).toEqual([]);
    expect(await audits(s, 'question.reopened')).toEqual([]);

    // A legacy 'dismissed' row reopens to open.
    const legacy = await insertQuestion(s, 'Dismissed?', { status: 'dismissed' });
    expect(await (await reopen(s, legacy)).json()).toEqual({ id: legacy, status: 'open' });
  });
});

describe('mark_question_answered (GI-19)', () => {
  it('stores the AI summary for an open question and leaves resolved questions alone', async () => {
    const s = await createLockedSession();
    const open = await insertQuestion(s, 'Which IdP?');
    const resolved = await insertQuestion(s, 'Mobile?', { status: 'resolved', resolution: 'not_relevant' });
    const toolResults: string[] = [];
    const original = fake.run.bind(fake);
    fake.run = async function* (opts) {
      for await (const e of original(opts)) {
        if (e.type === 'tool-call' && e.name === 'mark_question_answered') toolResults.push(e.result);
        yield e;
      }
    };
    try {
      fake.enqueue([
        patch('Security', 'Okta'),
        { type: 'tool-call', name: 'mark_question_answered', args: { questionId: open, answerSummary: 'Okta via SAML' } },
        { type: 'tool-call', name: 'mark_question_answered', args: { questionId: resolved, answerSummary: 'Yes' } },
        { type: 'done' },
      ]);
      expect((await readSse(await sendMessage(s, 'We use Okta; mobile is out.'))).at(-1)?.event).toBe('done');
    } finally {
      fake.run = original;
    }
    expect(toolResults).toEqual([`Question ${open} marked answered`, `Question ${resolved} is resolved and cannot be changed`]);
    expect(await question(open)).toMatchObject({
      status: 'answered',
      answer_text: 'Okta via SAML',
      answered_via: 'ai',
      answered_at: expect.any(Date),
    });
    expect(await question(resolved)).toMatchObject({ status: 'resolved', answer_text: null, answered_via: null });
  });
});
