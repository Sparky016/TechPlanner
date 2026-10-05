import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { getConfig } from '@/server/config';

// Server-only: never import from src/lib or client components.

export const db = new Pool({ connectionString: getConfig().DATABASE_URL });

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await db.query<T>(text, params);
  return result.rows;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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
