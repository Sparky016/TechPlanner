import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { computeHash } from '@/server/audit/hash';

// Audit chain verifier (SR-12.6): walks audit_record in id order with a server-side cursor,
// recomputes every hash and checks every prev_hash link. Reports the first broken record.

const BATCH_SIZE = 500;

interface AuditRow {
  id: string;
  ts: Date;
  user_id: string | null;
  user_display_name: string | null;
  session_id: string | null;
  ticket_ids: string[] | null;
  action: string;
  result: 'success' | 'failure';
  details: Record<string, unknown>;
  correlation_id: string | null;
  prev_hash: Buffer | null;
  hash: Buffer;
}

export type VerifyResult = { ok: true; count: number } | { ok: false; brokenId: string };

export async function verifyAuditChain(pool: Pool): Promise<VerifyResult> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('DECLARE audit_cursor NO SCROLL CURSOR FOR SELECT * FROM audit_record ORDER BY id');
    let prevHex = '';
    let count = 0;
    for (;;) {
      const { rows } = await client.query<AuditRow>(`FETCH ${BATCH_SIZE} FROM audit_cursor`);
      if (rows.length === 0) break;
      for (const row of rows) {
        const storedPrevHex = row.prev_hash ? row.prev_hash.toString('hex') : '';
        const recomputed = computeHash(prevHex, {
          ts: row.ts.toISOString(),
          userId: row.user_id,
          userDisplayName: row.user_display_name,
          sessionId: row.session_id,
          ticketIds: row.ticket_ids ?? [],
          action: row.action,
          result: row.result,
          details: row.details,
          correlationId: row.correlation_id,
        });
        const storedHex = row.hash.toString('hex');
        if (storedPrevHex !== prevHex || recomputed !== storedHex) {
          await client.query('ROLLBACK');
          return { ok: false, brokenId: row.id };
        }
        prevHex = storedHex;
        count += 1;
      }
    }
    await client.query('COMMIT');
    return { ok: true, count };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      discard = true;
    });
    throw err;
  } finally {
    client.release(discard);
  }
}

export function formatResult(result: VerifyResult): string {
  return result.ok ? `OK ${result.count}` : `BROKEN at id=${result.brokenId}`;
}

async function main(): Promise<void> {
  const { db } = await import('@/server/db/pool');
  try {
    const result = await verifyAuditChain(db);
    console.log(formatResult(result));
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
