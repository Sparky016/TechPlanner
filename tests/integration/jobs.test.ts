import './env';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/server/db/pool';
import { enqueue, getQueue, stopQueue, subscribeHandlers } from '@/server/jobs/queue';
import { JOB_NAMES } from '@/server/jobs/names';
import { clearHandlersForTests, getHandlers, NonRetryableJobError, registerHandler } from '@/server/jobs/registry';

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('job queue', { timeout: 60000 }, () => {
  beforeAll(async () => {
    // pg-boss keeps its own schema; drop it so every run starts clean.
    await db.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
  });

  beforeEach(async () => {
    await stopQueue();
    await db.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
    clearHandlersForTests();
  });

  afterAll(async () => {
    await stopQueue();
    await db.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
    await db.end();
  });

  it('delivers enqueued data to the registered handler', async () => {
    const received: unknown[] = [];
    registerHandler(JOB_NAMES.publishRun, async (data) => {
      received.push(data);
    });
    await enqueue(JOB_NAMES.publishRun, { runId: 'r1' });
    await subscribeHandlers(getHandlers());
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ runId: 'r1' });
  });

  it('runs once for two enqueues with the same singletonKey while pending', async () => {
    let calls = 0;
    registerHandler(JOB_NAMES.readinessEvaluate, async () => {
      calls++;
    });
    const first = await enqueue(JOB_NAMES.readinessEvaluate, { sessionId: 's1' }, { singletonKey: 's1', startAfter: 1 });
    const second = await enqueue(JOB_NAMES.readinessEvaluate, { sessionId: 's1' }, { singletonKey: 's1', startAfter: 1 });
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    await subscribeHandlers(getHandlers());
    await waitFor(() => calls >= 1);
    await sleep(3000);
    expect(calls).toBe(1);
  });

  it('does not retry NonRetryableJobError', async () => {
    let calls = 0;
    registerHandler(JOB_NAMES.publishRun, async () => {
      calls++;
      throw new NonRetryableJobError('bad input');
    });
    const id = await enqueue(JOB_NAMES.publishRun, {}, { retryDelay: 1 });
    await subscribeHandlers(getHandlers());
    const boss = await getQueue();
    await waitFor(async () => (await boss.findJobs(JOB_NAMES.publishRun, { id: id! }))[0]?.state === 'failed');
    await sleep(4000);
    expect(calls).toBe(1);
  });

  it('retries other errors', async () => {
    let calls = 0;
    registerHandler(JOB_NAMES.publishRun, async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
    });
    const id = await enqueue(JOB_NAMES.publishRun, {}, { retryDelay: 1 });
    await subscribeHandlers(getHandlers());
    const boss = await getQueue();
    await waitFor(async () => (await boss.findJobs(JOB_NAMES.publishRun, { id: id! }))[0]?.state === 'completed');
    expect(calls).toBe(3);
  });
});
