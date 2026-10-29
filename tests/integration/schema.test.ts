import { resetDatabase } from './setup';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, query, withTransaction } from '@/server/db/pool';
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
    expect(applied.map((r) => r.filename)).toContain('0005_guided_intake.sql');
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

  it('constrains the guided intake question fields (0005)', async () => {
    const sessionId = await createSession();
    for (const column of ['status', 'answered_via', 'resolution']) {
      await expect(
        query(`INSERT INTO ai_question (session_id, text, ${column}) VALUES ($1, 'q', 'bogus')`, [sessionId]),
      ).rejects.toMatchObject({ code: '23514' });
    }
    // 'dismissed' stays allowed until the contract step; the new fields accept NULL.
    for (const status of ['open', 'answered', 'resolved', 'dismissed']) {
      await query("INSERT INTO ai_question (session_id, text, status) VALUES ($1, 'q', $2)", [sessionId, status]);
    }
    const [q] = await query<{ id: string }>(
      `INSERT INTO ai_question (session_id, text, status, answer_text, answered_at, answered_via, resolution, resolved_at)
       VALUES ($1, 'q', 'resolved', 'a', now(), 'facilitator', 'answered', now()) RETURNING id`,
      [sessionId],
    );
    await query("INSERT INTO ai_question (session_id, text, answered_via) VALUES ($1, 'q', 'ai')", [sessionId]);
    await query("INSERT INTO ai_question (session_id, text, resolution) VALUES ($1, 'q', 'not_relevant')", [sessionId]);

    // conversation_message.question_id must name an existing question.
    await query(
      "INSERT INTO conversation_message (session_id, seq, role, content, question_id) VALUES ($1, 1, 'facilitator', 'a', $2)",
      [sessionId, q.id],
    );
    await expect(
      query(
        "INSERT INTO conversation_message (session_id, seq, role, content, question_id) VALUES ($1, 2, 'facilitator', 'a', gen_random_uuid())",
        [sessionId],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    const [s] = await query<{ ingested_at: Date | null; analyzed_at: Date | null }>(
      'SELECT ingested_at, analyzed_at FROM planning_session WHERE id = $1',
      [sessionId],
    );
    expect(s).toEqual({ ingested_at: null, analyzed_at: null });
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

// Runs last: it rebuilds the schema at 0004, seeds it, then applies 0005 on top (spec §7 backfill).
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
    await db.query('DROP SCHEMA public CASCADE');
    await db.query('CREATE SCHEMA public');
    await runMigrations(db, dir);

    const withSources = await createSession();
    const withoutSources = await createSession();
    const other = await createSession();
    await query(
      `INSERT INTO source_snapshot (session_id, kind, ref, ingest_status, retrieved_at) VALUES
         ($1, 'jira_issue', 'ABC-1', 'ingested', '2026-10-02T10:00:00Z'),
         ($1, 'confluence_page', '123', 'ingested', '2026-10-01T09:00:00Z'),
         ($1, 'jira_issue', 'ABC-1', 'ingested', '2026-10-03T08:00:00Z'),
         ($2, 'jira_issue', 'ABC-1', 'unavailable', '2026-10-05T12:00:00Z')`,
      [withSources, other],
    );
    const [dismissed] = await query<{ id: string }>(
      `INSERT INTO ai_question (session_id, text, status, dismiss_reason, created_at)
       VALUES ($1, 'Dismissed?', 'dismissed', 'Out of scope', '2026-10-04T11:00:00Z') RETURNING id`,
      [withSources],
    );
    const [open] = await query<{ id: string }>(
      "INSERT INTO ai_question (session_id, text, status) VALUES ($1, 'Open?', 'open') RETURNING id",
      [withSources],
    );
    const [answered] = await query<{ id: string }>(
      "INSERT INTO ai_question (session_id, text, status) VALUES ($1, 'Answered?', 'answered') RETURNING id",
      [withSources],
    );
    await query("INSERT INTO conversation_message (session_id, seq, role, content) VALUES ($1, 1, 'facilitator', 'Hi')", [
      withSources,
    ]);

    expect(await runMigrations(db)).toEqual(['0005_guided_intake.sql']);

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
      'SELECT question_id FROM conversation_message WHERE session_id = $1',
      [withSources],
    );
    expect(message.question_id).toBeNull();
  });
});
