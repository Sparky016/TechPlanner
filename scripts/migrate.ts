import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';

// Forward-only migration runner: applies db/migrations/*.sql in filename order.
// Each file and its schema_migrations row commit in one transaction, so a failed
// migration leaves nothing behind and re-running applies only what is missing.

export const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');

// Arbitrary constant key for pg_advisory_xact_lock; serialises concurrent runners.
const LOCK_KEY = 727_001;

export async function runMigrations(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );

  const applied: string[] = [];
  for (const filename of files) {
    const client = await pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [filename]);
      if (done.rowCount === 0) {
        await client.query(await readFile(join(dir, filename), 'utf8'));
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
        applied.push(filename);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        discard = true;
      });
      throw new Error(`Migration ${filename} failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    } finally {
      client.release(discard);
    }
  }
  return applied;
}

async function main(): Promise<void> {
  const { db } = await import('@/server/db/pool');
  try {
    const applied = await runMigrations(db);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations');
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
