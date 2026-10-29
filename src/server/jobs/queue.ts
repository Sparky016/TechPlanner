import { randomUUID } from 'node:crypto';
import { db, withTransaction } from '@/server/db/pool';
import { isUniqueViolation } from '@/server/db/errors';
import { NonRetryableJobError, type JobHandler } from './registry';

// Server-only: never import from src/lib or client components.
// Job queue on the `job` table (db/migrations/0005_job_queue.sql, spec §7.2). Every statement goes through the
// shared pool. Each claim of a job stamps a fresh claim_token; finishing or retrying it matches that token, so only
// the activation that claimed it last can record an outcome.

export interface EnqueueOptions {
  singletonKey?: string;
  /** Delay in seconds before the job becomes available. */
  startAfter?: number;
  /** Base retry delay in seconds (exponential backoff applies). */
  retryDelay?: number;
}

const RETRY_LIMIT = 3;
const DEFAULT_RETRY_DELAY_S = 1;
const POLL_INTERVAL_MS = 1000;
// Above the longest publish step budget, so a slow but live handler is not run twice (publish steps are idempotent).
const DEFAULT_VISIBILITY_TIMEOUT_S = 15 * 60;
const RETENTION_S = 7 * 24 * 60 * 60;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

// Per-queue overrides of DEFAULT_VISIBILITY_TIMEOUT_S (seconds), keyed by job name; none needed yet.
const VISIBILITY_TIMEOUTS: Partial<Record<string, number>> = {};

// The database clock decides when a job is due, so every worker agrees regardless of its own clock.
const NOW = 'NOW(6)';
/** A timestamp `?` seconds from now (fractional or negative); the caller passes the seconds as the next parameter. */
function nowPlus(): string {
  return `TIMESTAMPADD(MICROSECOND, ROUND(? * 1000000), ${NOW})`;
}

interface JobRow {
  id: string;
  data: unknown;
  /** The claim this worker made (set by runNext); finish and requeue only act while it is still current. */
  claim_token: string;
  retry_count: number;
  retry_limit: number;
  retry_delay_s: number;
}

// Returns the job id, or null when a queued job with the same singletonKey already exists.
export async function enqueue(name: string, data: object, opts: EnqueueOptions = {}): Promise<string | null> {
  const id = randomUUID();
  try {
    await db.query(
      `INSERT INTO job (id, name, data, state, singleton_key, retry_limit, retry_delay_s, start_after)
       VALUES (?, ?, ?, 'created', ?, ?, ?, ${nowPlus()})`,
      [
        id,
        name,
        JSON.stringify(data),
        opts.singletonKey ?? null,
        RETRY_LIMIT,
        opts.retryDelay ?? DEFAULT_RETRY_DELAY_S,
        opts.startAfter ?? 0,
      ],
    );
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
  return id;
}

/** True while a queued or active job exists for (name, singletonKey). */
export async function hasPendingJob(name: string, singletonKey: string): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM job WHERE name = ? AND singleton_key = ? AND state IN ('created', 'active') LIMIT 1",
    [name, singletonKey],
  );
  return rows.length > 0;
}

// Leaves the job in `state` with `output`, unless it is no longer the active job of claim `token`.
async function finish(
  id: string,
  token: string,
  state: 'completed' | 'failed' | 'deadletter',
  output: object | null,
): Promise<void> {
  await db.query(
    `UPDATE job SET state = ?, output = ?, locked_until = NULL, finished_at = ${NOW}
     WHERE id = ? AND state = 'active' AND claim_token = ?`,
    [state, output === null ? null : JSON.stringify(output), id, token],
  );
}

// Queues an active job again `delaySeconds` from now, while it is still the activation of claim `token`. A queued
// job with the same singletonKey already covers the work (the 'short' policy), so the unique violation that blocks
// requeueing marks this one failed instead.
async function requeue(
  id: string,
  token: string | null,
  delaySeconds: number,
  retryCount: number,
  message: string,
  expiredOnly = false,
): Promise<void> {
  // `expiredOnly` (recovery) requeues it only while its visibility timeout has passed.
  const guard = `claim_token <=> ?${expiredOnly ? ` AND locked_until < ${NOW}` : ''}`;
  try {
    await db.query(
      `UPDATE job SET state = 'created', retry_count = ?, start_after = ${nowPlus()}, locked_until = NULL, output = ?
       WHERE id = ? AND state = 'active' AND ${guard}`,
      [retryCount, delaySeconds, JSON.stringify({ message }), id, token],
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    await db.query(
      `UPDATE job SET state = 'failed', output = ?, locked_until = NULL, finished_at = ${NOW}
       WHERE id = ? AND state = 'active' AND ${guard}`,
      [JSON.stringify({ message, superseded: true }), id, token],
    );
  }
}

class Worker {
  private stopping = false;
  private wake: (() => void) | undefined;
  readonly done: Promise<void>;

  constructor(
    private readonly name: string,
    private readonly handler: JobHandler,
  ) {
    this.done = this.loop();
  }

  stop(): void {
    this.stopping = true;
    this.wake?.();
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let worked = false;
      try {
        await this.recoverExpired();
        worked = await this.runNext();
      } catch (err) {
        console.error(`[jobs] ${this.name} poll failed`, err);
      }
      // Re-poll immediately after a job; otherwise wait for the next tick (or stop()).
      if (!worked && !this.stopping) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, POLL_INTERVAL_MS);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = undefined;
      }
    }
  }

  // Active jobs past their visibility timeout belong to a crashed worker: queue them again.
  private async recoverExpired(): Promise<void> {
    const { rows } = await db.query<{ id: string; retry_count: number; claim_token: string | null }>(
      `SELECT id, retry_count, claim_token FROM job WHERE name = ? AND state = 'active' AND locked_until < ${NOW}`,
      [this.name],
    );
    for (const job of rows) {
      console.warn(`[jobs] ${this.name} ${job.id} visibility timeout expired, requeueing`);
      await requeue(job.id, job.claim_token, 0, job.retry_count, 'visibility timeout expired', true);
    }
  }

  // Claims the next due job in a short transaction, then runs its handler outside it. False when none was due.
  private async runNext(): Promise<boolean> {
    const visibility = VISIBILITY_TIMEOUTS[this.name] ?? DEFAULT_VISIBILITY_TIMEOUT_S;
    const job = await withTransaction(async (client) => {
      // Range scan of job_fetch (name, state, start_after). SKIP LOCKED passes over rows another worker holds. At
      // READ COMMITTED (the session default, db/mysql.ts) only the claimed row stays locked; at REPEATABLE READ the
      // scan would also take next-key locks on the range and the gap after it, so some enqueue() inserts into this
      // queue would wait for the claim to commit.
      const { rows } = await client.query<Omit<JobRow, 'claim_token'>>(
        `SELECT id, data, retry_count, retry_limit, retry_delay_s FROM job
         WHERE name = ? AND state = 'created' AND start_after <= ${NOW}
         ORDER BY start_after LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [this.name],
      );
      const row = rows[0];
      if (!row) return undefined;
      const claimToken = randomUUID();
      await client.query(`UPDATE job SET state = 'active', locked_until = ${nowPlus()}, claim_token = ? WHERE id = ?`, [
        visibility,
        claimToken,
        row.id,
      ]);
      return { ...row, claim_token: claimToken };
    });
    if (!job) return false;

    // Only the handler's own errors decide the outcome; a failure recording it leaves the job to its timeout.
    let error: { cause: unknown } | undefined;
    try {
      await this.handler(job.data);
    } catch (err) {
      error = { cause: err };
    }
    if (!error) {
      await finish(job.id, job.claim_token, 'completed', null);
      return true;
    }

    const err = error.cause;
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof NonRetryableJobError) {
      console.error(`[jobs] ${this.name} ${job.id} failed (non-retryable):`, message);
      await finish(job.id, job.claim_token, 'deadletter', { message });
    } else if (job.retry_count < job.retry_limit) {
      console.error(`[jobs] ${this.name} ${job.id} failed (will retry):`, err);
      // Exponential backoff: retryDelay, 2 x retryDelay, 4 x retryDelay, ...
      await requeue(job.id, job.claim_token, job.retry_delay_s * 2 ** job.retry_count, job.retry_count + 1, message);
    } else {
      console.error(`[jobs] ${this.name} ${job.id} failed (retries exhausted):`, err);
      await finish(job.id, job.claim_token, 'failed', { message });
    }
    return true;
  }
}

export class JobQueue {
  private readonly workers = new Map<string, Worker>();
  private retentionTimer: NodeJS.Timeout | undefined;

  async start(): Promise<void> {
    await this.purgeCompleted();
    this.retentionTimer = setInterval(() => {
      this.purgeCompleted().catch((err: unknown) => console.error('[jobs] retention cleanup failed', err));
    }, RETENTION_INTERVAL_MS);
    this.retentionTimer.unref();
  }

  /** Starts polling `name` with one handler at a time. A queue already being worked is left as is. */
  work(name: string, handler: JobHandler): void {
    if (!this.workers.has(name)) this.workers.set(name, new Worker(name, handler));
  }

  /** Stops polling and waits for in-flight handlers to finish. */
  async stop(): Promise<void> {
    clearInterval(this.retentionTimer);
    for (const worker of this.workers.values()) worker.stop();
    await Promise.all([...this.workers.values()].map((w) => w.done));
    this.workers.clear();
  }

  private async purgeCompleted(): Promise<void> {
    await db.query(`DELETE FROM job WHERE state = 'completed' AND finished_at < ${nowPlus()}`, [-RETENTION_S]);
  }
}

let queuePromise: Promise<JobQueue> | undefined;

// Starts the queue (retention cleanup now and hourly). Only workers need it: enqueue() is a plain insert.
export function getQueue(): Promise<JobQueue> {
  if (!queuePromise) {
    const queue = new JobQueue();
    queuePromise = queue
      .start()
      .then(() => queue)
      .catch((err: unknown) => {
        queuePromise = undefined;
        throw err;
      });
  }
  return queuePromise;
}

export async function stopQueue(): Promise<void> {
  if (!queuePromise) return;
  const pending = queuePromise;
  queuePromise = undefined;
  const queue = await pending;
  await queue.stop();
}

// Subscribes each handler. Plain errors are retried with backoff up to RETRY_LIMIT times, then the job fails;
// NonRetryableJobError dead-letters the job without retry.
export async function subscribeHandlers(handlers: ReadonlyMap<string, JobHandler>): Promise<void> {
  const queue = await getQueue();
  for (const [name, handler] of handlers) queue.work(name, handler);
}
