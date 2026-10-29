import type { PoolClient } from 'pg';
import { AtlassianApiError } from '@/server/atlassian/client';
import { recordAudit } from '@/server/audit/audit';
import type { CurrentUser } from '@/server/auth/session';
import { ReauthRequiredError } from '@/server/auth/tokens';
import { withTransaction } from '@/server/db/pool';
import { HttpError } from '@/server/http/errors';
import { getCorrelationId } from '@/server/observability/context';
import { logger } from '@/server/observability/logger';
import { type PlanningSessionRow, getSessionById } from './repo';
import {
  type IngestStatus,
  type SourceKind,
  type SourceSnapshot,
  type SourceSnapshotInput,
  collectSources,
  fetchIssues,
  insertSnapshots,
  loadCurrentSnapshots,
} from './sources';

// Server-only: never import from src/lib or client components.
// Ingest (GI-4) and Refresh sources (SR-2.6) share one core (GI-5): refetch everything as the acting user, store a
// new snapshot batch and tell the AI about it through one 'system' conversation message. The first ingest is a
// refresh with an empty previous batch, posting a counts summary instead of an all-"added" diff.
// Access and lock checks are the caller's (route's) job.

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

// Shared core: every ticket and its linked sources, fetched as `user`. Tickets that became unreadable are recorded
// as unavailable jira_issue snapshots rather than failing the whole fetch.
async function collectBatch(user: CurrentUser, session: PlanningSessionRow): Promise<SourceSnapshotInput[]> {
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
  return [...unreadable, ...collected];
}

// Inside the caller's transaction, which must already hold the planning_session row lock (serialises seq).
async function appendSystemMessage(client: PoolClient, sessionId: string, content: string): Promise<number> {
  const seq = await client.query<{ seq: number }>(
    `INSERT INTO conversation_message (session_id, seq, role, content)
     VALUES ($1, (SELECT coalesce(max(seq), 0) + 1 FROM conversation_message WHERE session_id = $1), 'system', $2)
     RETURNING seq`,
    [sessionId, content],
  );
  return seq.rows[0].seq;
}

async function loadSession(sessionId: string): Promise<PlanningSessionRow> {
  const session = await getSessionById(sessionId);
  if (!session) throw new HttpError(404, 'Session not found', 'not_found');
  return session;
}

export async function refreshSources(user: CurrentUser, sessionId: string): Promise<RefreshResult> {
  const session = await loadSession(sessionId);
  // GI-6: the first batch comes from Ingest, which posts the summary message instead of a diff.
  if (!session.ingestedAt) throw new HttpError(409, 'Sources have not been ingested yet', 'not_ingested');

  const next = await collectBatch(user, session);
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
    return appendSystemMessage(client, session.id, buildMessage(retrievedAt, added, removed, changed));
  });

  return {
    added: added.map(change),
    removed: removed.map(change),
    changed: changed.map(({ after }) => change(after)),
    messageSeq,
    retrievedAt,
  };
}

export type IngestVia = 'ingest' | 'create';

export interface IngestCounts {
  counts: Record<SourceKind, number>;
  statuses: Record<IngestStatus, number>;
}

export interface IngestResult extends IngestCounts {
  ingestedAt: Date;
  // The batch just stored, as loadCurrentSnapshots returns it.
  sources: SourceSnapshot[];
  messageSeq: number;
}

export function countSources(snapshots: readonly SourceSnapshotInput[]): IngestCounts {
  const counts: Record<SourceKind, number> = { jira_issue: 0, confluence_page: 0, attachment: 0 };
  const statuses: Record<IngestStatus, number> = { ingested: 0, listed: 0, unavailable: 0, truncated: 0 };
  for (const s of snapshots) {
    counts[s.kind]++;
    statuses[s.ingestStatus]++;
  }
  return { counts, statuses };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// GI-4 summary message.
export function buildIngestMessage(ingestedAt: Date, { counts, statuses }: IngestCounts): string {
  return (
    `Sources ingested at ${ingestedAt.toISOString()}: ` +
    `${plural(counts.jira_issue, 'Jira issue', 'Jira issues')}, ` +
    `${plural(counts.confluence_page, 'Confluence page', 'Confluence pages')}, ` +
    `${plural(counts.attachment, 'attachment', 'attachments')} ` +
    `(${statuses.listed} listed only, ${statuses.unavailable} unavailable, ${statuses.truncated} truncated).`
  );
}

// The stable code and user-facing message an ingest failure is reported and audited with. Unexpected errors get a
// generic message, as withApiHandler renders them; the details stay in the logs.
export function describeIngestError(err: unknown): { code: string; message: string } {
  if (err instanceof HttpError) return { code: err.code ?? `http_${err.status}`, message: err.message };
  if (err instanceof AtlassianApiError || err instanceof ReauthRequiredError) {
    return { code: err.code, message: err.message };
  }
  return { code: 'internal_error', message: 'Unexpected error' };
}

const alreadyIngested = () =>
  new HttpError(409, 'Sources are already ingested; use Refresh sources', 'already_ingested');

// First ingestion (GI-4, GI-26). `via` records whether it came from the Ingest button or Create and ingest.
// A failure leaves ingested_at NULL and is audited; 404 and already_ingested are not ingest attempts.
export async function ingestSources(
  user: CurrentUser,
  sessionId: string,
  options: { via?: IngestVia; correlationId?: string | null } = {},
): Promise<IngestResult> {
  const session = await loadSession(sessionId);
  if (session.ingestedAt) throw alreadyIngested();
  const via = options.via ?? 'ingest';
  const correlationId = options.correlationId ?? getCorrelationId() ?? null;
  const audit = {
    userId: user.accountId,
    userDisplayName: user.displayName,
    sessionId: session.id,
    ticketIds: session.ticketKeys,
    correlationId,
  };

  let committed: { ingestedAt: Date; messageSeq: number; counts: IngestCounts };
  try {
    // Slow Atlassian calls stay outside the transaction.
    const next = await collectBatch(user, session);
    const ingestedAt = new Date();
    const counts = countSources(next);
    committed = await withTransaction(async (client) => {
      // Re-check under the row lock: a racing ingest may have committed while we fetched. Throwing rolls back.
      const locked = await client.query<{ ingested_at: Date | null }>(
        'SELECT ingested_at FROM planning_session WHERE id = $1 FOR UPDATE',
        [session.id],
      );
      if (locked.rows[0]?.ingested_at) throw alreadyIngested();
      await insertSnapshots(client, session.id, next, ingestedAt);
      await client.query('UPDATE planning_session SET ingested_at = $2 WHERE id = $1', [session.id, ingestedAt]);
      const messageSeq = await appendSystemMessage(client, session.id, buildIngestMessage(ingestedAt, counts));
      await recordAudit(
        { ...audit, action: 'sources.ingested', result: 'success', details: { ...counts, via } },
        client,
      );
      return { ingestedAt, messageSeq, counts };
    });
  } catch (err) {
    if (err instanceof HttpError && err.code === 'already_ingested') throw err;
    try {
      await recordAudit({
        ...audit,
        action: 'sources.ingested',
        result: 'failure',
        details: { via, errorCode: describeIngestError(err).code },
      });
    } catch (auditErr) {
      // The ingest error is what the caller must see.
      logger.error({ err: auditErr, sessionId: session.id }, 'Failed to record sources.ingested failure audit');
    }
    throw err;
  }

  return {
    ingestedAt: committed.ingestedAt,
    ...committed.counts,
    messageSeq: committed.messageSeq,
    sources: await loadCurrentSnapshots(session.id),
  };
}
