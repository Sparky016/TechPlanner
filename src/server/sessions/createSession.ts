import { recordAudit } from '@/server/audit/audit';
import { isValidIssueKey, type JiraIssueSnapshot } from '@/server/atlassian/jira';
import type { CurrentUser } from '@/server/auth/session';
import { query, withTransaction } from '@/server/db/pool';
import { initWorkingCopy } from '@/server/spec/workingCopyRepo';
import { type PlanningSessionDbRow, type PlanningSessionRow, mapSessionRow } from './repo';
import { collectSources, fetchIssues, insertSnapshots } from './sources';

// Server-only: never import from src/lib or client components.
// Creates a Planning Session from Jira keys (SR-2.1, SR-2.5–SR-2.8). Partial source failures never fail creation.

// The spec sets no maximum; 10 is the task's fallback.
export const MAX_TICKET_KEYS = 10;

export type CreateSessionResult =
  | { kind: 'created'; session: PlanningSessionRow }
  | { kind: 'invalid_keys'; invalidKeys: string[] }
  | { kind: 'unreadable'; unreadable: string[] }
  | { kind: 'duplicate'; existingSessionIds: string[] };

// Uppercases and de-duplicates keys, preserving first-seen order. The first key is the primary ticket (D-8).
export function normaliseTicketKeys(ticketKeys: readonly string[]): string[] {
  return [...new Set(ticketKeys.map((k) => k.trim().toUpperCase()))];
}

export async function createSession(
  user: CurrentUser,
  ticketKeys: readonly string[],
  options: { confirmDuplicate?: boolean; correlationId?: string | null } = {},
): Promise<CreateSessionResult> {
  const keys = normaliseTicketKeys(ticketKeys);
  const invalidKeys = keys.filter((k) => !isValidIssueKey(k));
  if (keys.length === 0 || keys.length > MAX_TICKET_KEYS || invalidKeys.length > 0) {
    return { kind: 'invalid_keys', invalidKeys };
  }

  const fetched = await fetchIssues(user.accountId, keys);
  const unreadable = fetched.filter((f) => f.issue === null).map((f) => f.key);
  if (unreadable.length > 0) return { kind: 'unreadable', unreadable };
  const issues = fetched.map((f) => f.issue).filter((i): i is JiraIssueSnapshot => i !== null);

  const primary = keys[0];
  if (!options.confirmDuplicate) {
    const existing = await query<{ id: string }>(
      'SELECT id FROM planning_session WHERE primary_ticket_key = $1 ORDER BY created_at, id',
      [primary],
    );
    if (existing.length > 0) return { kind: 'duplicate', existingSessionIds: existing.map((r) => r.id) };
  }

  const snapshots = await collectSources(user.accountId, issues);
  const retrievedAt = new Date();

  const session = await withTransaction(async (client) => {
    const inserted = await client.query<PlanningSessionDbRow>(
      `INSERT INTO planning_session (primary_ticket_key, ticket_keys, facilitator_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [primary, keys, user.accountId],
    );
    const row = mapSessionRow(inserted.rows[0]);
    await insertSnapshots(client, row.id, snapshots, retrievedAt);
    await initWorkingCopy(row.id, undefined, client);
    await recordAudit(
      {
        action: 'draft.created',
        result: 'success',
        userId: user.accountId,
        userDisplayName: user.displayName,
        sessionId: row.id,
        ticketIds: keys,
        details: { sourceCount: snapshots.length },
        correlationId: options.correlationId ?? null,
      },
      client,
    );
    return row;
  });
  return { kind: 'created', session };
}
