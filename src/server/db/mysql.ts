import mysql, {
  type ExecuteValues,
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type TypeCastField,
} from 'mysql2/promise';

// Server-only: never import from src/lib or client components.
// The MySQL 8.4 driver adapter (mysql2, docs/specs/mysql-migration.md §5.2): everything driver-specific lives here,
// behind DbClient and `?` placeholders. It reads no configuration, so the E2E and perf harnesses can open their own
// pools with the app's exact driver settings; the app's pool is `db` in ./pool.

/** A result row; callers name its shape with the type argument. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same contract as the driver's untyped row
export type DbRow = Record<string, any>;

export interface DbResult<T> {
  rows: T[];
  /** Rows returned by a read; rows matched by a write (also when the values were already equal). */
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

// Run once on every new connection. UTC to match the driver's timezone 'Z'; strict modes reject silent truncation.
// READ COMMITTED gives each statement a fresh snapshot, as PostgreSQL did: under InnoDB's default REPEATABLE READ a
// plain SELECT after taking a lock (the audit chain head, for one) could read a snapshot from before the lock.
const SESSION_INIT = [
  "SET time_zone = '+00:00'",
  "SET sql_mode = 'ONLY_FULL_GROUP_BY,STRICT_ALL_TABLES,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'",
  "SET SESSION transaction_isolation = 'READ-COMMITTED'",
];

// BOOLEAN is TINYINT(1): return it as a boolean. JSON is parsed with JSON.parse, so a number in a document reads
// back as the JS number it was written from (the driver's own parser turns large integers into strings once
// supportBigNumbers is on, which would change audit details hashed before the write). BIGINT columns are strings.
function typeCast(field: TypeCastField, next: () => unknown): unknown {
  if (field.type === 'TINY' && field.length === 1) {
    const value = field.string();
    return value === null ? null : value === '1';
  }
  if (field.type === 'JSON') {
    // MySQL labels JSON as binary; the document itself is UTF-8.
    const bytes = field.buffer();
    return bytes === null ? null : (JSON.parse(bytes.toString('utf8')) as unknown);
  }
  return next();
}

// Counts `?` outside quoted literals, quoted identifiers and comments, so a mismatch with the parameters fails
// before the driver binds them in the wrong order.
function countPlaceholders(sql: string): number {
  let count = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < sql.length && sql[i] !== c) i += sql[i] === '\\' ? 2 : 1;
    } else if ((c === '-' && sql[i + 1] === '-') || c === '#') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
    } else if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? sql.length : close + 1;
    } else if (c === '?') {
      count += 1;
    }
    i += 1;
  }
  return count;
}

function checkParams(sql: string, params: unknown[]): void {
  const count = countPlaceholders(sql);
  if (count !== params.length) {
    throw new Error(`SQL has ${count} placeholders but ${params.length} parameters were given`);
  }
  for (const p of params) {
    // mysql2 would expand an array into a list or send an object as JSON; JSON columns take JSON.stringify(...).
    if (typeof p === 'object' && p !== null && !(p instanceof Date) && !Buffer.isBuffer(p)) {
      throw new Error('SQL parameters must be scalars, Dates or Buffers; pass JSON.stringify(value) for JSON');
    }
  }
}

async function run<T extends DbRow>(conn: PoolConnection, sql: string, params: unknown[] = []): Promise<DbResult<T>> {
  checkParams(sql, params);
  // Prepared statements for parameterised DML; the text protocol for the rest (DDL, transaction control and
  // statements such as CREATE TRIGGER that cannot be prepared).
  const [result] = params.length > 0 ? await conn.execute(sql, params as ExecuteValues[]) : await conn.query(sql);
  if (Array.isArray(result)) return { rows: result as T[], rowCount: result.length };
  // affectedRows counts matched rows, not only changed ones: the pool sets CLIENT_FOUND_ROWS.
  return { rows: [], rowCount: (result as ResultSetHeader).affectedRows };
}

class MysqlClient implements PooledDbClient {
  private released = false;

  constructor(
    private readonly conn: PoolConnection,
    private readonly onRelease: () => void,
  ) {}

  query<T extends DbRow = DbRow>(sql: string, params?: unknown[]): Promise<DbResult<T>> {
    return run<T>(this.conn, sql, params);
  }

  release(discard = false): void {
    if (this.released) return;
    this.released = true;
    this.onRelease();
    if (discard) this.conn.destroy();
    else this.conn.release();
  }
}

class MysqlPool implements DbPool {
  private readonly pool: Pool;
  // The driver's own connections that already ran SESSION_INIT.
  private readonly initialised = new WeakSet<object>();
  private checkedOut = 0;
  private waiting = 0;

  constructor(url: string) {
    this.pool = mysql.createPool({
      uri: url,
      timezone: 'Z',
      dateStrings: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      namedPlaceholders: false,
      multipleStatements: false,
      charset: 'utf8mb4',
      // mysql2's default already; explicit because rowCount relies on it (affectedRows = matched rows).
      flags: ['FOUND_ROWS'],
      typeCast,
    });
  }

  async query<T extends DbRow = DbRow>(sql: string, params?: unknown[]): Promise<DbResult<T>> {
    const client = await this.connect();
    try {
      return await client.query<T>(sql, params);
    } finally {
      client.release();
    }
  }

  async connect(): Promise<PooledDbClient> {
    this.waiting += 1;
    let conn: PoolConnection;
    try {
      conn = await this.pool.getConnection();
    } finally {
      this.waiting -= 1;
    }
    this.checkedOut += 1;
    const client = new MysqlClient(conn, () => {
      this.checkedOut -= 1;
    });
    if (!this.initialised.has(conn.connection)) {
      try {
        for (const statement of SESSION_INIT) await conn.query(statement);
      } catch (err) {
        client.release(true);
        throw err;
      }
      this.initialised.add(conn.connection);
    }
    return client;
  }

  end(): Promise<void> {
    return this.pool.end();
  }

  stats(): { checkedOut: number; waiting: number } {
    return { checkedOut: this.checkedOut, waiting: this.waiting };
  }
}

/** A pool for `url` (mysql://user:password@host:port/database). The app uses `db`; scripts and tests may need others. */
export function createDbPool(url: string): DbPool {
  return new MysqlPool(url);
}
