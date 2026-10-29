import { recordAudit } from '@/server/audit/audit';
import type { CurrentUser } from '@/server/auth/session';
import { query, withTransaction } from '@/server/db/pool';
import { HttpError } from '@/server/http/errors';
import { isUuid } from './repo';

// Server-only: never import from src/lib or client components.
// Single-editor session lock (D-3). The holder is a browser tab (client-generated UUID in x-tab-id), not a user:
// the same user in two tabs gets one editable tab and one read-only tab. The lock lasts 60 s and is renewed by the
// client's heartbeat.

export const TAB_ID_HEADER = 'x-tab-id';

export interface LockState {
  holder: 'you' | 'other';
  expiresAt: Date | null;
}

// The x-tab-id header, required on mutating session endpoints. Missing or not a UUID -> HttpError 400.
export function readTabId(req: Request): string {
  const tabId = req.headers.get(TAB_ID_HEADER);
  if (!tabId || !isUuid(tabId)) throw new HttpError(400, 'Missing or invalid x-tab-id header', 'tab_id_required');
  return tabId.toLowerCase();
}

// Acquires the lock if it is free, expired or already held by this tab (renewing it); otherwise reports 'other'.
// A single conditional UPDATE, so concurrent tabs cannot both win. The read-back reports whoever holds it now.
export async function acquireOrRenewLock(sessionId: string, tabId: string): Promise<LockState> {
  await query(
    `UPDATE planning_session
        SET lock_holder = ?, lock_expires_at = now() + interval '60 seconds'
      WHERE id = ? AND (lock_holder IS NULL OR lock_holder = ? OR lock_expires_at < now())`,
    [tabId, sessionId, tabId],
  );
  const current = await query<{ lock_holder: string | null; lock_expires_at: Date | null }>(
    'SELECT lock_holder, lock_expires_at FROM planning_session WHERE id = ?',
    [sessionId],
  );
  if (!current[0]) throw new HttpError(404, 'Session not found', 'not_found');
  return { holder: current[0].lock_holder === tabId ? 'you' : 'other', expiresAt: current[0].lock_expires_at };
}

// Unconditionally moves the lock to this tab and audits session.lock_taken_over with the previous holder.
export async function takeOverLock(
  sessionId: string,
  tabId: string,
  actor: { user: CurrentUser; correlationId?: string | null },
): Promise<LockState> {
  return withTransaction(async (client) => {
    const previous = await client.query<{ lock_holder: string | null; ticket_keys: string[] }>(
      'SELECT lock_holder, ticket_keys FROM planning_session WHERE id = ? FOR UPDATE',
      [sessionId],
    );
    const row = previous.rows[0];
    if (!row) throw new HttpError(404, 'Session not found', 'not_found');
    await client.query(
      `UPDATE planning_session
          SET lock_holder = ?, lock_expires_at = now() + interval '60 seconds'
        WHERE id = ?`,
      [tabId, sessionId],
    );
    const updated = await client.query<{ lock_expires_at: Date }>(
      'SELECT lock_expires_at FROM planning_session WHERE id = ?',
      [sessionId],
    );
    await recordAudit(
      {
        action: 'session.lock_taken_over',
        result: 'success',
        userId: actor.user.accountId,
        userDisplayName: actor.user.displayName,
        sessionId,
        ticketIds: row.ticket_keys,
        details: { previousHolder: row.lock_holder, newHolder: tabId },
        correlationId: actor.correlationId ?? null,
      },
      client,
    );
    return { holder: 'you', expiresAt: updated.rows[0].lock_expires_at };
  });
}

// Throws HttpError 423 'session_locked' unless this tab currently holds an unexpired lock.
export async function requireLock(sessionId: string, tabId: string): Promise<void> {
  const rows = await query(
    'SELECT 1 FROM planning_session WHERE id = ? AND lock_holder = ? AND lock_expires_at > now()',
    [sessionId, tabId],
  );
  if (rows.length === 0) throw new HttpError(423, 'Session is being edited in another tab', 'session_locked');
}
