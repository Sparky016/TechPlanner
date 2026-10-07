import { beforeEach, describe, expect, it, vi } from 'vitest';

// Modules below read config at load time (db pool); give them a valid environment first. No connection is made.
vi.hoisted(() => {
  Object.assign(process.env, {
    ATLASSIAN_CLIENT_ID: 'client-id',
    ATLASSIAN_CLIENT_SECRET: 'client-secret',
    ATLASSIAN_CLOUD_ID: 'cloud-id',
    OAUTH_REDIRECT_URI: 'http://localhost:3000/auth/callback',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    DATABASE_URL: 'postgres://techplanner:techplanner@localhost:5432/techplanner_t24',
    COPILOT_GITHUB_TOKEN: 'ghp_x',
    FACILITATOR_MODEL: 'model-a',
    EVALUATOR_MODEL: 'model-b',
    CONFLUENCE_SPACE_KEY: 'ENG',
    CONFLUENCE_PARENT_PAGE_ID: '12345',
    APP_BASE_URL: 'http://localhost:3000',
    LLM_FAKE: '1',
  });
});

vi.mock('@/server/db/pool', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/server/audit/audit', () => ({ recordAudit: vi.fn() }));
vi.mock('@/server/spec/workingCopyRepo', () => ({
  getWorkingCopy: vi.fn(),
  WorkingCopyNotFoundError: class WorkingCopyNotFoundError extends Error {},
}));

import { recordAudit } from '@/server/audit/audit';
import { resetConfigForTests } from '@/server/config';
import { query, withTransaction } from '@/server/db/pool';
import { FakeLlmClient, getLlmClient, resetLlmClientForTests, type FakeStep } from '@/server/llm';
import { getWorkingCopy } from '@/server/spec/workingCopyRepo';
import { SECTION_NAMES, type SectionName } from '../../lib/spec/sections';
import { evaluateSession, EvaluatorRunError, NOT_EVALUATED_REASON } from './evaluate';
import type { ExistingIssue } from './reconcile';

const SESSION = '00000000-0000-4000-8000-000000000001';

function statusCalls(names: readonly SectionName[], status = 'complete'): FakeStep[] {
  return names.map((section) => ({
    type: 'tool-call',
    name: 'report_section_status',
    args: { section, status, reason: `${section} looks ${status}` },
  }));
}

let existingIssues: ExistingIssue[];
let sql: { text: string; params?: unknown[] }[];
let fake: FakeLlmClient;

beforeEach(() => {
  vi.clearAllMocks();
  resetConfigForTests();
  resetLlmClientForTests();
  fake = getLlmClient() as FakeLlmClient;
  existingIssues = [];
  sql = [];
  let seq = 0;
  vi.mocked(getWorkingCopy).mockResolvedValue({
    sessionId: SESSION,
    version: 1,
    updatedAt: new Date(),
    sections: Object.fromEntries(
      SECTION_NAMES.map((n) => [n, { body: `${n} body`, lastAiReadAt: null, lastUserEditAt: null }]),
    ) as never,
  });
  vi.mocked(query).mockImplementation(async () => existingIssues as never);
  const client = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      sql.push({ text, params });
      if (/FROM issue/.test(text)) return { rows: existingIssues };
      if (/INSERT INTO (issue|evaluation)/.test(text)) return { rows: [{ id: `id-${++seq}` }] };
      return { rows: [] };
    }),
  };
  vi.mocked(withTransaction).mockImplementation(async (fn) => fn(client as never));
});

describe('evaluateSession (fake LLM)', () => {
  it('runs once statelessly with the evaluator model when every section is reported', async () => {
    fake.enqueue([...statusCalls(SECTION_NAMES), { type: 'done' }]);
    const r = await evaluateSession(SESSION, { userId: 'acc-1' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ kind: 'evaluator', model: 'model-b' });
    expect(fake.calls[0].messages).toHaveLength(1);
    expect(r.score).toBe(100);
    expect(r.gatePasses).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('missing Acceptance Criteria produces an open critical issue even if the LLM raised none', async () => {
    const others = SECTION_NAMES.filter((n) => n !== 'Acceptance Criteria');
    fake.enqueue([...statusCalls(others), ...statusCalls(['Acceptance Criteria'], 'missing'), { type: 'done' }]);
    const r = await evaluateSession(SESSION, { userId: 'acc-1' });
    expect(r.issues).toEqual([
      expect.objectContaining({
        severity: 'critical',
        section: 'Acceptance Criteria',
        description: 'Acceptance Criteria is missing',
        status: 'open',
      }),
    ]);
    expect(r.gatePasses).toBe(false);
    expect(sql.some((q) => /INSERT INTO issue/.test(q.text))).toBe(true);
  });

  it('records omitted sections as missing with reason "Not evaluated" after one corrective run', async () => {
    const omitted: SectionName[] = ['Logging', 'Acceptance Criteria'];
    const reported = SECTION_NAMES.filter((n) => !omitted.includes(n));
    fake.enqueue([...statusCalls(reported), { type: 'done' }], [...statusCalls(['Logging']), { type: 'done' }]);
    const r = await evaluateSession(SESSION, { userId: 'acc-1' });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].messages[0].content).toContain('- Logging');
    expect(fake.calls[1].messages[0].content).toContain('- Acceptance Criteria');
    expect(r.statuses.Logging.status).toBe('complete');
    expect(r.statuses['Acceptance Criteria']).toEqual({ status: 'missing', reason: NOT_EVALUATED_REASON });
    expect(r.issues.map((i) => i.description)).toEqual(['Acceptance Criteria is missing']);
  });

  it('marks all sections "Not evaluated" when neither run reports anything (no third run)', async () => {
    const r = await evaluateSession(SESSION, { userId: 'acc-1' });
    expect(fake.calls).toHaveLength(2);
    expect(r.score).toBe(0);
    for (const n of SECTION_NAMES) expect(r.statuses[n]).toEqual({ status: 'missing', reason: NOT_EVALUATED_REASON });
  });

  it('passes current issues to the prompt and keeps LLM issues', async () => {
    existingIssues = [
      {
        id: 'i-1',
        severity: 'warning',
        section: 'Security',
        description: 'No auth model',
        fingerprint: 'fp',
        status: 'open',
      },
    ];
    fake.enqueue([
      ...statusCalls(SECTION_NAMES),
      { type: 'tool-call', name: 'raise_issue', args: { severity: 'warning', section: 'Logging', description: 'No levels' } },
      { type: 'done' },
    ]);
    const r = await evaluateSession(SESSION, { userId: 'acc-1' });
    expect(fake.calls[0].messages[0].content).toContain('[warning] [Security] No auth model');
    expect(r.issues.map((i) => i.description)).toEqual(['No levels']);
    expect(sql.some((q) => /status = 'resolved'/.test(q.text) && q.params?.[0] === 'i-1')).toBe(true);
  });

  it('audits readiness.evaluated with score, statuses, counts and gate', async () => {
    fake.enqueue([...statusCalls(SECTION_NAMES), { type: 'done' }]);
    const r = await evaluateSession(SESSION, { userId: 'acc-1' });
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const [input] = vi.mocked(recordAudit).mock.calls[0];
    expect(input).toMatchObject({
      action: 'readiness.evaluated',
      result: 'success',
      userId: 'acc-1',
      sessionId: SESSION,
      details: {
        evaluationId: r.evaluationId,
        score: 100,
        counts: { critical: 0, warning: 0, informational: 0 },
        gatePasses: true,
      },
    });
  });

  it('throws and persists nothing when the evaluator run errors', async () => {
    fake.enqueue([{ type: 'error', code: 'rate_limited', message: 'slow down', retryable: true }]);
    await expect(evaluateSession(SESSION, { userId: 'acc-1' })).rejects.toBeInstanceOf(EvaluatorRunError);
    expect(withTransaction).not.toHaveBeenCalled();
  });
});
