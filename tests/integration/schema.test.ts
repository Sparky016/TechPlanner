import { resetDatabase } from './setup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, query, withTransaction } from '@/server/db/pool';
import { runMigrations } from '../../scripts/migrate';

const TABLES = [
  'app_user',
  'oauth_token',
  'app_session',
  'planning_session',
  'source_snapshot',
  'conversation_message',
  'working_copy',
  'pending_suggestion',
  'revision',
  'evaluation',
  'issue',
  'ai_question',
  'publish_run',
  'audit_record',
];

async function createSession(): Promise<string> {
  const [row] = await query<{ id: string }>(
    "INSERT INTO planning_session (primary_ticket_key, ticket_keys) VALUES ('ABC-1', ARRAY['ABC-1']) RETURNING id",
  );
  return row.id;
}

beforeAll(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await db.end();
});

describe('migrations', () => {
  it('creates all 14 tables and records the migration', async () => {
    const rows = await query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    const names = rows.map((r) => r.table_name);
    for (const table of TABLES) expect(names).toContain(table);

    const applied = await query<{ filename: string }>('SELECT filename FROM schema_migrations');
    expect(applied.map((r) => r.filename)).toContain('0001_init.sql');
  });

  it('is a no-op when re-run', async () => {
    expect(await runMigrations(db)).toEqual([]);
  });
});

describe('check constraints', () => {
  it('rejects an invalid planning_session.status', async () => {
    await expect(
      query("INSERT INTO planning_session (primary_ticket_key, ticket_keys, status) VALUES ('ABC-1', '{}', 'bogus')"),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects invalid enum values on other tables', async () => {
    const sessionId = await createSession();
    await expect(
      query("INSERT INTO conversation_message (session_id, seq, role, content) VALUES ($1, 1, 'bogus', 'x')", [
        sessionId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      query(
        "INSERT INTO issue (session_id, severity, section, description, fingerprint) VALUES ($1, 'bogus', 's', 'd', 'f')",
        [sessionId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      query("INSERT INTO audit_record (action, result, hash) VALUES ('x', 'bogus', '\\x00')"),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('withTransaction', () => {
  it('commits on success', async () => {
    const id = await withTransaction(async (client) => {
      const res = await client.query<{ id: string }>(
        "INSERT INTO planning_session (primary_ticket_key, ticket_keys) VALUES ('TX-OK', '{}') RETURNING id",
      );
      return res.rows[0].id;
    });
    expect(await query('SELECT 1 FROM planning_session WHERE id = $1', [id])).toHaveLength(1);
  });

  it('rolls back on a thrown error and releases the client', async () => {
    await expect(
      withTransaction(async (client) => {
        await client.query("INSERT INTO planning_session (primary_ticket_key, ticket_keys) VALUES ('TX-FAIL', '{}')");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await query("SELECT 1 FROM planning_session WHERE primary_ticket_key = 'TX-FAIL'")).toHaveLength(0);
    // Released: the pool has no checked-out clients.
    expect(db.totalCount - db.idleCount).toBe(0);
    expect(db.waitingCount).toBe(0);
  });
});

describe('revision immutability', () => {
  it('rejects updating sections but allows published false -> true', async () => {
    const sessionId = await createSession();
    await query(
      "INSERT INTO revision (session_id, number, sections, trigger) VALUES ($1, 1, '{\"a\": 1}', 'save')",
      [sessionId],
    );

    await expect(
      query('UPDATE revision SET sections = \'{"a": 2}\' WHERE session_id = $1 AND number = 1', [sessionId]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      query(
        'UPDATE revision SET published = true, readiness_score = 99 WHERE session_id = $1 AND number = 1',
        [sessionId],
      ),
    ).rejects.toMatchObject({ code: '23001' });

    await query('UPDATE revision SET published = true WHERE session_id = $1 AND number = 1', [sessionId]);
    const [row] = await query<{ published: boolean; sections: unknown }>(
      'SELECT published, sections FROM revision WHERE session_id = $1 AND number = 1',
      [sessionId],
    );
    expect(row).toEqual({ published: true, sections: { a: 1 } });

    await expect(
      query('UPDATE revision SET published = false WHERE session_id = $1 AND number = 1', [sessionId]),
    ).rejects.toMatchObject({ code: '23001' });
  });
});
