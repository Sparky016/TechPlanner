import { vi } from 'vitest';

// The facilitator must use FakeLlmClient; set before setup imports the config.
vi.hoisted(() => {
  process.env.LLM_FAKE = '1';
});

import { resetDatabase } from './setup';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '@/server/config';
import { db, query } from '@/server/db/pool';
import { runFacilitatorTurn, type FacilitatorEvent } from '@/server/facilitator/runTurn';
import { stopQueue } from '@/server/jobs/queue';
import { FakeLlmClient, getLlmClient, resetLlmClientForTests, type FakeStep } from '@/server/llm';
import { isEvaluationPending } from '@/server/readiness/schedule';
import { getWorkingCopy, initWorkingCopy, updateSectionByUser } from '@/server/spec/workingCopyRepo';

const USER = { accountId: 'acc-1', displayName: 'Ada' };

let fake: FakeLlmClient;
let keySeq = 0;

async function createSession(): Promise<string> {
  keySeq++;
  const rows = await query<{ id: string }>(
    'INSERT INTO planning_session (primary_ticket_key, ticket_keys) VALUES ($1, ARRAY[$1]) RETURNING id',
    [`FAC-${keySeq}`],
  );
  await initWorkingCopy(rows[0].id);
  return rows[0].id;
}

async function collect(it: AsyncIterable<FacilitatorEvent>): Promise<FacilitatorEvent[]> {
  const out: FacilitatorEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function patch(section: string, content: string, op = 'replace'): FakeStep {
  return { type: 'tool-call', name: 'apply_section_patch', args: { section, op, content } };
}

const turn = (sessionId: string, text: string) => collect(runFacilitatorTurn({ sessionId, user: USER, text }));

beforeAll(async () => {
  await resetDatabase();
  resetConfigForTests();
  resetLlmClientForTests();
  fake = getLlmClient() as FakeLlmClient;
});

beforeEach(() => fake.reset());

afterAll(async () => {
  await stopQueue();
  await db.end();
});

describe('runFacilitatorTurn persistence', () => {
  it('streams token, patch, question and done events and persists both messages and the question (AC1)', async () => {
    const sessionId = await createSession();
    fake.enqueue([
      { type: 'text-delta', text: 'Drafted scope. ' },
      patch('Scope', 'Login via SSO only.'),
      patch('Risks', '- SSO outage blocks login', 'append'),
      { type: 'tool-call', name: 'ask_question', args: { text: 'What is the p95 login latency target?', section: 'Performance' } },
      { type: 'text-delta', text: 'One question.' },
      { type: 'done' },
    ]);

    const events = await turn(sessionId, 'We need SSO login.');
    expect(events.map((e) => e.type)).toEqual(['token', 'patch', 'patch', 'question', 'token', 'done']);
    expect(events[1]).toEqual({ type: 'patch', section: 'Scope', version: 1 });
    expect(events[2]).toEqual({ type: 'patch', section: 'Risks', version: 2 });
    const question = events[3] as Extract<FacilitatorEvent, { type: 'question' }>;
    expect(question).toMatchObject({ text: 'What is the p95 login latency target?', section: 'Performance' });

    const messages = await query<{ seq: number; role: string; content: string }>(
      'SELECT seq, role, content FROM conversation_message WHERE session_id = $1 ORDER BY seq',
      [sessionId],
    );
    expect(messages).toEqual([
      { seq: 1, role: 'facilitator', content: 'We need SSO login.' },
      { seq: 2, role: 'ai', content: 'Drafted scope. One question.' },
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', messageSeq: 2 });

    const questions = await query<{ id: string; section: string; text: string; status: string }>(
      'SELECT id, section, text, status FROM ai_question WHERE session_id = $1',
      [sessionId],
    );
    expect(questions).toEqual([
      { id: question.questionId, section: 'Performance', text: 'What is the p95 login latency target?', status: 'open' },
    ]);

    const wc = await getWorkingCopy(sessionId);
    expect(wc?.sections.Scope.body).toBe('Login via SSO only.');
    expect(wc?.sections.Risks.body).toBe('- SSO outage blocks login');
    expect(wc?.sections.Scope.lastAiReadAt).not.toBeNull();

    // The model saw the replayed history ending with the facilitator's message.
    expect(fake.calls[0].messages.at(-1)).toEqual({ role: 'user', content: 'We need SSO login.' });
  });

  it('turns a patch to a section the user edited after turn start into a suggestion (AC2)', async () => {
    const sessionId = await createSession();
    // Edited before the turn: the AI reads it at turn start, so its patch applies.
    let version = await updateSectionByUser(sessionId, 'Assumptions', 'Users have SSO accounts.', 0);
    version = await updateSectionByUser(sessionId, 'Scope', 'Human scope v1', version);

    const original = fake.run.bind(fake);
    fake.run = async function* (opts) {
      // The facilitator edits Scope while the model is working.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await updateSectionByUser(sessionId, 'Scope', 'Human scope v2', version);
      yield* original(opts);
    };
    try {
      fake.enqueue([patch('Scope', 'AI scope'), patch('Assumptions', 'AI assumptions'), { type: 'done' }]);
      const events = await turn(sessionId, 'Refine scope.');
      const suggestion = events.find((e) => e.type === 'suggestion');
      expect(suggestion).toMatchObject({ type: 'suggestion', section: 'Scope', suggestionId: expect.any(String) });
      expect(events.filter((e) => e.type === 'patch')).toEqual([
        { type: 'patch', section: 'Assumptions', version: expect.any(Number) },
      ]);

      const wc = await getWorkingCopy(sessionId);
      expect(wc?.sections.Scope.body).toBe('Human scope v2');
      expect(wc?.sections.Assumptions.body).toBe('AI assumptions');
      const pending = await query<{ section: string; status: string; patch: { content: string } }>(
        'SELECT section, status, patch FROM pending_suggestion WHERE session_id = $1',
        [sessionId],
      );
      expect(pending).toEqual([{ section: 'Scope', status: 'pending', patch: expect.objectContaining({ content: 'AI scope' }) }]);
    } finally {
      fake.run = original;
    }
  });

  it('writes exactly one ai.suggestion audit per turn and schedules an evaluation after an applied patch (AC5)', async () => {
    const sessionId = await createSession();
    fake.enqueue([
      patch('Scope', 'In scope: login.'),
      { type: 'tool-call', name: 'ask_question', args: { text: 'Who owns the IdP?' } },
      { type: 'done' },
    ]);
    await turn(sessionId, 'Start.');

    const audits = await query<{ user_id: string; result: string; details: Record<string, unknown> }>(
      "SELECT user_id, result, details FROM audit_record WHERE action = 'ai.suggestion' AND session_id = $1",
      [sessionId],
    );
    expect(audits).toHaveLength(1);
    const [q] = await query<{ id: string }>('SELECT id FROM ai_question WHERE session_id = $1', [sessionId]);
    expect(audits[0]).toMatchObject({ user_id: 'acc-1', result: 'success' });
    expect(audits[0].details).toMatchObject({
      messageSeq: 2,
      patches: [{ section: 'Scope', op: 'replace', disposition: 'applied' }],
      questions: [q.id],
      model: 'test-facilitator-model',
    });
    expect(await isEvaluationPending(sessionId)).toBe(true);

    // A second turn (with the corrective follow-up) is still audited exactly once.
    fake.enqueue([{ type: 'text-delta', text: 'Hmm.' }, { type: 'done' }], [{ type: 'text-delta', text: 'Ok.' }, { type: 'done' }]);
    await turn(sessionId, 'Anything else?');
    expect(fake.calls).toHaveLength(3);
    const after = await query("SELECT 1 FROM audit_record WHERE action = 'ai.suggestion' AND session_id = $1", [sessionId]);
    expect(after).toHaveLength(2);
  });

  it('does not schedule an evaluation when no patch was applied', async () => {
    const sessionId = await createSession();
    fake.enqueue([{ type: 'tool-call', name: 'ask_question', args: { text: 'What is the rollback plan?' } }, { type: 'done' }]);
    await turn(sessionId, 'Hi.');
    expect(await isEvaluationPending(sessionId)).toBe(false);
  });

  it('keeps the facilitator message and emits an error event when the model fails', async () => {
    const sessionId = await createSession();
    fake.enqueue([{ type: 'error', code: 'transient', message: 'upstream', retryable: true }]);
    const events = await turn(sessionId, 'Hello?');
    expect(events).toEqual([{ type: 'error', code: 'transient', message: 'upstream' }]);
    const messages = await query<{ role: string }>('SELECT role FROM conversation_message WHERE session_id = $1', [sessionId]);
    expect(messages).toEqual([{ role: 'facilitator' }]);
  });
});
