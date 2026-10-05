import { vi } from 'vitest';

// The facilitator must use FakeLlmClient; set before setup imports the config.
vi.hoisted(() => {
  process.env.LLM_FAKE = '1';
});

import { resetDatabase } from './setup';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as messagesGET, POST as messagesPOST } from '@/app/api/sessions/[id]/messages/route';
import { POST as notesPOST } from '@/app/api/sessions/[id]/notes/route';
import { POST as dismissPOST } from '@/app/api/sessions/[id]/questions/[qid]/dismiss/route';
import { GET as questionsGET } from '@/app/api/sessions/[id]/questions/route';
import { SESSION_COOKIE, createSession } from '@/server/auth/session';
import { getConfig, resetConfigForTests } from '@/server/config';
import { encryptSecret } from '@/server/crypto/secrets';
import { db, query, withTransaction } from '@/server/db/pool';
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/server/http/csrf';
import { stopQueue } from '@/server/jobs/queue';
import { FakeLlmClient, getLlmClient, resetLlmClientForTests, type FakeStep } from '@/server/llm';
import { clearAccessCacheForTests } from '@/server/sessions/access';
import { acquireOrRenewLock } from '@/server/sessions/lock';
import { initWorkingCopy } from '@/server/spec/workingCopyRepo';

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

interface TestSession {
  id: string;
  tabId: string;
}

async function createLockedSession(): Promise<TestSession> {
  keySeq++;
  const rows = await query<{ id: string }>(
    'INSERT INTO planning_session (primary_ticket_key, ticket_keys, facilitator_id) VALUES ($1, ARRAY[$1], $2) RETURNING id',
    [`CNV-${keySeq}`, ALICE.accountId],
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
  opts: { tabId?: string; body?: unknown; signal?: AbortSignal } = {},
): NextRequest {
  const headers: Record<string, string> = {
    origin: getConfig().APP_BASE_URL,
    cookie: `${SESSION_COOKIE}=${cookie}; ${CSRF_COOKIE}=${CSRF}`,
    [CSRF_HEADER]: CSRF,
  };
  if (opts.tabId) headers['x-tab-id'] = opts.tabId;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(`${getConfig().APP_BASE_URL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  });
}

function sendMessage(s: TestSession, text: string, signal?: AbortSignal): Promise<Response> {
  return messagesPOST(request('POST', `/api/sessions/${s.id}/messages`, { tabId: s.tabId, body: { text }, signal }), {
    params: Promise.resolve({ id: s.id }),
  });
}

async function history(s: TestSession): Promise<{ seq: number; role: string; content: string; createdAt: string }[]> {
  const res = await messagesGET(request('GET', `/api/sessions/${s.id}/messages`), {
    params: Promise.resolve({ id: s.id }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { messages: { seq: number; role: string; content: string; createdAt: string }[] })
    .messages;
}

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

// Reads the whole SSE body and parses `event:` / `data:` frames (comments such as `: ping` are skipped).
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

/** Holds every fake LLM run until `open()` is called. */
function gateFakeRun(): { open: () => void; restore: () => void } {
  const original = fake.run.bind(fake);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
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

describe('POST /messages (SSE)', () => {
  it('streams token, patch, question and done events in SSE format (AC1)', async () => {
    const s = await createLockedSession();
    fake.enqueue([
      { type: 'text-delta', text: 'Drafted scope. ' },
      patch('Scope', 'Login via SSO only.'),
      { type: 'tool-call', name: 'ask_question', args: { text: 'Which IdP?', section: 'Security' } },
      { type: 'text-delta', text: 'One question.' },
      { type: 'done' },
    ]);

    const res = await sendMessage(s, 'We need SSO login.');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const raw = await res.clone().text();
    expect(raw).toMatch(/^event: token\ndata: \{.*\}\n\n/);
    const frames = await readSse(res);
    expect(frames.map((f) => f.event)).toEqual(['token', 'patch', 'question', 'token', 'done']);
    expect(frames[0].data).toMatchObject({ text: 'Drafted scope. ' });
    expect(frames[1].data).toMatchObject({ section: 'Scope', version: 1 });
    expect(frames[2].data).toMatchObject({ text: 'Which IdP?', section: 'Security', questionId: expect.any(String) });
    expect(frames[4].data).toMatchObject({ messageSeq: 2 });

    const messages = await history(s);
    expect(messages.map(({ seq, role, content }) => ({ seq, role, content }))).toEqual([
      { seq: 1, role: 'facilitator', content: 'We need SSO login.' },
      { seq: 2, role: 'ai', content: 'Drafted scope. One question.' },
    ]);
    expect(typeof messages[0].createdAt).toBe('string');
  });

  it('rejects an over-long message, a missing tab id and an empty message', async () => {
    const s = await createLockedSession();
    expect((await sendMessage(s, 'x'.repeat(10_001))).status).toBe(413);
    const noTab = await messagesPOST(request('POST', `/api/sessions/${s.id}/messages`, { body: { text: 'hi' } }), {
      params: Promise.resolve({ id: s.id }),
    });
    expect(noTab.status).toBe(400);
    expect((await sendMessage(s, '   ')).status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it('returns 409 turn_in_progress for a concurrent turn and releases the lock when the first completes (AC2)', async () => {
    const s = await createLockedSession();
    const gate = gateFakeRun();
    try {
      fake.enqueue([patch('Scope', 'First turn scope'), { type: 'done' }]);
      const first = await sendMessage(s, 'First');
      expect(first.status).toBe(200);

      const second = await sendMessage(s, 'Second');
      expect(second.status).toBe(409);
      expect(await errorCode(second)).toBe('turn_in_progress');

      gate.open();
      const frames = await readSse(first);
      expect(frames.at(-1)?.event).toBe('done');
    } finally {
      gate.restore();
    }

    fake.enqueue([patch('Scope', 'Third turn scope'), { type: 'done' }]);
    const third = await sendMessage(s, 'Third');
    expect(third.status).toBe(200);
    expect((await readSse(third)).at(-1)?.event).toBe('done');
    // The rejected message was never persisted.
    expect((await history(s)).map((m) => m.content)).not.toContain('Second');
  });

  it('releases the turn lock after the client aborts (AC2)', async () => {
    const s = await createLockedSession();
    const controller = new AbortController();
    const gate = gateFakeRun();
    try {
      fake.enqueue([patch('Scope', 'Never applied'), { type: 'done' }]);
      const first = await sendMessage(s, 'Abort me', controller.signal);
      expect(first.status).toBe(200);
      expect((await sendMessage(s, 'Blocked')).status).toBe(409);

      controller.abort();
      gate.open();
      await first.text().catch(() => '');
    } finally {
      gate.restore();
    }

    let next: Response | undefined;
    for (let i = 0; i < 50; i++) {
      fake.enqueue([patch('Scope', 'After abort'), { type: 'done' }]);
      next = await sendMessage(s, 'After abort');
      if (next.status !== 409) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(next?.status).toBe(200);
    expect((await readSse(next!)).at(-1)?.event).toBe('done');

    // The aborted turn's facilitator message stayed persisted and its failure was audited.
    const messages = await history(s);
    expect(messages.map((m) => m.content)).toContain('Abort me');
    const audits = await query<{ result: string }>(
      "SELECT result FROM audit_record WHERE session_id = $1 AND action = 'ai.suggestion' ORDER BY id",
      [s.id],
    );
    expect(audits[0].result).toBe('failure');
  });

  it('emits an SSE error event with correlationId on LLM failure and keeps the facilitator message (AC5)', async () => {
    const s = await createLockedSession();
    fake.enqueue([
      { type: 'text-delta', text: 'Partial' },
      { type: 'error', code: 'rate_limited', message: 'Model is rate limited', retryable: true },
    ]);

    const res = await sendMessage(s, 'Keep this message.');
    expect(res.status).toBe(200);
    const correlationId = res.headers.get('x-correlation-id');
    expect(correlationId).toBeTruthy();
    const frames = await readSse(res);
    expect(frames.map((f) => f.event)).toEqual(['token', 'error']);
    expect(frames[1].data).toEqual({ code: 'rate_limited', message: 'Model is rate limited', correlationId });

    const messages = await history(s);
    expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'facilitator', content: 'Keep this message.' },
    ]);

    // The lock is free again.
    fake.enqueue([patch('Scope', 'Retry'), { type: 'done' }]);
    const retry = await sendMessage(s, 'Retry');
    expect(retry.status).toBe(200);
    await readSse(retry);
  });

  it('maps an error thrown after the stream started to an internal_error event', async () => {
    const s = await createLockedSession();
    const original = fake.run.bind(fake);
    fake.run = async function* () {
      throw new Error('boom');
    };
    try {
      const res = await sendMessage(s, 'Hello');
      expect(res.status).toBe(200);
      const frames = await readSse(res);
      expect(frames).toEqual([
        {
          event: 'error',
          data: { code: 'internal_error', message: 'Unexpected error', correlationId: res.headers.get('x-correlation-id') },
        },
      ]);
    } finally {
      fake.run = original;
    }
    expect((await history(s)).map((m) => m.content)).toEqual(['Hello']);
  });
});

describe('POST /notes', () => {
  it('stores a note and triggers no LLM call (AC3)', async () => {
    const s = await createLockedSession();
    const res = await notesPOST(
      request('POST', `/api/sessions/${s.id}/notes`, { tabId: s.tabId, body: { text: 'Context: legacy LDAP exists.' } }),
      { params: Promise.resolve({ id: s.id }) },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ seq: 1, role: 'note', content: 'Context: legacy LDAP exists.' });
    expect(fake.calls).toHaveLength(0);

    const messages = await history(s);
    expect(messages.map(({ seq, role, content }) => ({ seq, role, content }))).toEqual([
      { seq: 1, role: 'note', content: 'Context: legacy LDAP exists.' },
    ]);

    const tooLong = await notesPOST(
      request('POST', `/api/sessions/${s.id}/notes`, { tabId: s.tabId, body: { text: 'x'.repeat(10_001) } }),
      { params: Promise.resolve({ id: s.id }) },
    );
    expect(tooLong.status).toBe(413);
  });
});

describe('questions', () => {
  async function insertQuestion(s: TestSession, text: string): Promise<string> {
    const [row] = await query<{ id: string }>(
      "INSERT INTO ai_question (session_id, section, text, status) VALUES ($1, 'Security', $2, 'open') RETURNING id",
      [s.id, text],
    );
    return row.id;
  }

  function dismiss(s: TestSession, qid: string, body?: unknown): Promise<Response> {
    return dismissPOST(request('POST', `/api/sessions/${s.id}/questions/${qid}/dismiss`, { tabId: s.tabId, body }), {
      params: Promise.resolve({ id: s.id, qid }),
    });
  }

  it('dismisses a question with a reason and writes question.dismissed (AC4)', async () => {
    const s = await createLockedSession();
    const qid = await insertQuestion(s, 'Which IdP?');
    const other = await insertQuestion(s, 'Which region?');

    const res = await dismiss(s, qid, { reason: 'Out of scope' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: qid, status: 'dismissed', dismissReason: 'Out of scope' });

    const [row] = await query<{ status: string; dismiss_reason: string }>(
      'SELECT status, dismiss_reason FROM ai_question WHERE id = $1',
      [qid],
    );
    expect(row).toEqual({ status: 'dismissed', dismiss_reason: 'Out of scope' });

    const audits = await query<{ user_id: string; details: Record<string, unknown>; correlation_id: string }>(
      "SELECT user_id, details, correlation_id FROM audit_record WHERE session_id = $1 AND action = 'question.dismissed'",
      [s.id],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].user_id).toBe(ALICE.accountId);
    expect(audits[0].details).toMatchObject({ questionId: qid, reason: 'Out of scope' });
    expect(audits[0].correlation_id).toBe(res.headers.get('x-correlation-id'));

    const list = await questionsGET(request('GET', `/api/sessions/${s.id}/questions`), {
      params: Promise.resolve({ id: s.id }),
    });
    expect(list.status).toBe(200);
    const { questions } = (await list.json()) as { questions: { id: string; status: string; dismissReason: string | null }[] };
    expect(questions.map(({ id, status, dismissReason }) => ({ id, status, dismissReason }))).toEqual([
      { id: qid, status: 'dismissed', dismissReason: 'Out of scope' },
      { id: other, status: 'open', dismissReason: null },
    ]);

    // Already dismissed -> 409; unknown -> 404; reason too long -> 413.
    const again = await dismiss(s, qid);
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe('question_not_open');
    expect((await dismiss(s, randomUUID())).status).toBe(404);
    expect((await dismiss(s, other, { reason: 'r'.repeat(501) })).status).toBe(413);
  });

  it('dismisses without a reason', async () => {
    const s = await createLockedSession();
    const qid = await insertQuestion(s, 'Which IdP?');
    const res = await dismiss(s, qid);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: qid, status: 'dismissed', dismissReason: null });
  });
});
