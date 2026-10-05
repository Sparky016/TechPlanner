import { vi } from 'vitest';

// The evaluator must use FakeLlmClient; set before setup imports the config.
vi.hoisted(() => {
  process.env.LLM_FAKE = '1';
});

import { resetDatabase } from './setup';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '@/server/config';
import { db, query } from '@/server/db/pool';
import { FakeLlmClient, getLlmClient, resetLlmClientForTests, type FakeStep } from '@/server/llm';
import { evaluateSession } from '@/server/readiness/evaluate';
import { initWorkingCopy } from '@/server/spec/workingCopyRepo';
import { computeReadinessScore } from '../../src/lib/readiness/score';
import type { SectionStatus, SectionStatuses } from '../../src/lib/readiness/types';
import { SECTION_NAMES } from '../../src/lib/spec/sections';

let fake: FakeLlmClient;
let keySeq = 0;

async function createSession(): Promise<string> {
  keySeq++;
  const rows = await query<{ id: string }>(
    'INSERT INTO planning_session (primary_ticket_key, ticket_keys) VALUES ($1, ARRAY[$1]) RETURNING id',
    [`EVAL-${keySeq}`],
  );
  await initWorkingCopy(rows[0].id);
  return rows[0].id;
}

function script(statuses: SectionStatuses, extra: FakeStep[] = []): FakeStep[] {
  return [
    ...SECTION_NAMES.map(
      (section): FakeStep => ({
        type: 'tool-call',
        name: 'report_section_status',
        args: { section, status: statuses[section], reason: `${section}: ${statuses[section]}` },
      }),
    ),
    ...extra,
    { type: 'done' },
  ];
}

const CYCLE: SectionStatus[] = ['complete', 'partial', 'complete', 'missing'];
function mixed(): SectionStatuses {
  const out = {} as SectionStatuses;
  SECTION_NAMES.forEach((n, i) => (out[n] = CYCLE[i % CYCLE.length]));
  out['Acceptance Criteria'] = 'missing';
  return out;
}

beforeAll(async () => {
  await resetDatabase();
  resetConfigForTests();
  resetLlmClientForTests();
  fake = getLlmClient() as FakeLlmClient;
});

beforeEach(() => fake.reset());

afterAll(async () => {
  await db.end();
});

describe('evaluateSession persistence', () => {
  it('stores one evaluation row with the computeReadinessScore score and audits it', async () => {
    const sessionId = await createSession();
    const statuses = mixed();
    fake.enqueue(
      script(statuses, [
        {
          type: 'tool-call',
          name: 'raise_issue',
          args: { severity: 'warning', section: 'Logging', description: 'No log levels defined' },
        },
      ]),
    );

    const r = await evaluateSession(sessionId, { userId: 'acc-1', userDisplayName: 'Ada' });
    expect(fake.calls).toHaveLength(1);
    expect(r.score).toBe(computeReadinessScore(statuses));

    const evals = await query<{ id: string; score: number; section_statuses: Record<string, unknown> }>(
      'SELECT id, score, section_statuses FROM evaluation WHERE session_id = $1',
      [sessionId],
    );
    expect(evals).toHaveLength(1);
    expect(evals[0].id).toBe(r.evaluationId);
    expect(evals[0].score).toBe(r.score);
    expect(evals[0].section_statuses['Acceptance Criteria']).toEqual({
      status: 'missing',
      reason: 'Acceptance Criteria: missing',
    });

    const issues = await query<{ severity: string; section: string; status: string }>(
      'SELECT severity, section, status FROM issue WHERE session_id = $1 ORDER BY section',
      [sessionId],
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        { severity: 'critical', section: 'Acceptance Criteria', status: 'open' },
        { severity: 'warning', section: 'Logging', status: 'open' },
      ]),
    );
    expect(r.gatePasses).toBe(false);

    const audits = await query<{ user_id: string; details: Record<string, unknown> }>(
      "SELECT user_id, details FROM audit_record WHERE action = 'readiness.evaluated' AND session_id = $1",
      [sessionId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].user_id).toBe('acc-1');
    expect(audits[0].details).toMatchObject({
      evaluationId: r.evaluationId,
      score: r.score,
      gatePasses: false,
      counts: {
        critical: r.issues.filter((i) => i.severity === 'critical').length,
        warning: 1,
        informational: 0,
      },
    });
    expect((audits[0].details.statuses as Record<string, string>)['Acceptance Criteria']).toBe('missing');
  });

  it('re-evaluation resolves closed gaps, keeps accepted-risk and writes one audit record per evaluation', async () => {
    const sessionId = await createSession();
    const statuses = mixed();
    const warning: FakeStep = {
      type: 'tool-call',
      name: 'raise_issue',
      args: { severity: 'warning', section: 'Performance', description: 'No latency target' },
    };
    fake.enqueue(script(statuses, [warning]));
    await evaluateSession(sessionId, { userId: 'acc-1' });
    await query("UPDATE issue SET status = 'accepted-risk' WHERE session_id = $1 AND section = 'Performance'", [
      sessionId,
    ]);

    const all = {} as SectionStatuses;
    for (const n of SECTION_NAMES) all[n] = 'complete';
    fake.enqueue(script(all, [warning]));
    const r = await evaluateSession(sessionId, { userId: 'acc-1' });

    expect(r.score).toBe(100);
    expect(r.gatePasses).toBe(true);
    expect(r.issues).toEqual([expect.objectContaining({ section: 'Performance', status: 'accepted-risk' })]);
    const rows = await query<{ section: string; status: string; resolved_at: Date | null }>(
      'SELECT section, status, resolved_at FROM issue WHERE session_id = $1',
      [sessionId],
    );
    for (const row of rows) {
      if (row.section === 'Performance') expect(row.status).toBe('accepted-risk');
      else {
        expect(row.status).toBe('resolved');
        expect(row.resolved_at).not.toBeNull();
      }
    }
    const evals = await query('SELECT id FROM evaluation WHERE session_id = $1', [sessionId]);
    expect(evals).toHaveLength(2);
    const audits = await query(
      "SELECT id FROM audit_record WHERE action = 'readiness.evaluated' AND session_id = $1",
      [sessionId],
    );
    expect(audits).toHaveLength(2);
  });
});
