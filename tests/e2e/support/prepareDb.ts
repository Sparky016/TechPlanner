import { createDbPool } from '../../../src/server/db/mysql';
import { MIGRATE_DATABASE_URL } from './env';

// Creates the E2E database when it does not exist yet (run by the web server command before `npm run migrate`).

async function main(): Promise<void> {
  const admin = new URL(MIGRATE_DATABASE_URL);
  const name = decodeURIComponent(admin.pathname.slice(1));
  // No default database: it may not exist yet.
  admin.pathname = '/';
  const pool = createDbPool(admin.toString());
  try {
    await pool.query(
      `CREATE DATABASE IF NOT EXISTS \`${name.replace(/`/g, '``')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('[e2e] could not prepare the database:', err instanceof Error ? err.message : err);
  process.exit(1);
});
