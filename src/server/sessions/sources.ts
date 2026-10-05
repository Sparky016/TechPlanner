import type { PoolClient } from 'pg';
import { AtlassianApiError } from '@/server/atlassian/client';
import { discoverConfluencePageRefs, getPageMarkdown } from '@/server/atlassian/confluence';
import { getIssueSnapshot, type JiraIssueSnapshot } from '@/server/atlassian/jira';
import { getConfig } from '@/server/config';
import { query } from '@/server/db/pool';
import { ingestAttachments, type AttachmentMeta } from '@/server/ingest/attachments';
import { applyContextBudget, type BudgetItem } from '@/server/ingest/budget';
import { getLlmClient } from '@/server/llm';

// Server-only: never import from src/lib or client components.
// Gathers a session's source material (SR-2.2–SR-2.5) and persists/loads source_snapshot rows (SR-2.6).
// Every snapshot written by one create or refresh shares one retrieved_at, so the latest batch is the current
// source set. A failure for one page or attachment never fails the whole fetch (§8 Error handling).

export type SourceKind = 'jira_issue' | 'confluence_page' | 'attachment';
export type IngestStatus = 'ingested' | 'listed' | 'unavailable' | 'truncated';

export interface SourceSnapshotInput {
  kind: SourceKind;
  ref: string;
  title: string | null;
  contentText: string | null;
  ingestStatus: IngestStatus;
  detail: Record<string, unknown>;
}

export interface SourceSnapshot extends SourceSnapshotInput {
  id: string;
  retrievedAt: Date;
}

interface SourceSnapshotRow {
  id: string;
  kind: SourceKind;
  ref: string;
  title: string | null;
  content_text: string | null;
  ingest_status: IngestStatus;
  detail: Record<string, unknown>;
  retrieved_at: Date;
}

// Bounded concurrency for Atlassian fetches (NFR-3).
const FETCH_CONCURRENCY = 5;

// Runs `fn` over `items` with at most `limit` calls in flight; results keep input order.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export type IssueFetchResult =
  { key: string; issue: JiraIssueSnapshot } | { key: string; issue: null; error: AtlassianApiError };

// Fetches every ticket as `userId`. Jira 403/404 is returned as a per-key error; anything else propagates.
export async function fetchIssues(userId: string, keys: readonly string[]): Promise<IssueFetchResult[]> {
  return mapWithConcurrency(keys, FETCH_CONCURRENCY, async (key): Promise<IssueFetchResult> => {
    try {
      return { key, issue: await getIssueSnapshot(userId, key) };
    } catch (err) {
      if (err instanceof AtlassianApiError && (err.status === 403 || err.status === 404)) {
        return { key, issue: null, error: err };
      }
      throw err;
    }
  });
}

function line(label: string, value: string | null | undefined): string | null {
  return value ? `${label}: ${value}` : null;
}

function list(label: string, values: string[]): string | null {
  return values.length > 0 ? `${label}: ${values.join(', ')}` : null;
}

// Ticket fields and description, without comments (comments are budgeted separately).
function issueCoreText(issue: JiraIssueSnapshot): string {
  const parts = [
    `${issue.key}: ${issue.summary}`,
    line('URL', issue.url),
    line('Type', issue.issueType),
    line('Status', issue.status),
    line('Priority', issue.priority),
    line('Assignee', issue.assignee),
    line('Reporter', issue.reporter),
    list('Labels', issue.labels),
    list('Components', issue.components),
    list('Fix versions', issue.fixVersions),
    issue.parent ? `Parent: ${issue.parent.key} ${issue.parent.summary}` : null,
    list(
      'Issue links',
      issue.issueLinks.map((l) => `${l.type} ${l.key} ${l.summary}`.trim()),
    ),
    list(
      'Remote links',
      issue.remoteLinks.map((l) => (l.title ? `${l.title} <${l.url}>` : l.url)),
    ),
    list(
      'Attachments',
      issue.attachments.map((a) => `${a.filename} (${a.mimeType || 'unknown type'}, ${a.size} bytes)`),
    ),
    '',
    'Description:',
    issue.descriptionText,
  ];
  return parts.filter((p): p is string => p !== null).join('\n');
}

function commentText(comment: JiraIssueSnapshot['comments'][number]): string {
  return `[${comment.created}] ${comment.author ?? 'Unknown'}: ${comment.bodyText}`;
}

function describeFailure(err: unknown): { reason: string; message: string } {
  if (err instanceof AtlassianApiError) return { reason: err.code, message: err.message };
  return { reason: 'error', message: err instanceof Error ? err.message : 'unknown error' };
}

// Discovers and fetches everything linked from `issues` and returns the snapshot rows to store, with the context
// budget (CONTEXT_TOKEN_BUDGET) applied: budget-dropped pages/attachments are 'truncated', dropped comments are
// listed in the issue's detail.truncatedComments.
export async function collectSources(userId: string, issues: JiraIssueSnapshot[]): Promise<SourceSnapshotInput[]> {
  // Confluence pages linked from any ticket, de-duplicated across tickets.
  const pageRefs = new Map<string, ReturnType<typeof discoverConfluencePageRefs>[number]>();
  for (const issue of issues) {
    for (const ref of discoverConfluencePageRefs(issue)) {
      const id = ref.pageId ?? ref.url;
      if (!pageRefs.has(id)) pageRefs.set(id, ref);
    }
  }
  const pageSnapshots = await mapWithConcurrency(
    [...pageRefs.values()],
    FETCH_CONCURRENCY,
    async (ref): Promise<SourceSnapshotInput> => {
      if (ref.pageId === null) {
        return {
          kind: 'confluence_page',
          ref: ref.url,
          title: ref.url,
          contentText: null,
          ingestStatus: 'unavailable',
          detail: { url: ref.url, reason: ref.reason },
        };
      }
      try {
        const page = await getPageMarkdown(userId, ref.pageId);
        return {
          kind: 'confluence_page',
          ref: ref.pageId,
          title: page.title,
          contentText: page.markdown,
          ingestStatus: 'ingested',
          detail: { url: page.url, version: page.version },
        };
      } catch (err) {
        if (!(err instanceof AtlassianApiError)) throw err;
        return {
          kind: 'confluence_page',
          ref: ref.pageId,
          title: ref.url,
          contentText: null,
          ingestStatus: 'unavailable',
          detail: { url: ref.url, ...describeFailure(err) },
        };
      }
    },
  );

  // Attachments of all tickets, de-duplicated by id; the 20-attachment cap applies per session.
  const attachments = new Map<string, AttachmentMeta>();
  for (const issue of issues) for (const a of issue.attachments) if (!attachments.has(a.id)) attachments.set(a.id, a);
  const ingest = await ingestAttachments(userId, [...attachments.values()], getLlmClient().supportsImages);
  const attachmentSnapshots: SourceSnapshotInput[] = [
    ...ingest.ingested.map((a): SourceSnapshotInput => ({
      kind: 'attachment',
      ref: a.id,
      title: a.filename,
      contentText: a.kind === 'text' ? a.text : null,
      ingestStatus: 'ingested',
      detail:
        a.kind === 'text'
          ? { mimeType: a.mimeType, size: a.size }
          : { mimeType: a.mimeType, size: a.size, image: true, base64: a.base64 },
    })),
    ...ingest.listed.map((a): SourceSnapshotInput => ({
      kind: 'attachment',
      ref: a.id,
      title: a.filename,
      contentText: null,
      ingestStatus: a.reason === 'unavailable' ? 'unavailable' : 'listed',
      detail: { mimeType: a.mimeType, size: a.size, reason: a.reason, ...(a.detail ? { message: a.detail } : {}) },
    })),
  ];

  // Context budget over ticket cores, comments, ingested pages and ingested attachments.
  const budgetItems: BudgetItem[] = [];
  for (const issue of issues) {
    budgetItems.push({ kind: 'ticket_core', ref: issue.key, text: issueCoreText(issue) });
    for (const c of issue.comments) {
      budgetItems.push({ kind: 'comment', ref: `${issue.key}#${c.id}`, text: commentText(c), created: c.created });
    }
  }
  for (const s of pageSnapshots) {
    if (s.ingestStatus === 'ingested')
      budgetItems.push({ kind: 'confluence_page', ref: s.ref, text: s.contentText ?? '' });
  }
  for (const s of attachmentSnapshots) {
    if (s.ingestStatus === 'ingested') {
      budgetItems.push({ kind: 'attachment', ref: s.ref, text: s.contentText ?? '', isImage: s.detail.image === true });
    }
  }
  const { truncated } = applyContextBudget(budgetItems, getConfig().CONTEXT_TOKEN_BUDGET);
  const dropped = new Set(truncated.map((t) => `${t.kind}:${t.ref}`));

  const issueSnapshots = issues.map((issue): SourceSnapshotInput => {
    const kept = issue.comments.filter((c) => !dropped.has(`comment:${issue.key}#${c.id}`));
    const truncatedComments = issue.comments
      .filter((c) => dropped.has(`comment:${issue.key}#${c.id}`))
      .map((c) => c.id);
    const text = [issueCoreText(issue), ...(kept.length > 0 ? ['', 'Comments:', ...kept.map(commentText)] : [])];
    return {
      kind: 'jira_issue',
      ref: issue.key,
      title: issue.summary,
      contentText: text.join('\n'),
      ingestStatus: 'ingested',
      detail: { url: issue.url, ...(truncatedComments.length > 0 ? { truncatedComments } : {}) },
    };
  });

  const markTruncated = (s: SourceSnapshotInput, budgetKind: 'confluence_page' | 'attachment'): SourceSnapshotInput => {
    if (s.ingestStatus !== 'ingested' || !dropped.has(`${budgetKind}:${s.ref}`)) return s;
    const detail = { ...s.detail };
    delete detail.base64;
    return { ...s, contentText: null, ingestStatus: 'truncated', detail: { ...detail, reason: 'context_budget' } };
  };

  return [
    ...issueSnapshots,
    ...pageSnapshots.map((s) => markTruncated(s, 'confluence_page')),
    ...attachmentSnapshots.map((s) => markTruncated(s, 'attachment')),
  ];
}

export async function insertSnapshots(
  client: PoolClient,
  sessionId: string,
  snapshots: SourceSnapshotInput[],
  retrievedAt: Date,
): Promise<void> {
  for (const s of snapshots) {
    await client.query(
      `INSERT INTO source_snapshot (session_id, kind, ref, title, content_text, ingest_status, detail, retrieved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [sessionId, s.kind, s.ref, s.title, s.contentText, s.ingestStatus, JSON.stringify(s.detail), retrievedAt],
    );
  }
}

function mapSnapshotRow(row: SourceSnapshotRow): SourceSnapshot {
  return {
    id: row.id,
    kind: row.kind,
    ref: row.ref,
    title: row.title,
    contentText: row.content_text,
    ingestStatus: row.ingest_status,
    detail: row.detail,
    retrievedAt: row.retrieved_at,
  };
}

// The session's current sources: the most recently retrieved batch, in insertion order.
export async function loadCurrentSnapshots(sessionId: string): Promise<SourceSnapshot[]> {
  const rows = await query<SourceSnapshotRow>(
    `SELECT id, kind, ref, title, content_text, ingest_status, detail, retrieved_at
       FROM source_snapshot
      WHERE session_id = $1
        AND retrieved_at = (SELECT max(retrieved_at) FROM source_snapshot WHERE session_id = $1)
      ORDER BY id`,
    [sessionId],
  );
  return rows.map(mapSnapshotRow);
}
