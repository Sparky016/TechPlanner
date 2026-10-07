import { Client } from 'pg';
import { DATABASE_URL } from './env';

// Creates the E2E database when it does not exist yet (run by the web server command before `npm run migrate`).

async function main(): Promise<void> {
  const target = new URL(DATABASE_URL);
  const name = decodeURIComponent(target.pathname.slice(1));
  const admin = new URL(DATABASE_URL);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rowCount === 0) {
      await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
      console.log(`[e2e] created database ${name}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('[e2e] could not prepare the database:', err instanceof Error ? err.message : err);
  process.exit(1);
});
