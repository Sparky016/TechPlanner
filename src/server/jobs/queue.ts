import { PgBoss, type QueuePolicy, type SendOptions } from 'pg-boss';
import { getConfig } from '@/server/config';
import { JOB_NAMES } from './names';
import { NonRetryableJobError, type JobHandler } from './registry';

// Server-only: never import from src/lib or client components.

export interface EnqueueOptions {
  singletonKey?: string;
  /** Delay in seconds before the job becomes available. */
  startAfter?: number;
  /** Base retry delay in seconds (exponential backoff applies). */
  retryDelay?: number;
}

const RETRY_LIMIT = 3;

// 'short' allows one queued job per singletonKey, which gives debounce semantics for readiness evaluation.
const QUEUE_POLICIES: Record<string, QueuePolicy> = {
  [JOB_NAMES.readinessEvaluate]: 'short',
};

let bossPromise: Promise<PgBoss> | undefined;
const knownQueues = new Set<string>();

export function getQueue(): Promise<PgBoss> {
  if (!bossPromise) {
    const boss = new PgBoss(getConfig().DATABASE_URL);
    boss.on('error', (err) => console.error('[jobs] queue error', err));
    bossPromise = boss.start().catch((err: unknown) => {
      bossPromise = undefined;
      throw err;
    });
  }
  return bossPromise;
}

export async function stopQueue(): Promise<void> {
  if (!bossPromise) return;
  const pending = bossPromise;
  bossPromise = undefined;
  knownQueues.clear();
  const boss = await pending;
  await boss.stop({ graceful: true });
}

async function ensureQueue(boss: PgBoss, name: string): Promise<void> {
  if (knownQueues.has(name)) return;
  await boss.createQueue(name, {
    policy: QUEUE_POLICIES[name] ?? 'standard',
    retryLimit: RETRY_LIMIT,
    retryBackoff: true,
  });
  knownQueues.add(name);
}

// Returns the job id, or null when a pending job with the same singletonKey already exists.
export async function enqueue(name: string, data: object, opts: EnqueueOptions = {}): Promise<string | null> {
  const boss = await getQueue();
  await ensureQueue(boss, name);
  // pg-boss validates keys that are present, so undefined options must be omitted entirely.
  const sendOptions: SendOptions = {};
  if (opts.singletonKey !== undefined) sendOptions.singletonKey = opts.singletonKey;
  if (opts.startAfter !== undefined) sendOptions.startAfter = opts.startAfter;
  if (opts.retryDelay !== undefined) sendOptions.retryDelay = opts.retryDelay;
  return boss.send(name, data, sendOptions);
}

// Subscribes each handler. Plain errors are thrown back to pg-boss (retried);
// NonRetryableJobError fails the job terminally without retry.
export async function subscribeHandlers(handlers: ReadonlyMap<string, JobHandler>): Promise<void> {
  const boss = await getQueue();
  for (const [name, handler] of handlers) {
    await ensureQueue(boss, name);
    await boss.work(name, { batchSize: 1, perJobResults: true }, async (jobs) => {
      const results = [];
      for (const job of jobs) {
        try {
          await handler(job.data);
          results.push({ id: job.id, status: 'completed' as const });
        } catch (err) {
          if (err instanceof NonRetryableJobError) {
            console.error(`[jobs] ${name} ${job.id} failed (non-retryable):`, err.message);
            results.push({ id: job.id, status: 'deadletter' as const, output: { message: err.message } });
          } else {
            console.error(`[jobs] ${name} ${job.id} failed (will retry):`, err);
            throw err;
          }
        }
      }
      return results;
    });
  }
}
