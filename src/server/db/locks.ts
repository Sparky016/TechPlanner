import type { DbClient, PooledDbClient } from './pool';

// Server-only: never import from src/lib or client components.
// Named application locks. PostgreSQL advisory locks keyed by hashtext(name) today; the MySQL cutover (task 46)
// swaps the implementation, so callers only ever pass a name.

/** Blocks until this transaction holds the lock `name`; it is released at COMMIT or ROLLBACK. */
export async function withTxLock(client: DbClient, name: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext(?))', [name]);
}

/**
 * Takes the lock `name` for this connection without waiting; false when another connection holds it. The lock
 * outlives transactions: release it with releaseConnectionLock, or destroy the connection (release(true)).
 */
export async function tryConnectionLock(client: PooledDbClient, name: string): Promise<boolean> {
  const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext(?)) AS locked', [
    name,
  ]);
  return rows[0]?.locked === true;
}

export async function releaseConnectionLock(client: PooledDbClient, name: string): Promise<void> {
  await client.query('SELECT pg_advisory_unlock(hashtext(?))', [name]);
}
