import './env';
import { createDbPool, type DbClient } from '@/server/db/pool';
import { getConfig } from '@/server/config';
import { runMigrations } from '../../scripts/migrate';

// Tests run as the app user (DATABASE_URL). Dropping the database, migrating it and anything else the app user may
// not do (bypassing the audit triggers, reading schema_migrations) runs as the owner (MIGRATE_DATABASE_URL).

/** The database DATABASE_URL names; the owner's URL is pointed at the same one. */
function databaseName(): string {
  return decodeURIComponent(new URL(getConfig().DATABASE_URL).pathname.slice(1));
}

function ownerUrl(database: string): string {
  const url = new URL(getConfig().MIGRATE_DATABASE_URL ?? getConfig().DATABASE_URL);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

/** Runs `fn` on one owner connection to the test database. */
export async function asOwner<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const pool = createDbPool(ownerUrl(databaseName()));
  try {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/** Applies pending migrations to the test database as the owner. */
export async function migrateDatabase(): Promise<string[]> {
  const pool = createDbPool(ownerUrl(databaseName()));
  try {
    return await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Drops `name` as the owner. The migrations' per-table grants to the app user outlive DROP DATABASE (they stay in
 * mysql.tables_priv), so they are revoked first; the owner's GRANT OPTION on the database is enough for that.
 */
export async function dropDatabase(admin: DbClient, name: string): Promise<void> {
  const quoted = `\`${name.replace(/`/g, '``')}\``;
  const tables = await admin.query<{ name: string }>(
    'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
    [name],
  );
  for (const { name: table } of tables.rows) {
    await admin.query(
      `REVOKE IF EXISTS ALL PRIVILEGES ON ${quoted}.\`${table.replace(/`/g, '``')}\` FROM ${getConfig().APP_DB_USER}`,
    );
  }
  await admin.query(`DROP DATABASE IF EXISTS ${quoted}`);
}

// Destroys all data in the target database: drops and re-creates it, then migrates.
export async function resetDatabase(): Promise<void> {
  const name = databaseName();
  const quoted = `\`${name.replace(/`/g, '``')}\``;
  // No default database: the one being dropped may not exist yet.
  const admin = createDbPool(ownerUrl(''));
  try {
    await dropDatabase(admin, name);
    await admin.query(`CREATE DATABASE ${quoted} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  } finally {
    await admin.end();
  }
  await migrateDatabase();
}
