import { resetDatabase } from './setup';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuditInput, recordAudit } from '@/server/audit/audit';
import { REDACTED } from '@/server/audit/hash';
import { db, query, withTransaction } from '@/server/db/pool';
import { verifyAuditChain } from '../../scripts/audit-verify';

const run = promisify(execFile);
const TSX_CLI = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const VERIFY_SCRIPT = join(process.cwd(), 'scripts', 'audit-verify.ts');

// Runs the real verifier CLI (what `npm run audit:verify` executes) against the test database.
async function runVerifyCli(): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await run(process.execPath, [TSX_CLI, VERIFY_SCRIPT], {
      env: process.env,
    });
    return { code: 0, stdout: stdout.trim() };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: e.code ?? -1, stdout: (e.stdout ?? '').trim() };
  }
}

beforeAll(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await db.end();
});

describe('audit_record is append-only', () => {
  it('rejects UPDATE, DELETE and TRUNCATE', async () => {
    const { id } = await recordAudit({
      action: 'auth.login',
      result: 'success',
      userId: 'acc-1',
    });

    await expect(query("UPDATE audit_record SET action = 'auth.logout' WHERE id = $1", [id])).rejects.toThrow(
      /append-only/,
    );
    await expect(query('DELETE FROM audit_record WHERE id = $1', [id])).rejects.toThrow(/append-only/);
    await expect(query('TRUNCATE audit_record')).rejects.toThrow(/append-only/);

    const rows = await query<{ action: string }>('SELECT action FROM audit_record WHERE id = $1', [id]);
    expect(rows).toEqual([{ action: 'auth.login' }]);
  });
});

describe('hash chain', () => {
  it('50 concurrent writers produce one unbroken chain', async () => {
    await withTransaction(async (client) => {
      await client.query('ALTER TABLE audit_record DISABLE TRIGGER audit_record_no_truncate');
      await client.query('TRUNCATE audit_record');
      await client.query('ALTER TABLE audit_record ENABLE TRIGGER audit_record_no_truncate');
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        recordAudit({
          action: 'user.edit',
          result: i % 7 === 0 ? 'failure' : 'success',
          userId: `acc-${i}`,
          userDisplayName: `User ${i}`,
          sessionId: i % 2 === 0 ? 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11' : null,
          ticketIds: i % 3 === 0 ? ['ABC-1', 'ABC-2'] : undefined,
          details: {
            index: i,
            nested: { z: 1, a: [1, 2] },
            at: new Date(0),
            skip: undefined,
          },
          correlationId: `corr-${i}`,
        }),
      ),
    );
    expect(new Set(results.map((r) => r.hash)).size).toBe(50);

    const links = await query<{ forks: string }>(
      'SELECT count(*) AS forks FROM audit_record WHERE prev_hash IS NOT NULL GROUP BY prev_hash HAVING count(*) > 1',
    );
    expect(links).toEqual([]);

    expect(await verifyAuditChain(db)).toEqual({ ok: true, count: 50 });
    expect(await runVerifyCli()).toEqual({ code: 0, stdout: 'OK 50' });
  }, 60_000);

  it('joins the caller transaction when a client is given and rolls back with it', async () => {
    const [before] = await query<{ n: string }>('SELECT count(*) AS n FROM audit_record');
    await expect(
      withTransaction(async (client) => {
        await recordAudit({ action: 'draft.saved', result: 'success' }, client);
        throw new Error('caller failed');
      }),
    ).rejects.toThrow('caller failed');
    const [after] = await query<{ n: string }>('SELECT count(*) AS n FROM audit_record');
    expect(after.n).toBe(before.n);

    const { id } = await withTransaction((client) => recordAudit({ action: 'draft.saved', result: 'success' }, client));
    expect(id).toMatch(/^\d+$/);
    expect(await verifyAuditChain(db)).toEqual({ ok: true, count: 51 });
  });

  it('stores redacted details', async () => {
    const { id } = await recordAudit({
      action: 'auth.failure',
      result: 'failure',
      details: {
        accessToken: 'at',
        refresh_token: 'rt',
        Authorization: 'Bearer x',
        reason: 'expired',
      },
    });
    const [row] = await query<{ details: Record<string, unknown> }>('SELECT details FROM audit_record WHERE id = $1', [
      id,
    ]);
    expect(row.details).toEqual({
      accessToken: REDACTED,
      refresh_token: REDACTED,
      Authorization: REDACTED,
      reason: 'expired',
    });
  });

  it('hashes non-canonical session ids in the form Postgres stores them', async () => {
    const canonical = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    for (const sessionId of ['a0eebc999c0b4ef8bb6d6bb9bd380a11', '{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}']) {
      const { id } = await recordAudit({ action: 'draft.saved', result: 'success', sessionId });
      const [row] = await query<{ session_id: string }>('SELECT session_id FROM audit_record WHERE id = $1', [id]);
      expect(row.session_id).toBe(canonical);
    }
    await expect(recordAudit({ action: 'draft.saved', result: 'success', sessionId: 'not-a-uuid' })).rejects.toThrow(
      /sessionId must be a UUID/,
    );
    expect(await verifyAuditChain(db)).toEqual({ ok: true, count: 54 });
  });

  it('rejects text fields Postgres would not store verbatim and keeps the chain intact', async () => {
    const bad: Partial<AuditInput>[] = [
      { userId: '\uDC00' },
      { userDisplayName: 'x\uD800y' },
      { correlationId: 'c\uD83D' },
      { ticketIds: ['ABC-1', 'A\uD800'] },
    ];
    for (const fields of bad) {
      await expect(recordAudit({ action: 'draft.saved', result: 'success', ...fields })).rejects.toThrow(
        /must be well-formed Unicode/,
      );
    }

    const text = 'Zoë 😀';
    const { id } = await recordAudit({
      action: 'draft.saved',
      result: 'success',
      userId: text,
      userDisplayName: text,
      correlationId: text,
      ticketIds: [text],
    });
    const [row] = await query<{ user_display_name: string; ticket_ids: string[] }>(
      'SELECT user_display_name, ticket_ids FROM audit_record WHERE id = $1',
      [id],
    );
    expect(row).toEqual({ user_display_name: text, ticket_ids: [text] });
    expect(await verifyAuditChain(db)).toEqual({ ok: true, count: 55 });
  });

  it('reports the first tampered record', async () => {
    const ids = await query<{ id: string }>('SELECT id FROM audit_record ORDER BY id');
    const target = ids[10].id;

    await withTransaction(async (client) => {
      await client.query('ALTER TABLE audit_record DISABLE TRIGGER audit_record_no_update_delete');
      await client.query(`UPDATE audit_record SET details = '{"index": 999}' WHERE id = $1`, [target]);
      await client.query('ALTER TABLE audit_record ENABLE TRIGGER audit_record_no_update_delete');
    });

    expect(await verifyAuditChain(db)).toEqual({ ok: false, brokenId: target });
    expect(await runVerifyCli()).toEqual({
      code: 1,
      stdout: `BROKEN at id=${target}`,
    });
  }, 60_000);
});
