import { setTimeout as sleep } from 'node:timers/promises';
import { getConfig } from '@/server/config';
import { countDbDeadlockRetry, observeDbPoolWait } from '@/server/observability/metrics';
import { isDeadlock } from './errors';
import { createDbPool, type DbClient, type DbPool, type DbRow } from './mysql';

// Server-only: never import from src/lib or client components.
// The app's connection pool and transaction helper. Callers only see DbClient and write `?` placeholders; the
// driver adapter is ./mysql.

export type { DbClient, DbPool, DbPoolOptions, DbResult, DbRow, PooledDbClient } from './mysql';
export { createDbPool, PoolAcquireTimeoutError } from './mysql';

const config = getConfig();

// Bounded acquire wait: when every connection is checked out (NFR-5: one per streamed turn), requests fail with 503
// after DB_POOL_ACQUIRE_TIMEOUT_MS instead of queueing forever.
export const db: DbPool = createDbPool(config.DATABASE_URL, {
  connectionLimit: config.DB_POOL_SIZE,
  acquireTimeoutMs: config.DB_POOL_ACQUIRE_TIMEOUT_MS,
  onAcquire: observeDbPoolWait,
});

export async function query<T extends DbRow = DbRow>(text: string, params?: unknown[]): Promise<T[]> {
  return (await db.query<T>(text, params)).rows;
}

export interface TransactionOptions {
  /**
   * Re-run the whole callback when InnoDB rolls the transaction back as a deadlock victim (errno 1213), up to
   * DEADLOCK_RETRIES times. Only for callbacks that touch nothing but this transaction: no Atlassian or LLM calls,
   * no writes on other connections, nothing kept from a failed attempt. (Audit records written with the transaction's
   * client roll back with it, so they are fine.)
   */
  retryOnDeadlock?: boolean;
}

export const DEADLOCK_RETRIES = 3;

export async function withTransaction<T>(
  fn: (client: DbClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await runTransaction(fn);
    } catch (err) {
      if (!options.retryOnDeadlock || !isDeadlock(err) || retry >= DEADLOCK_RETRIES) throw err;
      countDbDeadlockRetry();
      // A short random pause so the transactions that collided do not meet again in the same order.
      await sleep(5 + Math.floor(Math.random() * 20 * (retry + 1)));
    }
  }
}

async function runTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  // A client whose ROLLBACK failed is in an unknown state: destroy it instead of returning it to the pool.
  let discard = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      discard = true;
    });
    throw err;
  } finally {
    client.release(discard);
  }
}
