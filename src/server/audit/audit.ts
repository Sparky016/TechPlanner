import type { PoolClient } from 'pg';
import { withTransaction } from '@/server/db/pool';
import type { AuditAction } from './actions';
import { type AuditHashPayload, computeHash, redactDetails } from './hash';

// Server-only: never import from src/lib or client components.
// The single write path for Audit Records (SR-12). audit_record is append-only at the database level
// (migration 0002); each record's hash chains to the previous record's hash.

export interface AuditInput {
  action: AuditAction;
  result: 'success' | 'failure';
  userId?: string | null;
  userDisplayName?: string | null;
  sessionId?: string | null;
  ticketIds?: string[];
  details?: Record<string, unknown>;
  correlationId?: string | null;
}

// Arbitrary but fixed key; every chain writer takes this transaction-scoped lock so chain-head reads are serialised.
const CHAIN_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('audit_chain'))";

// Appends one Audit Record. When `client` is given it must already be inside a transaction (the caller's);
// the record then commits or rolls back with it. Otherwise a transaction of its own is used.
export async function recordAudit(input: AuditInput, client?: PoolClient): Promise<{ id: string; hash: string }> {
  return client ? append(client, input) : withTransaction((tx) => append(tx, input));
}

async function append(client: PoolClient, input: AuditInput): Promise<{ id: string; hash: string }> {
  const payload: AuditHashPayload = {
    ts: new Date().toISOString(),
    userId: input.userId ?? null,
    userDisplayName: input.userDisplayName ?? null,
    // uuid columns read back in canonical form; hash the form the verifier will see.
    sessionId: input.sessionId ? canonicalUuid(input.sessionId) : null,
    ticketIds: input.ticketIds ?? [],
    action: input.action,
    result: input.result,
    // JSON round-trip so the hashed value is exactly what jsonb stores (drops undefined, serialises Dates).
    details: JSON.parse(JSON.stringify(redactDetails(input.details ?? {}))) as Record<string, unknown>,
    correlationId: input.correlationId ?? null,
  };

  await client.query(CHAIN_LOCK_SQL);
  const head = await client.query<{ hash: Buffer }>('SELECT hash FROM audit_record ORDER BY id DESC LIMIT 1');
  const prevHash = head.rows[0]?.hash ?? null;
  const hash = computeHash(prevHash ? prevHash.toString('hex') : '', payload);

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO audit_record
       (ts, user_id, user_display_name, session_id, ticket_ids, action, result, details, correlation_id, prev_hash, hash)
     VALUES ($1::timestamptz, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      payload.ts,
      payload.userId,
      payload.userDisplayName,
      payload.sessionId,
      payload.ticketIds,
      payload.action,
      payload.result,
      JSON.stringify(payload.details),
      payload.correlationId,
      prevHash,
      Buffer.from(hash, 'hex'),
    ],
  );
  return { id: inserted.rows[0].id, hash };
}

// Postgres accepts uuids with braces, without hyphens, or in upper case, but always stores and returns the
// lowercase 8-4-4-4-12 form. Normalise to that form so the hashed value equals the stored one; reject anything else.
function canonicalUuid(value: string): string {
  const unbraced = /^\{.*\}$/.test(value) ? value.slice(1, -1) : value;
  const hex = unbraced.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('sessionId must be a UUID');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
