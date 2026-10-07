import { query } from '@/server/db/pool';

// Server-only: never import from src/lib or client components.
// Read audit records for a session with keyset pagination and optional action filtering.

export interface AuditRecord {
  id: string;
  ts: string;
  user: { accountId: string | null; displayName: string | null };
  sessionId: string | null;
  ticketIds: string[];
  action: string;
  result: string;
  details: Record<string, unknown>;
  correlationId: string | null;
  hash: string;
}

// Lists audit records for a session, newest first, with keyset pagination and action filter.
// Cursor is the id of the last record from the previous page (or null for the first page).
// Returns at most `limit` records plus a nextCursor to fetch the next page (null if no more).
export async function listSessionAudit(
  sessionId: string,
  cursor: string | null,
  limit: number,
  action: string | null,
): Promise<{ records: AuditRecord[]; nextCursor: string | null }> {
  // Query is: WHERE session_id = $1 AND ($2::bigint IS NULL OR id < $2) AND ($3::text IS NULL OR action = $3)
  // ORDER BY id DESC LIMIT limit+1
  // This fetches one extra row to compute nextCursor; we return at most `limit` records.
  const rows = await query<{
    id: string;
    ts: Date;
    user_id: string | null;
    user_display_name: string | null;
    session_id: string | null;
    ticket_ids: string[] | null;
    action: string;
    result: string;
    details: Record<string, unknown>;
    correlation_id: string | null;
    hash: Buffer;
  }>(
    `SELECT id, ts, user_id, user_display_name, session_id, ticket_ids, action, result, details, correlation_id, hash
     FROM audit_record
     WHERE session_id = $1
       AND ($2::bigint IS NULL OR id < $2)
       AND ($3::text IS NULL OR action = $3)
     ORDER BY id DESC
     LIMIT $4`,
    [sessionId, cursor ? BigInt(cursor) : null, action, limit + 1],
  );

  const records: AuditRecord[] = rows.slice(0, limit).map(mapAuditRow);
  const nextCursor = rows.length > limit ? rows[limit - 1].id : null;

  return { records, nextCursor };
}

// Streams audit records for a session, oldest first, for export as JSON Lines.
// Uses keyset pagination in batches of 500 to avoid loading all records into memory.
export async function streamSessionAudit(sessionId: string): Promise<ReadableStream<Uint8Array>> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastId: string | null = null;

      try {
        while (true) {
          type AuditRow = {
            id: string;
            ts: Date;
            user_id: string | null;
            user_display_name: string | null;
            session_id: string | null;
            ticket_ids: string[] | null;
            action: string;
            result: string;
            details: Record<string, unknown>;
            correlation_id: string | null;
            hash: Buffer;
          };
          const rows: AuditRow[] = await query<AuditRow>(
            `SELECT id, ts, user_id, user_display_name, session_id, ticket_ids, action, result, details, correlation_id, hash
             FROM audit_record
             WHERE session_id = $1 AND ($2::bigint IS NULL OR id > $2)
             ORDER BY id ASC
             LIMIT 500`,
            [sessionId, lastId ? BigInt(lastId) : null],
          );

          if (rows.length === 0) break;

          for (const row of rows) {
            const record = mapAuditRow(row);
            const line = JSON.stringify(record) + '\n';
            controller.enqueue(new TextEncoder().encode(line));
            lastId = row.id;
          }

          if (rows.length < 500) break;
        }
      } catch (err) {
        controller.error(err);
        return;
      }

      controller.close();
    },
  });
}

function mapAuditRow(row: {
  id: string;
  ts: Date;
  user_id: string | null;
  user_display_name: string | null;
  session_id: string | null;
  ticket_ids: string[] | null;
  action: string;
  result: string;
  details: Record<string, unknown>;
  correlation_id: string | null;
  hash: Buffer;
}): AuditRecord {
  return {
    id: row.id,
    ts: row.ts.toISOString(),
    user: { accountId: row.user_id, displayName: row.user_display_name },
    sessionId: row.session_id,
    ticketIds: row.ticket_ids ?? [],
    action: row.action,
    result: row.result,
    details: row.details,
    correlationId: row.correlation_id,
    hash: row.hash.toString('hex'),
  };
}
