import { asOwner, dropDatabase, migrateDatabase, resetDatabase } from './setup';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getConfig } from '@/server/config';
import { isCheckViolation, isForeignKeyViolation, isTriggerRejection } from '@/server/db/errors';
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
    expect(applied.rows.map((r) => r.filename)).toContain('0005_guided_intake.sql');
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

  it('constrains the guided intake question fields (0005)', async () => {
    const sessionId = await createSession();
    for (const column of ['status', 'answered_via', 'resolution']) {
      await expect(
        query(`INSERT INTO ai_question (session_id, text, ${column}) VALUES (?, 'q', 'bogus')`, [sessionId]),
      ).rejects.toSatisfy(isCheckViolation);
    }
    // 'dismissed' stays allowed until the contract step; the new fields accept NULL.
    for (const status of ['open', 'answered', 'resolved', 'dismissed']) {
      await query("INSERT INTO ai_question (session_id, text, status) VALUES (?, 'q', ?)", [sessionId, status]);
    }
    const questionId = randomUUID();
    await query(
      `INSERT INTO ai_question (id, session_id, text, status, answer_text, answered_at, answered_via, resolution, resolved_at)
       VALUES (?, ?, 'q', 'resolved', 'a', NOW(6), 'facilitator', 'answered', NOW(6))`,
      [questionId, sessionId],
    );
    await query("INSERT INTO ai_question (session_id, text, answered_via) VALUES (?, 'q', 'ai')", [sessionId]);
    await query("INSERT INTO ai_question (session_id, text, resolution) VALUES (?, 'q', 'not_relevant')", [sessionId]);

    // conversation_message.question_id must name an existing question.
    await query(
      "INSERT INTO conversation_message (session_id, seq, role, content, question_id) VALUES (?, 1, 'facilitator', 'a', ?)",
      [sessionId, questionId],
    );
    await expect(
      query(
        "INSERT INTO conversation_message (session_id, seq, role, content, question_id) VALUES (?, 2, 'facilitator', 'a', UUID())",
        [sessionId],
      ),
    ).rejects.toSatisfy(isForeignKeyViolation);

    const [s] = await query<{ ingested_at: Date | null; analyzed_at: Date | null }>(
      'SELECT ingested_at, analyzed_at FROM planning_session WHERE id = ?',
      [sessionId],
    );
    expect(s).toEqual({ ingested_at: null, analyzed_at: null });
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

// Runs last: it rebuilds the schema at 0004, seeds it, then applies 0005 (and 0006) on top (spec §7 backfill).
describe('0005 guided intake backfill', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'migrations-0004-'));
    for (const f of await readdir(MIGRATIONS_DIR)) {
      if (f.endsWith('.sql') && f < '0005') await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('migrates dismissed questions to resolved and marks sessions with snapshots as ingested and analyzed', async () => {
    await resetDatabase(dir);

    const withSources = await createSession();
    const withoutSources = await createSession();
    const other = await createSession();
    // Session time zone is UTC (src/server/db/mysql.ts), so these DATETIME literals are UTC.
    await query(
      `INSERT INTO source_snapshot (session_id, kind, ref, ingest_status, retrieved_at) VALUES
         (?, 'jira_issue', 'ABC-1', 'ingested', '2026-10-02 10:00:00'),
         (?, 'confluence_page', '123', 'ingested', '2026-10-01 09:00:00'),
         (?, 'jira_issue', 'ABC-1', 'ingested', '2026-10-03 08:00:00'),
         (?, 'jira_issue', 'ABC-1', 'unavailable', '2026-10-05 12:00:00')`,
      [withSources, withSources, withSources, other],
    );
    const dismissed = { id: randomUUID() };
    await query(
      `INSERT INTO ai_question (id, session_id, text, status, dismiss_reason, created_at)
       VALUES (?, ?, 'Dismissed?', 'dismissed', 'Out of scope', '2026-10-04 11:00:00')`,
      [dismissed.id, withSources],
    );
    const open = { id: randomUUID() };
    await query("INSERT INTO ai_question (id, session_id, text, status) VALUES (?, ?, 'Open?', 'open')", [
      open.id,
      withSources,
    ]);
    const answered = { id: randomUUID() };
    await query("INSERT INTO ai_question (id, session_id, text, status) VALUES (?, ?, 'Answered?', 'answered')", [
      answered.id,
      withSources,
    ]);
    await query("INSERT INTO conversation_message (session_id, seq, role, content) VALUES (?, 1, 'facilitator', 'Hi')", [
      withSources,
    ]);

    expect(await migrateDatabase()).toEqual(['0005_guided_intake.sql', '0006_job_queue.sql']);

    const sessions = await query<{ id: string; ingested_at: Date | null; analyzed_at: Date | null }>(
      'SELECT id, ingested_at, analyzed_at FROM planning_session',
    );
    const byId = new Map(sessions.map((r) => [r.id, r]));
    // min(retrieved_at) across every snapshot batch of the session.
    expect(byId.get(withSources)).toMatchObject({
      ingested_at: new Date('2026-10-01T09:00:00Z'),
      analyzed_at: new Date('2026-10-01T09:00:00Z'),
    });
    expect(byId.get(other)).toMatchObject({
      ingested_at: new Date('2026-10-05T12:00:00Z'),
      analyzed_at: new Date('2026-10-05T12:00:00Z'),
    });
    expect(byId.get(withoutSources)).toMatchObject({ ingested_at: null, analyzed_at: null });

    const questions = await query<{
      id: string;
      status: string;
      resolution: string | null;
      resolved_at: Date | null;
      dismiss_reason: string | null;
      answer_text: string | null;
      answered_at: Date | null;
      answered_via: string | null;
    }>(
      `SELECT id, status, resolution, resolved_at, dismiss_reason, answer_text, answered_at, answered_via
         FROM ai_question`,
    );
    const q = new Map(questions.map((r) => [r.id, r]));
    expect(q.get(dismissed.id)).toEqual({
      id: dismissed.id,
      status: 'resolved',
      resolution: 'not_relevant',
      resolved_at: new Date('2026-10-04T11:00:00Z'),
      dismiss_reason: 'Out of scope',
      answer_text: null,
      answered_at: null,
      answered_via: null,
    });
    expect(q.get(open.id)).toMatchObject({ status: 'open', resolution: null, resolved_at: null });
    expect(q.get(answered.id)).toMatchObject({ status: 'answered', resolution: null, resolved_at: null });

    const [message] = await query<{ question_id: string | null }>(
      'SELECT question_id FROM conversation_message WHERE session_id = ?',
      [withSources],
    );
    expect(message.question_id).toBeNull();
  });
});
