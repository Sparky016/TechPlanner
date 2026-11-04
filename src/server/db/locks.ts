import type { DbClient, PooledDbClient } from './pool';

// Server-only: never import from src/lib or client components.
// Named application locks, so callers only ever pass a name. MySQL has no transaction-scoped advisory lock: a
// transaction lock is a row lock on app_lock (migration 0002); a connection lock is GET_LOCK.

/** Blocks until this transaction holds the lock `name`; it is released at COMMIT or ROLLBACK. */
export async function withTxLock(client: DbClient, name: string): Promise<void> {
  // The upsert creates the row on first use and takes its exclusive lock either way. (INSERT IGNORE plus
  // SELECT ... FOR UPDATE would take a shared lock on the existing row first, so two waiters deadlock upgrading it.)
  await client.query('INSERT INTO app_lock (name) VALUES (?) AS new ON DUPLICATE KEY UPDATE name = new.name', [name]);
}

/**
 * Takes the lock `name` for this connection without waiting; false when another connection holds it. The lock
 * outlives transactions: release it with releaseConnectionLock, or destroy the connection (release(true)).
 * GET_LOCK names are server-wide and at most 64 characters.
 */
export async function tryConnectionLock(client: PooledDbClient, name: string): Promise<boolean> {
  const { rows } = await client.query<{ locked: string | number | null }>('SELECT GET_LOCK(?, 0) AS locked', [name]);
  return Number(rows[0]?.locked) === 1;
}

export async function releaseConnectionLock(client: PooledDbClient, name: string): Promise<void> {
  await client.query('SELECT RELEASE_LOCK(?)', [name]);
}
