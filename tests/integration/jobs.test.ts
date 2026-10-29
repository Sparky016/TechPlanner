import './env';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, query } from '@/server/db/pool';
import { enqueue, getQueue, stopQueue, subscribeHandlers } from '@/server/jobs/queue';
import { JOB_NAMES } from '@/server/jobs/names';
import { clearHandlersForTests, getHandlers, NonRetryableJobError, registerHandler } from '@/server/jobs/registry';
import { runMigrations } from '../../scripts/migrate';

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface JobState {
  state: string;
  retry_count: number;
  output: { message?: string; superseded?: boolean } | null;
}

async function job(id: string): Promise<JobState | undefined> {
  return (await query<JobState>('SELECT state, retry_count, output FROM job WHERE id = ?', [id]))[0];
}

const stateOf = async (id: string) => (await job(id))?.state;

// Simulates a worker that claimed the job and died: active with its visibility timeout already past.
async function abandon(id: string): Promise<void> {
  await query("UPDATE job SET state = 'active', locked_until = ? WHERE id = ?", [new Date(Date.now() - 60000), id]);
}

describe('job queue', { timeout: 60000 }, () => {
  beforeAll(async () => {
    await runMigrations(db);
  });

  beforeEach(async () => {
    await stopQueue();
    await db.query('DELETE FROM job');
    clearHandlersForTests();
  });

  afterAll(async () => {
    await stopQueue();
    await db.query('DELETE FROM job');
    await db.end();
  });

  it('delivers enqueued data to the registered handler', async () => {
    const received: unknown[] = [];
    registerHandler(JOB_NAMES.publishRun, async (data) => {
      received.push(data);
    });
    const id = await enqueue(JOB_NAMES.publishRun, { runId: 'r1' });
    await subscribeHandlers(getHandlers());
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ runId: 'r1' });
    await waitFor(async () => (await stateOf(id!)) === 'completed');
  });

  it('runs once for two enqueues with the same singletonKey while pending (AC1)', async () => {
    let calls = 0;
    registerHandler(JOB_NAMES.readinessEvaluate, async () => {
      calls++;
    });
    const first = await enqueue(JOB_NAMES.readinessEvaluate, { sessionId: 's1' }, { singletonKey: 's1', startAfter: 1 });
    const second = await enqueue(JOB_NAMES.readinessEvaluate, { sessionId: 's1' }, { singletonKey: 's1', startAfter: 1 });
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect(await query('SELECT id FROM job')).toHaveLength(1);
    await subscribeHandlers(getHandlers());
    await waitFor(() => calls >= 1);
    await sleep(3000);
    expect(calls).toBe(1);
  });

  it('accepts a new singleton job while the previous one is active', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    registerHandler(JOB_NAMES.readinessEvaluate, async () => {
      calls++;
      if (calls === 1) await gate;
    });
    const first = await enqueue(JOB_NAMES.readinessEvaluate, {}, { singletonKey: 's1' });
    await subscribeHandlers(getHandlers());
    await waitFor(async () => (await stateOf(first!)) === 'active');

    const second = await enqueue(JOB_NAMES.readinessEvaluate, {}, { singletonKey: 's1' });
    expect(second).toBeTruthy();
    expect(await enqueue(JOB_NAMES.readinessEvaluate, {}, { singletonKey: 's1' })).toBeNull();
    release();
    await waitFor(async () => (await stateOf(second!)) === 'completed');
    expect(calls).toBe(2);
  });

  it('dead-letters NonRetryableJobError without retry (AC2)', async () => {
    let calls = 0;
    registerHandler(JOB_NAMES.publishRun, async () => {
      calls++;
      throw new NonRetryableJobError('bad input');
    });
    const id = await enqueue(JOB_NAMES.publishRun, {}, { retryDelay: 1 });
    await subscribeHandlers(getHandlers());
    await waitFor(async () => (await stateOf(id!)) === 'deadletter');
    await sleep(4000);
    expect(calls).toBe(1);
    expect(await job(id!)).toMatchObject({ state: 'deadletter', retry_count: 0, output: { message: 'bad input' } });
  });

  it('retries other errors', async () => {
    let calls = 0;
    registerHandler(JOB_NAMES.publishRun, async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
    });
    const id = await enqueue(JOB_NAMES.publishRun, {}, { retryDelay: 1 });
    await subscribeHandlers(getHandlers());
    await waitFor(async () => (await stateOf(id!)) === 'completed');
    expect(calls).toBe(3);
  });

  it('retries 3 times with growing delay, then fails (AC2)', async () => {
    const calledAt: number[] = [];
    registerHandler(JOB_NAMES.publishRun, async () => {
      calledAt.push(Date.now());
      throw new Error('always');
    });
    const id = await enqueue(JOB_NAMES.publishRun, {}, { retryDelay: 1 });
    await subscribeHandlers(getHandlers());
    await waitFor(async () => (await stateOf(id!)) === 'failed', 45000);

    expect(calledAt).toHaveLength(4);
    expect(await job(id!)).toMatchObject({ state: 'failed', retry_count: 3, output: { message: 'always' } });
    // Backoff of 1 s, 2 s and 4 s, each plus up to one poll interval.
    const gaps = calledAt.slice(1).map((t, i) => (t - calledAt[i]) / 1000);
    [1, 2, 4].forEach((delay, i) => {
      expect(gaps[i]).toBeGreaterThanOrEqual(delay - 0.1);
      expect(gaps[i]).toBeLessThan(delay + 2);
    });
    expect(gaps[2]).toBeGreaterThan(gaps[0]);
  });

  it('picks up a job left active past locked_until (AC3)', async () => {
    const received: unknown[] = [];
    registerHandler(JOB_NAMES.publishRun, async (data) => {
      received.push(data);
    });
    const id = await enqueue(JOB_NAMES.publishRun, { runId: 'crashed' });
    await abandon(id!);
    await subscribeHandlers(getHandlers());
    await waitFor(async () => (await stateOf(id!)) === 'completed');
    expect(received).toEqual([{ runId: 'crashed' }]);
  });

  it('does not take back a job that is active within its visibility timeout', async () => {
    let calls = 0;
    registerHandler(JOB_NAMES.publishRun, async () => {
      calls++;
    });
    const id = await enqueue(JOB_NAMES.publishRun, {});
    await query("UPDATE job SET state = 'active', locked_until = ? WHERE id = ?", [new Date(Date.now() + 60000), id]);
    await subscribeHandlers(getHandlers());
    await sleep(2500);
    expect(calls).toBe(0);
    expect(await stateOf(id!)).toBe('active');
  });

  it('fails an expired singleton job when a newer one is already queued for its key', async () => {
    let calls = 0;
    registerHandler(JOB_NAMES.readinessEvaluate, async () => {
      calls++;
    });
    const stale = await enqueue(JOB_NAMES.readinessEvaluate, {}, { singletonKey: 's1' });
    await abandon(stale!);
    const queued = await enqueue(JOB_NAMES.readinessEvaluate, {}, { singletonKey: 's1' });
    expect(queued).toBeTruthy();
    await subscribeHandlers(getHandlers());
    await waitFor(async () => (await stateOf(queued!)) === 'completed');
    expect(calls).toBe(1);
    expect(await job(stale!)).toMatchObject({ state: 'failed', output: { superseded: true } });
  });

  it('deletes completed jobs older than 7 days when the queue starts', async () => {
    const old = await enqueue(JOB_NAMES.publishRun, {});
    const recent = await enqueue(JOB_NAMES.publishRun, {});
    const failedOld = await enqueue(JOB_NAMES.publishRun, {});
    const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);
    await query("UPDATE job SET state = 'completed', finished_at = ? WHERE id = ?", [daysAgo(8), old]);
    await query("UPDATE job SET state = 'completed', finished_at = ? WHERE id = ?", [daysAgo(6), recent]);
    await query("UPDATE job SET state = 'failed', finished_at = ? WHERE id = ?", [daysAgo(8), failedOld]);

    await getQueue();
    expect(await job(old!)).toBeUndefined();
    expect(await stateOf(recent!)).toBe('completed');
    expect(await stateOf(failedOld!)).toBe('failed');
  });

  it('waits for the in-flight handler on stop', async () => {
    let finished = false;
    registerHandler(JOB_NAMES.publishRun, async () => {
      await sleep(1500);
      finished = true;
    });
    const id = await enqueue(JOB_NAMES.publishRun, {});
    await subscribeHandlers(getHandlers());
    await waitFor(async () => (await stateOf(id!)) === 'active');
    await stopQueue();
    expect(finished).toBe(true);
    expect(await stateOf(id!)).toBe('completed');
  });
});
