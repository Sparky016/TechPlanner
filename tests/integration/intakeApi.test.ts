import { vi } from 'vitest';

// The facilitator must use FakeLlmClient; set before setup imports the config.
vi.hoisted(() => {
  process.env.LLM_FAKE = '1';
});

import { resetDatabase } from './setup';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as analyzePOST } from '@/app/api/sessions/[id]/analyze/route';
import { POST as messagesPOST } from '@/app/api/sessions/[id]/messages/route';
import { SESSION_COOKIE, createSession } from '@/server/auth/session';
import { getConfig, resetConfigForTests } from '@/server/config';
import { encryptSecret } from '@/server/crypto/secrets';
import { db, query, withTransaction } from '@/server/db/pool';
import { QUESTION_LIMIT_MESSAGE } from '@/server/facilitator/tools';
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/server/http/csrf';
import { stopQueue } from '@/server/jobs/queue';
import { FakeLlmClient, getLlmClient, resetLlmClientForTests, type FakeStep } from '@/server/llm';
import { clearAccessCacheForTests } from '@/server/sessions/access';
import { acquireOrRenewLock } from '@/server/sessions/lock';
import { initWorkingCopy } from '@/server/spec/workingCopyRepo';

// POST /api/sessions/:id/analyze (GI-9, GI-10). Sessions are marked ingested with SQL rather than via /ingest.

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

async function createLockedSession(
  opts: { ingested?: boolean; analyzed?: boolean; clarificationEnded?: boolean } = {},
): Promise<TestSession> {
  keySeq++;
  const rows = await query<{ id: string }>(
    `INSERT INTO planning_session (primary_ticket_key, ticket_keys, facilitator_id, ingested_at, analyzed_at, clarification_ended)
     VALUES ($1, ARRAY[$1], $2, CASE WHEN $3 THEN now() END, CASE WHEN $4 THEN now() END, $5) RETURNING id`,
    [`INT-${keySeq}`, ALICE.accountId, opts.ingested ?? true, opts.analyzed ?? false, opts.clarificationEnded ?? false],
  );
  const id = rows[0].id;
  await initWorkingCopy(id);
  const tabId = randomUUID();
  await acquireOrRenewLock(id, tabId);
  return { id, tabId };
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

function analyze(s: TestSession, opts: { tabId?: string | null } = {}): Promise<Response> {
  const tabId = opts.tabId === null ? undefined : (opts.tabId ?? s.tabId);
  return analyzePOST(request(`/api/sessions/${s.id}/analyze`, { tabId }), {
    params: Promise.resolve({ id: s.id }),
  });
}

function sendMessage(s: TestSession, text: string): Promise<Response> {
  return messagesPOST(request(`/api/sessions/${s.id}/messages`, { tabId: s.tabId, body: { text } }), {
    params: Promise.resolve({ id: s.id }),
  });
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

function ask(text: string): FakeStep {
  return { type: 'tool-call', name: 'ask_question', args: { text } };
}

async function messages(s: TestSession): Promise<{ role: string; content: string }[]> {
  return query('SELECT role, content FROM conversation_message WHERE session_id = $1 ORDER BY seq', [s.id]);
}

async function analyzedAt(s: TestSession): Promise<Date | null> {
  const [row] = await query<{ analyzed_at: Date | null }>('SELECT analyzed_at FROM planning_session WHERE id = $1', [
    s.id,
  ]);
  return row.analyzed_at;
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

describe('POST /analyze (SSE)', () => {
  it('streams token, patch, question and done, sets analyzed_at and accepts up to 8 questions (AC1)', async () => {
    const s = await createLockedSession();
    fake.enqueue([
      { type: 'text-delta', text: 'Login via SSO for staff. ' },
      patch('Scope', 'Staff SSO login.'),
      ...Array.from({ length: 9 }, (_, i) => ask(`Gap ${i + 1}?`)),
      { type: 'text-delta', text: 'Eight questions.' },
      { type: 'done' },
    ]);
    // Record what each tool call returned to the model.
    const toolResults: string[] = [];
    const original = fake.run.bind(fake);
    fake.run = async function* (opts) {
      for await (const e of original(opts)) {
        if (e.type === 'tool-call' && e.name === 'ask_question') toolResults.push(e.result);
        yield e;
      }
    };
    let frames: SseFrame[];
    let correlationId: string | null;
    try {
      const res = await analyze(s);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
      correlationId = res.headers.get('x-correlation-id');
      frames = await readSse(res);
    } finally {
      fake.run = original;
    }

    expect(frames.map((f) => f.event)).toEqual(['token', 'patch', ...Array(8).fill('question'), 'token', 'done']);
    expect(frames[1].data).toMatchObject({ section: 'Scope', version: 1 });
    expect(frames[2].data).toMatchObject({ text: 'Gap 1?', questionId: expect.any(String) });
    expect(frames.at(-1)?.data).toMatchObject({ messageSeq: 2 });
    expect(toolResults).toHaveLength(9);
    expect(toolResults.slice(0, 8).every((r) => r.startsWith('Question recorded'))).toBe(true);
    expect(toolResults[8]).toBe(QUESTION_LIMIT_MESSAGE);
    const questions = await query('SELECT 1 FROM ai_question WHERE session_id = $1', [s.id]);
    expect(questions).toHaveLength(8);

    expect(await messages(s)).toEqual([
      { role: 'system', content: 'Initial analysis requested by Alice.' },
      { role: 'ai', content: 'Login via SSO for staff. Eight questions.' },
    ]);
    expect(await analyzedAt(s)).toBeInstanceOf(Date);

    // The model got the analysis instruction, the raised limit and the notice as the last message.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].system).toContain('This is the initial analysis of newly ingested tickets.');
    expect(fake.calls[0].system).toContain('Ask up to 8 questions');
    expect(fake.calls[0].tools.map((t) => t.name)).toContain('ask_question');
    expect(fake.calls[0].messages.at(-1)).toEqual({
      role: 'user',
      content: '[System notice]\nInitial analysis requested by Alice.',
    });

    const audits = await query<{ result: string; correlation_id: string; details: Record<string, unknown> }>(
      "SELECT result, correlation_id, details FROM audit_record WHERE session_id = $1 AND action = 'ai.suggestion'",
      [s.id],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ result: 'success', correlation_id: correlationId });
    expect(audits[0].details).toMatchObject({ turnKind: 'analysis', messageSeq: 2 });
    expect(audits[0].details.questions).toHaveLength(8);
  });

  it('returns 409 not_ingested before ingest without persisting anything (AC2)', async () => {
    const s = await createLockedSession({ ingested: false });
    const res = await analyze(s);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('not_ingested');
    expect(fake.calls).toHaveLength(0);
    expect(await messages(s)).toEqual([]);

    // The turn lock was released.
    await query('UPDATE planning_session SET ingested_at = now() WHERE id = $1', [s.id]);
    fake.enqueue([patch('Scope', 'Drafted'), { type: 'done' }]);
    const ok = await analyze(s);
    expect(ok.status).toBe(200);
    expect((await readSse(ok)).at(-1)?.event).toBe('done');
  });

  it('returns 409 already_analyzed once an analysis has succeeded (AC2)', async () => {
    const s = await createLockedSession();
    fake.enqueue([patch('Scope', 'Drafted'), { type: 'done' }]);
    expect((await readSse(await analyze(s))).at(-1)?.event).toBe('done');

    const again = await analyze(s);
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe('already_analyzed');
    expect(fake.calls).toHaveLength(1);

    // A session backfilled as analyzed (migration 0005) is rejected the same way; messages still work.
    const old = await createLockedSession({ analyzed: true });
    expect(await errorCode(await analyze(old))).toBe('already_analyzed');
    fake.enqueue([patch('Scope', 'Message turn'), { type: 'done' }]);
    const msg = await sendMessage(old, 'Hello');
    expect(msg.status).toBe(200);
    expect((await readSse(msg)).at(-1)?.event).toBe('done');
  });

  it('shares the turn lock with message turns: 409 turn_in_progress either way (AC2, GI-22)', async () => {
    const s = await createLockedSession();
    const gate = gateFakeRun();
    try {
      fake.enqueue([patch('Scope', 'Message turn'), { type: 'done' }]);
      const message = await sendMessage(s, 'First');
      expect(message.status).toBe(200);

      const blocked = await analyze(s);
      expect(blocked.status).toBe(409);
      expect(await errorCode(blocked)).toBe('turn_in_progress');

      gate.open();
      expect((await readSse(message)).at(-1)?.event).toBe('done');
    } finally {
      gate.restore();
    }

    const second = gateFakeRun();
    try {
      fake.enqueue([patch('Scope', 'Analysis'), { type: 'done' }]);
      const analysis = await analyze(s);
      expect(analysis.status).toBe(200);

      const message = await sendMessage(s, 'During analysis');
      expect(message.status).toBe(409);
      expect(await errorCode(message)).toBe('turn_in_progress');
      const parallel = await analyze(s);
      expect(parallel.status).toBe(409);
      expect(await errorCode(parallel)).toBe('turn_in_progress');

      second.open();
      expect((await readSse(analysis)).at(-1)?.event).toBe('done');
    } finally {
      second.restore();
    }

    // Checked under the lock: the request that waited out the first analysis cannot start a second one.
    expect(await errorCode(await analyze(s))).toBe('already_analyzed');
    expect((await messages(s)).map((m) => m.content)).not.toContain('During analysis');
    expect((await messages(s)).filter((m) => m.role === 'system')).toHaveLength(1);
  });

  it('requires the tab id', async () => {
    const s = await createLockedSession();
    const res = await analyze(s, { tabId: null });
    expect(res.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it('emits an SSE error on LLM failure, keeps the system message and leaves analyzed_at NULL (AC3)', async () => {
    const s = await createLockedSession();
    fake.enqueue([
      { type: 'text-delta', text: 'Partial' },
      { type: 'error', code: 'rate_limited', message: 'Model is rate limited', retryable: true },
    ]);
    const res = await analyze(s);
    expect(res.status).toBe(200);
    const correlationId = res.headers.get('x-correlation-id');
    const frames = await readSse(res);
    expect(frames.map((f) => f.event)).toEqual(['token', 'error']);
    expect(frames[1].data).toEqual({ code: 'rate_limited', message: 'Model is rate limited', correlationId });

    expect(await messages(s)).toEqual([{ role: 'system', content: 'Initial analysis requested by Alice.' }]);
    expect(await analyzedAt(s)).toBeNull();
    const audits = await query<{ result: string; details: Record<string, unknown> }>(
      "SELECT result, details FROM audit_record WHERE session_id = $1 AND action = 'ai.suggestion'",
      [s.id],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ result: 'failure', details: { turnKind: 'analysis', errorCode: 'rate_limited' } });

    // The analysis can be retried (Analyze ticket, GI-8).
    fake.enqueue([patch('Scope', 'Retry'), { type: 'done' }]);
    const retry = await analyze(s);
    expect(retry.status).toBe(200);
    expect((await readSse(retry)).at(-1)?.event).toBe('done');
    expect(await analyzedAt(s)).toBeInstanceOf(Date);
  });

  it('runs without ask_question after End clarification and still sets analyzed_at (GI-24)', async () => {
    const s = await createLockedSession({ clarificationEnded: true });
    fake.enqueue([patch('Scope', 'Drafted only'), { type: 'done' }]);
    const frames = await readSse(await analyze(s));
    expect(frames.map((f) => f.event)).toEqual(['patch', 'done']);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].tools.map((t) => t.name)).not.toContain('ask_question');
    expect(fake.calls[0].system).toContain('Clarification has ended');
    expect(fake.calls[0].system).not.toContain('Ask up to');
    expect(await analyzedAt(s)).toBeInstanceOf(Date);
  });
});
