import { getConfig } from '@/server/config';
import { createDbPool, type DbClient, type DbPool, type DbRow } from './mysql';

// Server-only: never import from src/lib or client components.
// The app's connection pool and transaction helper. Callers only see DbClient and write `?` placeholders; the
// driver adapter is ./mysql.

export type { DbClient, DbPool, DbResult, DbRow, PooledDbClient } from './mysql';
export { createDbPool } from './mysql';

export const db: DbPool = createDbPool(getConfig().DATABASE_URL);

export async function query<T extends DbRow = DbRow>(text: string, params?: unknown[]): Promise<T[]> {
  return (await db.query<T>(text, params)).rows;
}

export async function withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
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
