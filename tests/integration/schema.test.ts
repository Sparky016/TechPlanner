import { asOwner, dropDatabase, migrateDatabase, resetDatabase } from './setup';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getConfig } from '@/server/config';
import { isCheckViolation, isTriggerRejection } from '@/server/db/errors';
import { createDbPool, db, query, withTransaction } from '@/server/db/pool';
import { MIGRATIONS_DIR, runMigrations } from '../../scripts/migrate';

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
  const id = randomUUID();
  await query(
    "INSERT INTO planning_session (id, primary_ticket_key, ticket_keys) VALUES (?, 'ABC-1', '[\"ABC-1\"]')",
    [id],
  );
  return id;
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
      "SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'",
    );
    const names = rows.map((r) => r.table_name);
    for (const table of TABLES) expect(names).toContain(table);

    // The app user has no grant on schema_migrations.
    const applied = await asOwner((c) => c.query<{ filename: string }>('SELECT filename FROM schema_migrations'));
    expect(applied.rows.map((r) => r.filename)).toContain('0001_init.sql');
  });

  it('is a no-op when re-run', async () => {
    expect(await migrateDatabase()).toEqual([]);
  });

  it('serialises concurrent runs: every file is applied exactly once (AC4)', async () => {
    const owner = new URL(getConfig().MIGRATE_DATABASE_URL!);
    const scratch = `${decodeURIComponent(owner.pathname.slice(1))}_concurrent`;
    owner.pathname = '/';
    const admin = createDbPool(owner.toString());
    owner.pathname = `/${scratch}`;
    const pools = [createDbPool(owner.toString()), createDbPool(owner.toString())];
    try {
      await dropDatabase(admin, scratch);
      await admin.query(`CREATE DATABASE \`${scratch}\``);
      const runs = await Promise.all(pools.map((p) => runMigrations(p)));

      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
      expect([...runs[0], ...runs[1]].sort()).toEqual(files);
      const recorded = await pools[0].query<{ filename: string }>('SELECT filename FROM schema_migrations');
      expect(recorded.rows.map((r) => r.filename).sort()).toEqual(files);
    } finally {
      await dropDatabase(admin, scratch).catch(() => undefined);
      await Promise.all([admin.end(), ...pools.map((p) => p.end())]);
    }
  });
});

describe('check constraints', () => {
  it('rejects an invalid planning_session.status', async () => {
    await expect(
      query("INSERT INTO planning_session (primary_ticket_key, ticket_keys, status) VALUES ('ABC-1', '[]', 'bogus')"),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('rejects invalid enum values on other tables', async () => {
    const sessionId = await createSession();
    await expect(
      query("INSERT INTO conversation_message (session_id, seq, role, content) VALUES (?, 1, 'bogus', 'x')", [
        sessionId,
      ]),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      query(
        "INSERT INTO issue (session_id, severity, section, description, fingerprint) VALUES (?, 'bogus', 's', 'd', 'f')",
        [sessionId],
      ),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      query("INSERT INTO audit_record (action, result, hash) VALUES ('x', 'bogus', X'00')"),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('withTransaction', () => {
  it('commits on success', async () => {
    const id = randomUUID();
    await withTransaction(async (client) => {
      await client.query(
        "INSERT INTO planning_session (id, primary_ticket_key, ticket_keys) VALUES (?, 'TX-OK', '[]')",
        [id],
      );
    });
    expect(await query('SELECT 1 FROM planning_session WHERE id = ?', [id])).toHaveLength(1);
  });

  it('rolls back on a thrown error and releases the client', async () => {
    await expect(
      withTransaction(async (client) => {
        await client.query("INSERT INTO planning_session (primary_ticket_key, ticket_keys) VALUES ('TX-FAIL', '[]')");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await query("SELECT 1 FROM planning_session WHERE primary_ticket_key = 'TX-FAIL'")).toHaveLength(0);
    // Released: the pool has no checked-out clients.
    expect(db.stats()).toEqual({ checkedOut: 0, waiting: 0 });
  });
});

describe('revision immutability', () => {
  it('rejects updating sections but allows published false -> true', async () => {
    const sessionId = await createSession();
    await query(
      "INSERT INTO revision (session_id, number, sections, `trigger`) VALUES (?, 1, '{\"a\": 1}', 'save')",
      [sessionId],
    );

    await expect(
      query('UPDATE revision SET sections = \'{"a": 2}\' WHERE session_id = ? AND number = 1', [sessionId]),
    ).rejects.toSatisfy(isTriggerRejection);
    await expect(
      query(
        'UPDATE revision SET published = true, readiness_score = 99 WHERE session_id = ? AND number = 1',
        [sessionId],
      ),
    ).rejects.toSatisfy(isTriggerRejection);

    await query('UPDATE revision SET published = true WHERE session_id = ? AND number = 1', [sessionId]);
    const [row] = await query<{ published: boolean; sections: unknown }>(
      'SELECT published, sections FROM revision WHERE session_id = ? AND number = 1',
      [sessionId],
    );
    expect(row).toEqual({ published: true, sections: { a: 1 } });

    await expect(
      query('UPDATE revision SET published = false WHERE session_id = ? AND number = 1', [sessionId]),
    ).rejects.toSatisfy(isTriggerRejection);
  });
});

describe('audit_record append-only (AC3)', () => {
  async function auditId(): Promise<string> {
    await query("INSERT INTO audit_record (action, result, hash) VALUES ('test.append_only', 'success', X'01')");
    const [row] = await query<{ id: string }>(
      "SELECT id FROM audit_record WHERE action = 'test.append_only' ORDER BY id DESC LIMIT 1",
    );
    return row.id;
  }

  it('rejects UPDATE and DELETE by trigger, even for the owner', async () => {
    const id = await auditId();
    await asOwner(async (owner) => {
      await expect(owner.query("UPDATE audit_record SET action = 'x' WHERE id = ?", [id])).rejects.toSatisfy(
        isTriggerRejection,
      );
      await expect(owner.query('DELETE FROM audit_record WHERE id = ?', [id])).rejects.toSatisfy(isTriggerRejection);
    });
    expect(await query('SELECT action FROM audit_record WHERE id = ?', [id])).toEqual([{ action: 'test.append_only' }]);
  });

  it('refuses UPDATE, DELETE and TRUNCATE to the app user by privileges', async () => {
    const id = await auditId();
    // ER_TABLEACCESS_DENIED_ERROR: the privilege check runs before any trigger.
    const denied = { errno: 1142 };
    await expect(query("UPDATE audit_record SET action = 'x' WHERE id = ?", [id])).rejects.toMatchObject(denied);
    await expect(query('DELETE FROM audit_record WHERE id = ?', [id])).rejects.toMatchObject(denied);
    await expect(query('TRUNCATE audit_record')).rejects.toMatchObject(denied);
    expect(await query('SELECT action FROM audit_record WHERE id = ?', [id])).toEqual([{ action: 'test.append_only' }]);
  });
});
