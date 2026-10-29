import { Pool, type PoolClient } from 'pg';
import { getConfig } from '@/server/config';
import { toPgPlaceholders } from './placeholders';

// Server-only: never import from src/lib or client components.
// Callers only see DbClient and write `?` placeholders; everything driver-specific stays in this file, so changing
// database (task 46) replaces this adapter rather than its callers.

/** A result row; callers name its shape with the type argument. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same contract as the driver's untyped row
export type DbRow = Record<string, any>;

export interface DbResult<T> {
  rows: T[];
  /** Rows returned by a read; rows affected by a write. */
  rowCount: number;
}

export interface DbClient {
  query<T extends DbRow = DbRow>(sql: string, params?: unknown[]): Promise<DbResult<T>>;
}

/** A connection checked out with db.connect(). release(true) destroys it instead of returning it to the pool. */
export interface PooledDbClient extends DbClient {
  release(discard?: boolean): void;
}

export interface DbPool extends DbClient {
  connect(): Promise<PooledDbClient>;
  end(): Promise<void>;
  /** Connections currently checked out, and callers waiting for one. */
  stats(): { checkedOut: number; waiting: number };
}

async function run<T extends DbRow>(
  target: Pool | PoolClient,
  sql: string,
  params: unknown[] | undefined,
): Promise<DbResult<T>> {
  const { text, count } = toPgPlaceholders(sql);
  const given = params?.length ?? 0;
  if (count !== given) throw new Error(`SQL has ${count} placeholders but ${given} parameters were given`);
  const result = await target.query<T>(text, params);
  return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

class PgClient implements PooledDbClient {
  constructor(private readonly client: PoolClient) {}

  query<T extends DbRow = DbRow>(sql: string, params?: unknown[]): Promise<DbResult<T>> {
    return run<T>(this.client, sql, params);
  }

  release(discard = false): void {
    this.client.release(discard);
  }
}

class PgPool implements DbPool {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  query<T extends DbRow = DbRow>(sql: string, params?: unknown[]): Promise<DbResult<T>> {
    return run<T>(this.pool, sql, params);
  }

  async connect(): Promise<PooledDbClient> {
    return new PgClient(await this.pool.connect());
  }

  end(): Promise<void> {
    return this.pool.end();
  }

  stats(): { checkedOut: number; waiting: number } {
    return { checkedOut: this.pool.totalCount - this.pool.idleCount, waiting: this.pool.waitingCount };
  }
}

export const db: DbPool = new PgPool(getConfig().DATABASE_URL);

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
