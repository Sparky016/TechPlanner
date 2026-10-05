import type { PoolClient } from 'pg';
import { recordAudit } from '@/server/audit/audit';
import type { CurrentUser } from '@/server/auth/session';
import { withTransaction } from '@/server/db/pool';
import { SECTION_NAMES, type SectionName } from '../../lib/spec/sections';
import type { WorkingCopySections } from './workingCopyRepo';

// Server-only: never import from src/lib or client components.
// Debounced edit auditing so keystroke-level autosave does not flood the audit log:
// - user.edit at most once per section per 30 s (SR-4.4), with a unified diff from the last audited body;
// - draft.updated at most once per session per 5 min (SR-10.3).
// Times come from the JS clock (not SQL now()) so the windows are testable with a fake clock.

export const USER_EDIT_WINDOW_MS = 30 * 1000;
export const DRAFT_UPDATED_WINDOW_MS = 5 * 60 * 1000;
const DIFF_CONTEXT_LINES = 3;

export interface EditAuditActor {
  user: CurrentUser;
  ticketIds: string[];
  correlationId?: string | null;
}

function toLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

function hunkRange(start: number, length: number): string {
  // Unified diff convention: an empty range is reported at the line before it.
  return `${length === 0 ? start : start + 1},${length}`;
}

// Minimal single-hunk unified diff (common prefix/suffix trimmed, up to 3 context lines). Returns '' when equal.
export function unifiedDiff(name: string, before: string, after: string): string {
  if (before === after) return '';
  const a = toLines(before);
  const b = toLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - DIFF_CONTEXT_LINES);
  const toA = Math.min(a.length, endA + DIFF_CONTEXT_LINES);
  const toB = endB + (toA - endA);
  const lines = [
    `--- ${name}`,
    `+++ ${name}`,
    `@@ -${hunkRange(from, toA - from)} +${hunkRange(from, toB - from)} @@`,
    ...a.slice(from, start).map((l) => ` ${l}`),
    ...a.slice(start, endA).map((l) => `-${l}`),
    ...b.slice(start, endB).map((l) => `+${l}`),
    ...a.slice(endA, toA).map((l) => ` ${l}`),
  ];
  return `${lines.join('\n')}\n`;
}

async function auditUserEdit(
  client: PoolClient,
  sessionId: string,
  section: string,
  baseline: string,
  body: string,
  actor: EditAuditActor,
  now: Date,
): Promise<void> {
  await recordAudit(
    {
      action: 'user.edit',
      result: 'success',
      userId: actor.user.accountId,
      userDisplayName: actor.user.displayName,
      sessionId,
      ticketIds: actor.ticketIds,
      details: { section, diff: unifiedDiff(section, baseline, body) },
      correlationId: actor.correlationId ?? null,
    },
    client,
  );
  await client.query(
    'UPDATE edit_audit_state SET baseline_body = $3, last_audit_at = $4 WHERE session_id = $1 AND section = $2',
    [sessionId, section, body, now],
  );
}

/**
 * Called after a facilitator section save. The first edit in a section opens a 30 s window with the previous body
 * as baseline and audits nothing; a later edit once the window has elapsed records user.edit (baseline -> new body)
 * and starts a new window. Returns true when a user.edit record was written.
 */
export async function recordSectionEdit(
  sessionId: string,
  section: SectionName,
  previousBody: string,
  newBody: string,
  actor: EditAuditActor,
): Promise<boolean> {
  const now = new Date();
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO edit_audit_state (session_id, section, baseline_body, last_audit_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (session_id, section) DO NOTHING`,
      [sessionId, section, previousBody, now],
    );
    const { rows } = await client.query<{ baseline_body: string; last_audit_at: Date }>(
      'SELECT baseline_body, last_audit_at FROM edit_audit_state WHERE session_id = $1 AND section = $2 FOR UPDATE',
      [sessionId, section],
    );
    const state = rows[0];
    if (now.getTime() - state.last_audit_at.getTime() < USER_EDIT_WINDOW_MS) return false;
    if (state.baseline_body === newBody) return false;
    await auditUserEdit(client, sessionId, section, state.baseline_body, newBody, actor, now);
    return true;
  });
}

/**
 * Writes the trailing user.edit for every section whose current body differs from its audit baseline, regardless
 * of the 30 s window. Revision save (task 20) and publish (task 27) call this. Returns the number of records written.
 */
export async function flushEditAudits(sessionId: string, actor: EditAuditActor): Promise<number> {
  const now = new Date();
  return withTransaction(async (client) => {
    const wc = await client.query<{ sections: WorkingCopySections }>(
      'SELECT sections FROM working_copy WHERE session_id = $1 FOR UPDATE',
      [sessionId],
    );
    if (wc.rows.length === 0) return 0;
    const sections = wc.rows[0].sections;
    const { rows } = await client.query<{ section: string; baseline_body: string }>(
      'SELECT section, baseline_body FROM edit_audit_state WHERE session_id = $1 ORDER BY section FOR UPDATE',
      [sessionId],
    );
    let written = 0;
    for (const row of rows) {
      if (!(SECTION_NAMES as readonly string[]).includes(row.section)) continue;
      const body = sections[row.section as SectionName]?.body ?? '';
      if (body === row.baseline_body) continue;
      await auditUserEdit(client, sessionId, row.section, row.baseline_body, body, actor, now);
      written++;
    }
    return written;
  });
}

/** Records draft.updated { version } unless one was recorded for this session within 5 minutes. */
export async function recordDraftUpdated(sessionId: string, version: number, actor: EditAuditActor): Promise<boolean> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - DRAFT_UPDATED_WINDOW_MS);
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE working_copy SET last_draft_updated_audit_at = $2
        WHERE session_id = $1 AND (last_draft_updated_audit_at IS NULL OR last_draft_updated_audit_at <= $3)
       RETURNING 1`,
      [sessionId, now, cutoff],
    );
    if (rows.length === 0) return false;
    await recordAudit(
      {
        action: 'draft.updated',
        result: 'success',
        userId: actor.user.accountId,
        userDisplayName: actor.user.displayName,
        sessionId,
        ticketIds: actor.ticketIds,
        details: { version },
        correlationId: actor.correlationId ?? null,
      },
      client,
    );
    return true;
  });
}
