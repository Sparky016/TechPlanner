import type { CurrentUser } from '@/server/auth/session';
import { withTransaction } from '@/server/db/pool';
import { HttpError } from '@/server/http/errors';
import { getSessionById } from './repo';
import {
  type SourceSnapshotInput,
  collectSources,
  fetchIssues,
  insertSnapshots,
  loadCurrentSnapshots,
} from './sources';

// Server-only: never import from src/lib or client components.
// Refresh sources (SR-2.6): refetch everything, store a new snapshot batch and tell the AI what changed through
// one 'system' conversation message. Access and lock checks are the caller's (route's) job.

export const MAX_DIFF_CHARS = 4000;
const DIFF_CONTEXT_LINES = 3;

export interface SourceChange {
  kind: SourceSnapshotInput['kind'];
  ref: string;
  title: string | null;
}

export interface RefreshResult {
  added: SourceChange[];
  removed: SourceChange[];
  changed: SourceChange[];
  // seq of the appended system message, or null when nothing changed.
  messageSeq: number | null;
  retrievedAt: Date;
}

function keyOf(s: { kind: string; ref: string }): string {
  return `${s.kind}:${s.ref}`;
}

function change(s: SourceSnapshotInput): SourceChange {
  return { kind: s.kind, ref: s.ref, title: s.title };
}

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

// A single-hunk unified diff: common leading/trailing lines are trimmed to DIFF_CONTEXT_LINES of context and the
// differing middle is shown as removed/added lines. Capped at `maxChars`.
export function unifiedDiffExcerpt(oldText: string, newText: string, maxChars = MAX_DIFF_CHARS): string {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const start = Math.max(0, prefix - DIFF_CONTEXT_LINES);
  const aEnd = a.length - suffix;
  const bEnd = b.length - suffix;
  const after = Math.min(suffix, DIFF_CONTEXT_LINES);
  const header = `@@ -${start + 1},${aEnd + after - start} +${start + 1},${bEnd + after - start} @@`;
  const lines = [
    header,
    ...a.slice(start, prefix).map((l) => ` ${l}`),
    ...a.slice(prefix, aEnd).map((l) => `-${l}`),
    ...b.slice(prefix, bEnd).map((l) => `+${l}`),
    ...a.slice(aEnd, aEnd + after).map((l) => ` ${l}`),
  ];
  const diff = lines.join('\n');
  if (diff.length <= maxChars) return diff;
  // The whole excerpt, marker included, must stay within maxChars.
  const marker = '\n… (diff truncated)';
  return `${diff.slice(0, Math.max(0, maxChars - marker.length))}${marker}`.slice(0, maxChars);
}

function describe(c: SourceChange): string {
  return c.title && c.title !== c.ref ? `${c.kind} ${c.ref} (${c.title})` : `${c.kind} ${c.ref}`;
}

function buildMessage(
  retrievedAt: Date,
  added: SourceSnapshotInput[],
  removed: SourceSnapshotInput[],
  changed: { before: SourceSnapshotInput; after: SourceSnapshotInput }[],
): string {
  const parts = [`Sources were refreshed at ${retrievedAt.toISOString()}.`];
  if (added.length > 0) parts.push('', 'Added sources:', ...added.map((s) => `- ${describe(change(s))}`));
  if (removed.length > 0) parts.push('', 'Removed sources:', ...removed.map((s) => `- ${describe(change(s))}`));
  if (changed.length > 0) {
    parts.push('', 'Changed sources:', ...changed.map(({ after }) => `- ${describe(change(after))}`));
    for (const { before, after } of changed) {
      parts.push(
        '',
        `Diff for ${describe(change(after))}` +
          (before.ingestStatus !== after.ingestStatus
            ? ` (status ${before.ingestStatus} -> ${after.ingestStatus})`
            : '') +
          ':',
        '```diff',
        unifiedDiffExcerpt(before.contentText ?? '', after.contentText ?? ''),
        '```',
      );
    }
  }
  return parts.join('\n');
}

export async function refreshSources(user: CurrentUser, sessionId: string): Promise<RefreshResult> {
  const session = await getSessionById(sessionId);
  if (!session) throw new HttpError(404, 'Session not found', 'not_found');

  // Tickets that became unreadable are recorded as unavailable rather than failing the refresh.
  const fetched = await fetchIssues(user.accountId, session.ticketKeys);
  const issues = fetched.flatMap((f) => (f.issue ? [f.issue] : []));
  const collected = await collectSources(user.accountId, issues);
  const unreadable = fetched.flatMap((f): SourceSnapshotInput[] =>
    f.issue
      ? []
      : [
          {
            kind: 'jira_issue',
            ref: f.key,
            title: f.key,
            contentText: null,
            ingestStatus: 'unavailable',
            detail: { reason: f.error.code, message: f.error.message },
          },
        ],
  );
  const next = [...unreadable, ...collected];
  const previous = await loadCurrentSnapshots(session.id);

  const previousByKey = new Map(previous.map((s) => [keyOf(s), s]));
  const nextKeys = new Set(next.map(keyOf));
  const added = next.filter((s) => !previousByKey.has(keyOf(s)));
  const removed = previous.filter((s) => !nextKeys.has(keyOf(s)));
  const changed = next.flatMap((after) => {
    const before = previousByKey.get(keyOf(after));
    return before && (before.contentText ?? '') !== (after.contentText ?? '') ? [{ before, after }] : [];
  });
  const retrievedAt = new Date();

  const messageSeq = await withTransaction(async (client) => {
    // Serialises concurrent refreshes/messages for this session while seq is computed.
    await client.query('SELECT 1 FROM planning_session WHERE id = $1 FOR UPDATE', [session.id]);
    await insertSnapshots(client, session.id, next, retrievedAt);
    if (added.length === 0 && removed.length === 0 && changed.length === 0) return null;
    const seq = await client.query<{ seq: number }>(
      `INSERT INTO conversation_message (session_id, seq, role, content)
       VALUES ($1, (SELECT coalesce(max(seq), 0) + 1 FROM conversation_message WHERE session_id = $1), 'system', $2)
       RETURNING seq`,
      [session.id, buildMessage(retrievedAt, added, removed, changed)],
    );
    return seq.rows[0].seq;
  });

  return {
    added: added.map(change),
    removed: removed.map(change),
    changed: changed.map(({ after }) => change(after)),
    messageSeq,
    retrievedAt,
  };
}
