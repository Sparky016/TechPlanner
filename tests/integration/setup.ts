import './env';
import { db } from '@/server/db/pool';
import { runMigrations } from '../../scripts/migrate';

// Destroys all data in the target database: drops and recreates schema public, then migrates.
export async function resetDatabase(): Promise<void> {
  await db.query('DROP SCHEMA public CASCADE');
  await db.query('CREATE SCHEMA public');
  await runMigrations(db);
}
