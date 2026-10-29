import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DbPool } from '@/server/db/pool';

// Forward-only migration runner: applies db/migrations/*.sql in filename order, recording each file in
// schema_migrations once all of its statements succeeded, so re-running applies only what is missing.
// MySQL commits every DDL statement implicitly: a file that fails part-way leaves its earlier statements applied
// and needs manual cleanup before the run is repeated (hence one logical change per file).
// Run it as the owner user (MIGRATE_DATABASE_URL); the app user cannot create tables or grant.

export const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');

// Serialises concurrent runners. GET_LOCK is server-wide and held by the connection, not a transaction.
const LOCK_NAME = 'techplanner_migrate';
const LOCK_TIMEOUT_S = 60;

// Files hold one statement per chunk, separated by this marker line; trigger bodies keep their own `;`.
const STATEMENT_BREAK = /^[ \t]*--[ \t]*statement-break[ \t]*$/m;
const COMMENT_LINE = /^[ \t]*--.*$/gm;
const APP_DB_USER = '${APP_DB_USER}';

export interface MigrateOptions {
  dir?: string;
  /** Grantee of the per-table grants, as 'user'@'host'. Defaults to the APP_DB_USER setting. */
  appDbUser?: string;
}

/** The statements of a migration file: its marker-separated chunks, without comment-only chunks. */
export function splitStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAK)
    .map((chunk) => chunk.trim().replace(/;\s*$/, ''))
    .filter((chunk) => chunk.replace(COMMENT_LINE, '').trim() !== '');
}

export async function runMigrations(pool: DbPool, opts: MigrateOptions = {}): Promise<string[]> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const appDbUser = opts.appDbUser ?? (await import('@/server/config')).getConfig().APP_DB_USER;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const client = await pool.connect();
  let locked = false;
  let discard = false;
  try {
    const { rows } = await client.query<{ locked: string | null }>('SELECT GET_LOCK(?, ?) AS locked', [
      LOCK_NAME,
      LOCK_TIMEOUT_S,
    ]);
    if (Number(rows[0]?.locked) !== 1) {
      throw new Error(`Another migration run still holds the migration lock after ${LOCK_TIMEOUT_S} s`);
    }
    locked = true;
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename VARCHAR(255) NOT NULL PRIMARY KEY,
         applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
       ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin`,
    );
    const done = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations');
    const appliedBefore = new Set(done.rows.map((r) => r.filename));

    const applied: string[] = [];
    for (const filename of files) {
      if (appliedBefore.has(filename)) continue;
      const text = (await readFile(join(dir, filename), 'utf8')).replaceAll(APP_DB_USER, appDbUser);
      try {
        for (const statement of splitStatements(text)) await client.query(statement);
        await client.query('INSERT INTO schema_migrations (filename) VALUES (?)', [filename]);
      } catch (err) {
        throw new Error(
          `Migration ${filename} failed: ${err instanceof Error ? err.message : String(err)}. ` +
            'MySQL commits DDL statement by statement, so its earlier statements may already be applied: ' +
            'undo them by hand before running migrations again.',
          { cause: err },
        );
      }
      applied.push(filename);
    }
    return applied;
  } finally {
    if (locked) {
      await client.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {
        discard = true;
      });
    }
    client.release(discard);
  }
}

async function main(): Promise<void> {
  const { getConfig } = await import('@/server/config');
  const { createDbPool } = await import('@/server/db/pool');
  const config = getConfig();
  const pool = createDbPool(config.MIGRATE_DATABASE_URL ?? config.DATABASE_URL);
  try {
    const applied = await runMigrations(pool, { appDbUser: config.APP_DB_USER });
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
