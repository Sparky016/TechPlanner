import { asOwner, resetDatabase } from './setup';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuditInput, recordAudit } from '@/server/audit/audit';
import {
  assertStorableDetails,
  canonicalJson,
  jsonNumberRoundTrips,
  REDACTED,
  redactDetails,
} from '@/server/audit/hash';
import { db, type DbClient, query, withTransaction } from '@/server/db/pool';
import { verifyAuditChain } from '../../scripts/audit-verify';
import { MIGRATIONS_DIR, splitStatements } from '../../scripts/migrate';

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

// MySQL triggers cannot be disabled: tampering drops the UPDATE trigger and re-creates it from migration 0002.
async function withoutUpdateTrigger(fn: (owner: DbClient) => Promise<void>): Promise<void> {
  const sql = await readFile(join(MIGRATIONS_DIR, '0002_audit_append_only.sql'), 'utf8');
  const create = splitStatements(sql).find((s) => s.includes('CREATE TRIGGER audit_record_no_update'))!;
  await asOwner(async (owner) => {
    await owner.query('DROP TRIGGER audit_record_no_update');
    try {
      await fn(owner);
    } finally {
      await owner.query(create);
    }
  });
}

describe('audit_record is append-only', () => {
  it('rejects UPDATE, DELETE and TRUNCATE', async () => {
    const { id } = await recordAudit({
      action: 'auth.login',
      result: 'success',
      userId: 'acc-1',
    });

    // The triggers reject UPDATE and DELETE for every user, so try them as the owner; the app user is refused even
    // earlier by privileges (schema.test.ts). MySQL has no TRUNCATE trigger: the app user lacks the privilege.
    await asOwner(async (owner) => {
      await expect(owner.query("UPDATE audit_record SET action = 'auth.logout' WHERE id = ?", [id])).rejects.toThrow(
        /append-only/,
      );
      await expect(owner.query('DELETE FROM audit_record WHERE id = ?', [id])).rejects.toThrow(/append-only/);
    });
    await expect(query('TRUNCATE audit_record')).rejects.toThrow(/DROP command denied/);

    const rows = await query<{ action: string }>('SELECT action FROM audit_record WHERE id = ?', [id]);
    expect(rows).toEqual([{ action: 'auth.login' }]);
  });
});

describe('hash chain', () => {
  it('50 concurrent writers produce one unbroken chain', async () => {
    // Only the owner may truncate (no TRUNCATE trigger in MySQL).
    await asOwner((owner) => owner.query('TRUNCATE audit_record'));

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
    const [row] = await query<{ details: Record<string, unknown> }>('SELECT details FROM audit_record WHERE id = ?', [
      id,
    ]);
    expect(row.details).toEqual({
      accessToken: REDACTED,
      refresh_token: REDACTED,
      Authorization: REDACTED,
      reason: 'expired',
    });
  });

  it('hashes non-canonical session ids in the canonical form they are stored in', async () => {
    const canonical = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    for (const sessionId of ['a0eebc999c0b4ef8bb6d6bb9bd380a11', '{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}']) {
      const { id } = await recordAudit({ action: 'draft.saved', result: 'success', sessionId });
      const [row] = await query<{ session_id: string }>('SELECT session_id FROM audit_record WHERE id = ?', [id]);
      expect(row.session_id).toBe(canonical);
    }
    await expect(recordAudit({ action: 'draft.saved', result: 'success', sessionId: 'not-a-uuid' })).rejects.toThrow(
      /sessionId must be a UUID/,
    );
    expect(await verifyAuditChain(db)).toEqual({ ok: true, count: 54 });
  });

  it('rejects text fields the database would not store verbatim and keeps the chain intact', async () => {
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
      'SELECT user_display_name, ticket_ids FROM audit_record WHERE id = ?',
      [id],
    );
    expect(row).toEqual({ user_display_name: text, ticket_ids: [text] });
    expect(await verifyAuditChain(db)).toEqual({ ok: true, count: 55 });
  });

  it('reports the first tampered record', async () => {
    const ids = await query<{ id: string }>('SELECT id FROM audit_record ORDER BY id');
    const target = ids[10].id;

    await withoutUpdateTrigger(async (owner) => {
      await owner.query(`UPDATE audit_record SET details = '{"index": 999}' WHERE id = ?`, [target]);
    });

    expect(await verifyAuditChain(db)).toEqual({ ok: false, brokenId: target });
    expect(await runVerifyCli()).toEqual({
      code: 1,
      stdout: `BROKEN at id=${target}`,
    });
  }, 60_000);
});

// Property cases (docs/specs/mysql-migration.md §7.3): every details value must read back from the JSON column as
// the value that was hashed. Seeded, so a failure reproduces. Runs last and leaves an intact chain behind, so
// `npm run audit:verify` against the test database reports OK afterwards.
describe('details round-trip through the JSON column', () => {
  // mulberry32: small, seedable, good enough to spread cases.
  function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const NUMBER_GENERATORS: ((r: () => number) => number)[] = [
    (r) => r(),
    (r) => r() * 1e9,
    (r) => (r() - 0.5) * 10 ** Math.floor(r() * 80 - 40),
    (r) => Math.round(r() * 1e6) / 100,
    (r) => Math.floor((r() - 0.5) * 2 ** 70),
    (r) => Number((r() * 1000).toFixed(Math.floor(r() * 15))),
    (r) => Number(`${Math.floor(r() * 1e15)}e${Math.floor(r() * 60 - 30)}`),
    (r) => Math.floor(r() * 2 ** 31) - 2 ** 30,
  ];
  const STRINGS = ['', 'plain', 'Zoë', '😀🚀𝄞', 'a\u0000b', 'line\nbreak\t"quoted"\\', 'e\u0301', 'é', '\u2028', 'ﬀ'];

  function randomValue(r: () => number, depth: number): unknown {
    const pick = Math.floor(r() * (depth > 3 ? 4 : 7));
    if (pick === 0) return NUMBER_GENERATORS[Math.floor(r() * NUMBER_GENERATORS.length)](r);
    if (pick === 1) return STRINGS[Math.floor(r() * STRINGS.length)];
    if (pick === 2) return r() < 0.5 ? null : r() < 0.5;
    if (pick === 3) return [];
    if (pick === 4) return Array.from({ length: Math.floor(r() * 4) }, () => randomValue(r, depth + 1));
    const obj: Record<string, unknown> = {};
    for (let i = Math.floor(r() * 4); i > 0; i--) {
      obj[`${STRINGS[Math.floor(r() * STRINGS.length)]}${Math.floor(r() * 3)}`] = randomValue(r, depth + 1);
    }
    return obj;
  }

  // Hand-picked cases: each must round-trip and be accepted.
  const TABLE: Record<string, unknown>[] = [
    {},
    { empty: [], emptyObject: {}, nothing: null, flag: false },
    { nested: { a: { b: { c: [1, [2, [3, { d: 'deep' }]]] } } } },
    { astral: '😀 𝄞 🇿🇦', keys: { '😀': 1, '𝄞': 2 }, nfc: 'é', nfd: 'e\u0301', nul: 'a\u0000b' },
    { 'e\u0301': 'nfd key', é: 'nfc key', '': 'empty key', ' ': 'space key' },
    { safe: [2 ** 53 - 1, -(2 ** 53 - 1), 0, -0, 1e21, 1e22, 1e-7, 1e-22, 0.1, 4.35, 123456789012.345] },
    { beyond53: [2 ** 53, 2 ** 53 + 2, 2 ** 60, 2 ** 63, 2 ** 64 - 2048, -(2 ** 62), 12345678901234567890] },
    { fractions: [1.5, -2.25, 0.000001, 99.99, 3.14159265358979] },
    { dates: new Date(0), skipped: undefined, inArray: [undefined, new Date(Date.UTC(2026, 9, 29, 12, 0, 0, 123))] },
    { long: 'x'.repeat(20_000), many: Array.from({ length: 500 }, (_, i) => i * 3) },
    { deep: JSON.parse(`${'['.repeat(60)}1${']'.repeat(60)}`) as unknown },
    { accessToken: 'secret', nested: { password: 'p', ok: 1 } },
  ];

  async function readBackDetails(id: string): Promise<unknown> {
    const [row] = await query<{ details: unknown }>('SELECT details FROM audit_record WHERE id = ?', [id]);
    return row.details;
  }

  it('reads every hand-picked case back as hashed, and the verifier reports the chain intact', async () => {
    await asOwner((owner) => owner.query('TRUNCATE audit_record'));
    for (const details of TABLE) {
      const { id } = await recordAudit({ action: 'draft.saved', result: 'success', details });
      const hashed = JSON.parse(JSON.stringify(redactDetails(details))) as unknown;
      expect(canonicalJson(await readBackDetails(id))).toBe(canonicalJson(hashed));
    }
    expect(await verifyAuditChain(db)).toEqual({ ok: true, count: TABLE.length });
  });

  it('accepts exactly the seeded random details whose numbers MySQL stores exactly; those round-trip', async () => {
    const r = prng(47);
    let written = 0;
    let rejected = 0;
    // Batches of concurrent writers, so the chain lock is exercised with the same documents.
    for (let batch = 0; batch < 10; batch++) {
      const docs = Array.from({ length: 20 }, () => ({ v: randomValue(r, 0), n: randomValue(r, 3) }));
      const outcomes = await Promise.allSettled(
        docs.map((details) => recordAudit({ action: 'user.edit', result: 'success', details })),
      );
      for (const [i, outcome] of outcomes.entries()) {
        const hashed = JSON.parse(JSON.stringify(docs[i])) as unknown;
        let storable = true;
        try {
          assertStorableDetails(hashed);
        } catch {
          storable = false;
        }
        if (outcome.status === 'fulfilled') {
          expect(storable).toBe(true);
          expect(canonicalJson(await readBackDetails(outcome.value.id))).toBe(canonicalJson(hashed));
          written++;
        } else {
          expect(storable).toBe(false);
          expect(String(outcome.reason)).toMatch(/^Error: details.* must be a number MySQL JSON stores exactly/s);
          rejected++;
        }
      }
    }
    // The seed produces both kinds; a change to the generators that loses either would weaken the test.
    expect(written).toBeGreaterThan(50);
    expect(rejected).toBeGreaterThan(10);
    expect(await verifyAuditChain(db)).toEqual({ ok: true, count: TABLE.length + written });
    expect(await runVerifyCli()).toEqual({ code: 0, stdout: `OK ${TABLE.length + written}` });
  }, 60_000);

  it('the rule is safe on MySQL: accepted numbers read back unchanged, rejected ones often do not', async () => {
    const r = prng(4747);
    const values = Array.from({ length: 6000 }, (_, i) => NUMBER_GENERATORS[i % NUMBER_GENERATORS.length](r));
    const accepted = values.filter(jsonNumberRoundTrips);
    const rejected = values.filter((v) => !jsonNumberRoundTrips(v));
    const readBack = async (list: number[]): Promise<number[]> => {
      const [row] = await query<{ j: number[] }>('SELECT CAST(? AS JSON) AS j', [JSON.stringify(list)]);
      return row.j;
    };
    // -0 is written as 0 by JSON.stringify, so compare the JSON text.
    expect(JSON.stringify(await readBack(accepted))).toBe(JSON.stringify(accepted));
    // Without the guard these would break the chain: MySQL's JSON parser rounds them.
    const back = await readBack(rejected);
    expect(rejected.filter((v, i) => back[i] !== v).length).toBeGreaterThan(100);
    expect(await readBack([123456789.12345679, 226.31531953811646])).toEqual([123456789.1234568, 226.31531953811648]);
  });

  it('rejects a details value that would read back differently and writes nothing', async () => {
    const [before] = await query<{ n: string }>('SELECT count(*) AS n FROM audit_record');
    for (const details of [{ ratio: 123456789.12345679 }, { nested: [{ x: 2 ** 64 }] }, { text: 'x\uD800' }]) {
      await expect(recordAudit({ action: 'draft.saved', result: 'success', details })).rejects.toThrow(/^details\./);
    }
    const [after] = await query<{ n: string }>('SELECT count(*) AS n FROM audit_record');
    expect(after.n).toBe(before.n);
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });
});
