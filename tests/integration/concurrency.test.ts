import { vi } from 'vitest';

// Evaluations use FakeLlmClient. A small pool and a short acquire timeout make exhaustion quick to reach and to time;
// set before setup imports the config (and with it the app pool).
vi.hoisted(() => {
  process.env.LLM_FAKE = '1';
  process.env.DB_POOL_SIZE = '10';
  process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '2000';
});

import { resetDatabase } from './setup';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as meGET } from '@/app/api/me/route';
import { recordAudit } from '@/server/audit/audit';
import { SESSION_COOKIE, createSession as createAppSession } from '@/server/auth/session';
import { getConfig, resetConfigForTests } from '@/server/config';
import { isDeadlock, isPoolAcquireTimeout } from '@/server/db/errors';
import { releaseConnectionLock, tryConnectionLock, withTxLock } from '@/server/db/locks';
import { db, DEADLOCK_RETRIES, query, withTransaction } from '@/server/db/pool';
import { FakeLlmClient, getLlmClient, resetLlmClientForTests, type FakeStep } from '@/server/llm';
import { dbDeadlockRetries, dbPoolWait } from '@/server/observability/metrics';
import { retryRun, startPublish } from '@/server/publish/orchestrator';
import { evaluateSession } from '@/server/readiness/evaluate';
import { flushEditAudits, recordDraftUpdated, recordSectionEdit } from '@/server/spec/editAudit';
import {
  acceptSuggestion,
  applyAiPatch,
  getWorkingCopy,
  initWorkingCopy,
  SuggestionNotPendingError,
  updateSectionByUser,
  VersionConflictError,
} from '@/server/spec/workingCopyRepo';
import { verifyAuditChain } from '../../scripts/audit-verify';
import type { SectionStatus } from '../../src/lib/readiness/types';
import { SECTION_NAMES, type SectionName } from '../../src/lib/spec/sections';

// docs/specs/mysql-migration.md §8 and DEV_TASK_47: parallel writers on one session must neither deadlock nor
// corrupt state, and an exhausted pool must fail fast (NFR-5). Run 20 times in a row for AC2.

const POOL_SIZE = 10;
const ACQUIRE_TIMEOUT_MS = 2000;
const ALICE = { accountId: 'acc-alice', displayName: 'Alice' };
let fake: FakeLlmClient;
let cookie: string;
let keySeq = 0;

interface Session {
  id: string;
  key: string;
}

async function createPlanningSession(): Promise<Session> {
  keySeq++;
  const key = `CONC-${keySeq}`;
  const id = randomUUID();
  await query(
    'INSERT INTO planning_session (id, primary_ticket_key, ticket_keys, facilitator_id) VALUES (?, ?, JSON_ARRAY(?), ?)',
    [id, key, key, ALICE.accountId],
  );
  await initWorkingCopy(id);
  return { id, key };
}

const actor = (s: Session) => ({ user: ALICE, ticketIds: [s.key], correlationId: null });

// The section PATCH route: versioned update (re-read and retry on a stale version, as the client's autosave does),
// then the edit and draft audits.
async function editSection(s: Session, section: SectionName, body: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = (await getWorkingCopy(s.id))!;
    let version: number;
    try {
      version = await updateSectionByUser(s.id, section, body, current.version);
    } catch (err) {
      if (err instanceof VersionConflictError) continue;
      throw err;
    }
    await recordSectionEdit(s.id, section, current.sections[section].body, body, actor(s));
    await recordDraftUpdated(s.id, version, actor(s));
    return;
  }
  throw new Error('edit kept conflicting');
}

// The accept route: accept, then audit and draft.updated outside the transaction.
async function acceptViaRoute(s: Session, suggestionId: string): Promise<number> {
  const version = await acceptSuggestion(suggestionId);
  await recordAudit({
    action: 'ai.suggestion.accepted',
    result: 'success',
    userId: ALICE.accountId,
    sessionId: s.id,
    ticketIds: [s.key],
    details: { suggestionId, edited: false },
  });
  await recordDraftUpdated(s.id, version, actor(s));
  return version;
}

async function insertSuggestion(s: Session, section: SectionName, content: string): Promise<string> {
  const id = randomUUID();
  await query(
    "INSERT INTO pending_suggestion (id, session_id, section, patch, status) VALUES (?, ?, ?, ?, 'pending')",
    [id, s.id, section, JSON.stringify({ section, op: 'append', content })],
  );
  return id;
}

// Evaluator runs rotate one section through partial/missing and raise a warning that changes every few runs, so
// concurrent evaluations insert, keep, resolve and reopen issues.
let evalRun = 0;
function evaluatorScript(): FakeStep[] {
  const run = evalRun++;
  const statuses: SectionStatus[] = ['partial', 'missing', 'complete'];
  return [
    ...SECTION_NAMES.map(
      (section, i): FakeStep => ({
        type: 'tool-call',
        name: 'report_section_status',
        args: { section, status: i === run % 5 ? statuses[run % 3] : 'complete', reason: `${section} run ${run}` },
      }),
    ),
    {
      type: 'tool-call',
      name: 'raise_issue',
      args: { severity: 'warning', section: 'Logging', description: `Warning ${run % 4}` },
    },
    { type: 'done' },
  ];
}

// Every evaluator run reports all sections complete: the readiness gate passes.
function passingScript(): FakeStep[] {
  return [
    ...SECTION_NAMES.map(
      (section): FakeStep => ({
        type: 'tool-call',
        name: 'report_section_status',
        args: { section, status: 'complete', reason: 'ok' },
      }),
    ),
    { type: 'done' },
  ];
}

async function deadlockRetries(): Promise<number> {
  return (await dbDeadlockRetries.get()).values[0]?.value ?? 0;
}

async function poolTimeouts(): Promise<number> {
  const { values } = await dbPoolWait.get();
  return values.find((v) => v.metricName === 'db_pool_wait_seconds_count' && v.labels.outcome === 'timeout')?.value ?? 0;
}

function fulfilled<T>(results: PromiseSettledResult<T>[]): T[] {
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  // Surface the first unexpected error (a 1213 would show here) rather than a bare count.
  if (failures.length > 0) throw failures[0].reason;
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}

function meRequest(): NextRequest {
  return new NextRequest(`${getConfig().APP_BASE_URL}/api/me`, {
    headers: { origin: getConfig().APP_BASE_URL, cookie: `${SESSION_COOKIE}=${cookie}` },
  });
}

const noParams = { params: Promise.resolve({}) };

beforeAll(async () => {
  await resetDatabase();
  resetConfigForTests();
  resetLlmClientForTests();
  fake = getLlmClient() as FakeLlmClient;
  await query('INSERT INTO app_user (atlassian_account_id, display_name) VALUES (?, ?)', [
    ALICE.accountId,
    ALICE.displayName,
  ]);
  cookie = await withTransaction((client) => createAppSession(client, ALICE.accountId));
});

beforeEach(() => {
  fake.reset();
});

afterAll(async () => {
  await db.query('DELETE FROM job');
  await db.end();
});

describe('pool configuration', () => {
  it('uses DB_POOL_SIZE and DB_POOL_ACQUIRE_TIMEOUT_MS', () => {
    expect(getConfig().DB_POOL_SIZE).toBe(POOL_SIZE);
    expect(getConfig().DB_POOL_ACQUIRE_TIMEOUT_MS).toBe(ACQUIRE_TIMEOUT_MS);
  });
});

describe('parallel writers on one session', { timeout: 60_000 }, () => {
  it('suggestion accepts, section edits, AI patches and edit-audit flushes all complete with consistent state', async () => {
    const s = await createPlanningSession();
    const accepted = SECTION_NAMES.slice(0, 6);
    const editedOnly = SECTION_NAMES.slice(6, 12);
    const suggestions = await Promise.all(accepted.map((section, i) => insertSuggestion(s, section, `suggested ${i}`)));
    const before = (await getWorkingCopy(s.id))!.version;
    const retriesBefore = await deadlockRetries();

    // Each suggestion is accepted twice at once: exactly one of the two may win.
    const accepts = Promise.allSettled([...suggestions, ...suggestions].map((sid) => acceptViaRoute(s, sid)));
    const edits = Promise.allSettled(
      [...accepted, ...editedOnly].map((section, i) => editSection(s, section, `edited ${section} ${i}`)),
    );
    const patches = Promise.allSettled(
      accepted.slice(0, 3).map((section, i) => applyAiPatch(s.id, { section, op: 'append', content: `ai ${i}` }, new Date(0))),
    );
    const flushes = Promise.allSettled([flushEditAudits(s.id, actor(s)), flushEditAudits(s.id, actor(s))]);

    const acceptResults = await accepts;
    const acceptErrors = acceptResults.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(acceptErrors).toHaveLength(suggestions.length);
    for (const e of acceptErrors) expect(e.reason).toBeInstanceOf(SuggestionNotPendingError);
    fulfilled(await edits);
    const patchResults = fulfilled(await patches);
    fulfilled(await flushes);

    const statuses = await query<{ status: string }>('SELECT status FROM pending_suggestion WHERE id IN (?, ?, ?, ?, ?, ?)', suggestions);
    expect(statuses.map((r) => r.status)).toEqual(Array(6).fill('accepted'));

    // Every successful write bumped the version exactly once: no lost update.
    const applied = patchResults.filter((p) => p.disposition === 'applied').length;
    const after = (await getWorkingCopy(s.id))!;
    expect(after.version - before).toBe(suggestions.length + accepted.length + editedOnly.length + applied);
    editedOnly.forEach((section, i) => expect(after.sections[section].body).toBe(`edited ${section} ${i + 6}`));

    expect((await verifyAuditChain(db)).ok).toBe(true);
    // No retry is opted in on these paths: a deadlock would have failed an operation above.
    expect(await deadlockRetries()).toBe(retriesBefore);
  });

  it('evaluations and edits of the same session and of a second session complete without deadlock', async () => {
    const s1 = await createPlanningSession();
    const s2 = await createPlanningSession();
    fake.setDefaultScript(evaluatorScript);
    const user = { userId: ALICE.accountId, userDisplayName: ALICE.displayName };

    const results = await Promise.allSettled([
      ...Array.from({ length: 6 }, () => evaluateSession(s1.id, user)),
      ...Array.from({ length: 4 }, () => evaluateSession(s2.id, user)),
      ...SECTION_NAMES.slice(0, 8).map((section, i) => editSection(s1, section, `s1 ${i}`)),
      ...SECTION_NAMES.slice(0, 4).map((section, i) => editSection(s2, section, `s2 ${i}`)),
      flushEditAudits(s1.id, actor(s1)),
      flushEditAudits(s2.id, actor(s2)),
    ]);
    fulfilled<unknown>(results);

    const counts = await query<{ session_id: string; n: number }>(
      'SELECT session_id, COUNT(*) AS n FROM evaluation WHERE session_id IN (?, ?) GROUP BY session_id',
      [s1.id, s2.id],
    );
    expect(Object.fromEntries(counts.map((c) => [c.session_id, Number(c.n)]))).toEqual({ [s1.id]: 6, [s2.id]: 4 });

    // The last evaluation's view is the stored one: each fingerprint once, at most one open copy of the warning.
    const issues = await query<{ fingerprint: string; status: string; description: string }>(
      'SELECT fingerprint, status, description FROM issue WHERE session_id = ?',
      [s1.id],
    );
    expect(new Set(issues.map((i) => i.fingerprint)).size).toBe(issues.length);
    expect(issues.filter((i) => i.status === 'open' && i.description.startsWith('Warning'))).toHaveLength(1);

    const audits = await query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM audit_record WHERE action = 'readiness.evaluated' AND session_id IN (?, ?)",
      [s1.id, s2.id],
    );
    expect(Number(audits[0].n)).toBe(10);
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });

  it('parallel publishes, then parallel retries of each run: one revision per publish, one retry per run', async () => {
    const s = await createPlanningSession();
    fake.setDefaultScript(passingScript);
    const input = { sessionId: s.id, primaryTicketKey: s.key, ticketKeys: [s.key], user: ALICE };

    const publishes = fulfilled<unknown>(
      await Promise.allSettled([
        ...Array.from({ length: 3 }, () => startPublish(input)),
        ...SECTION_NAMES.slice(0, 4).map((section, i) => editSection(s, section, `publish ${i}`)),
        evaluateSession(s.id, { userId: ALICE.accountId }),
      ]),
    ).slice(0, 3) as Awaited<ReturnType<typeof startPublish>>[];
    const runIds = publishes.map((p) => {
      if (p.kind !== 'started') throw new Error(`publish ${p.kind}`);
      return p.runId;
    });
    expect(publishes.map((p) => (p.kind === 'started' ? p.revisionNumber : 0)).sort()).toEqual([1, 2, 3]);

    // The worker is not running: fail every run so it can be retried, then retry each four times at once.
    await query(`UPDATE publish_run SET status = 'failed' WHERE session_id = ?`, [s.id]);
    const [jobsBefore] = await query<{ n: number }>('SELECT COUNT(*) AS n FROM job');
    const retries = fulfilled<unknown>(
      await Promise.allSettled([
        ...runIds.flatMap((runId) => Array.from({ length: 4 }, () => retryRun(s.id, runId))),
        evaluateSession(s.id, { userId: ALICE.accountId }),
        flushEditAudits(s.id, actor(s)),
      ]),
    ).slice(0, runIds.length * 4) as Awaited<ReturnType<typeof retryRun>>[];
    for (const runId of runIds) {
      const mine = retries.filter((r) => r.kind === 'retried' && r.runId === runId);
      expect(mine).toHaveLength(1);
    }
    expect(retries.filter((r) => r.kind === 'not_retryable')).toHaveLength(runIds.length * 3);
    const [jobsAfter] = await query<{ n: number }>('SELECT COUNT(*) AS n FROM job');
    expect(Number(jobsAfter.n) - Number(jobsBefore.n)).toBe(runIds.length);

    const runs = await query<{ status: string }>('SELECT status FROM publish_run WHERE session_id = ?', [s.id]);
    expect(runs.map((r) => r.status)).toEqual(Array(3).fill('running'));
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });
});

describe('withTransaction deadlock retry', () => {
  // Two transactions lock two rows in opposite order; both hold their first lock before either asks for its second,
  // so InnoDB detects the cycle and rolls one back with errno 1213.
  async function crossLocks(retryOnDeadlock: boolean): Promise<{ results: PromiseSettledResult<void>[]; runs: number }> {
    const [a, b] = [`t47:${randomUUID()}:a`, `t47:${randomUUID()}:b`];
    let arrived = 0;
    let bothHoldFirst!: () => void;
    const met = new Promise<void>((resolve) => (bothHoldFirst = resolve));
    let runs = 0;
    const tx = (first: string, second: string) =>
      withTransaction(
        async (client) => {
          runs++;
          await withTxLock(client, first);
          if (++arrived === 2) bothHoldFirst();
          await met;
          await withTxLock(client, second);
        },
        { retryOnDeadlock },
      );
    const results = await Promise.allSettled([tx(a, b), tx(b, a)]);
    return { results, runs };
  }

  it('without opt-in the deadlock victim fails with 1213 and the other commits', async () => {
    const { results, runs } = await crossLocks(false);
    expect(runs).toBe(2);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(isDeadlock(rejected[0].reason)).toBe(true);
  });

  it('with retryOnDeadlock the victim re-runs the whole callback and both commit', async () => {
    const before = await deadlockRetries();
    const { results, runs } = await crossLocks(true);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(runs).toBe(3);
    expect(await deadlockRetries()).toBe(before + 1);
  });

  it(`retries a deadlock at most ${DEADLOCK_RETRIES} times and never retries other errors`, async () => {
    const deadlock = Object.assign(new Error('Deadlock found'), { errno: 1213, sqlState: '40001' });
    let runs = 0;
    await expect(
      withTransaction(
        async () => {
          runs++;
          throw deadlock;
        },
        { retryOnDeadlock: true },
      ),
    ).rejects.toBe(deadlock);
    expect(runs).toBe(1 + DEADLOCK_RETRIES);

    runs = 0;
    const timeout = Object.assign(new Error('Lock wait timeout'), { errno: 1205 });
    await expect(
      withTransaction(
        async () => {
          runs++;
          throw timeout;
        },
        { retryOnDeadlock: true },
      ),
    ).rejects.toBe(timeout);
    expect(runs).toBe(1);
  });
});

describe('pool exhaustion (NFR-5)', { timeout: 30_000 }, () => {
  it('AC3: answers 503 db_pool_exhausted within the acquire timeout instead of hanging, then recovers', async () => {
    expect((await meGET(meRequest(), noParams)).status).toBe(200);
    const timeoutsBefore = await poolTimeouts();
    const held = await Promise.all(Array.from({ length: POOL_SIZE }, () => db.connect()));
    expect(db.stats().checkedOut).toBe(POOL_SIZE);

    const started = performance.now();
    const res = await meGET(meRequest(), noParams);
    const elapsed = performance.now() - started;
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('db_pool_exhausted');
    expect(elapsed).toBeGreaterThanOrEqual(ACQUIRE_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(ACQUIRE_TIMEOUT_MS + 1500);
    expect(await poolTimeouts()).toBe(timeoutsBefore + 1);

    for (const client of held) client.release();
    // The abandoned wait was still queued in the driver; its connection went straight back to the pool.
    await vi.waitFor(() => expect(db.stats()).toEqual({ checkedOut: 0, waiting: 0 }));
    expect((await meGET(meRequest(), noParams)).status).toBe(200);
  });

  it('turns holding every connection get a timeout on their next transaction, not a deadlock', async () => {
    // The messages route keeps one connection per streamed turn for its GET_LOCK, and the turn then needs a second
    // connection. With every connection held that used to wait forever.
    const turns = await Promise.all(
      Array.from({ length: POOL_SIZE }, async (_, i) => {
        const client = await db.connect();
        expect(await tryConnectionLock(client, `turn:t47-${i}`)).toBe(true);
        return client;
      }),
    );
    const started = performance.now();
    const inner = await Promise.allSettled(turns.map(() => withTransaction((client) => client.query('SELECT 1'))));
    expect(performance.now() - started).toBeLessThan(ACQUIRE_TIMEOUT_MS + 1500);
    for (const r of inner) {
      expect(r.status).toBe('rejected');
      expect(isPoolAcquireTimeout((r as PromiseRejectedResult).reason)).toBe(true);
    }

    for (const [i, client] of turns.entries()) {
      await releaseConnectionLock(client, `turn:t47-${i}`);
      client.release();
    }
    await vi.waitFor(() => expect(db.stats()).toEqual({ checkedOut: 0, waiting: 0 }));
    const ok = await Promise.all(turns.map(() => withTransaction((client) => client.query('SELECT 1 AS one'))));
    expect(ok.map((r) => Number(r.rows[0].one))).toEqual(Array(POOL_SIZE).fill(1));
  });
});
