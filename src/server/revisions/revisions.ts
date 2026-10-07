import { diffLines, type ChangeObject } from 'diff';
import type { PoolClient } from 'pg';
import { recordAudit } from '@/server/audit/audit';
import { query, withTransaction } from '@/server/db/pool';
import { SECTION_NAMES, type SectionName } from '../../lib/spec/sections';
import type { SpecSections } from '../../lib/spec/document';
import type { EditAuditActor } from '../spec/editAudit';
import { replaceAllSections, type WorkingCopySections } from '../spec/workingCopyRepo';

// Server-only: never import from src/lib or client components.
// Immutable Revisions (SR-11). A revision stores the section bodies only; rows are never updated or deleted here
// (the database allows only published false -> true, used by publish).

export type RevisionTrigger = 'save' | 'restore' | 'publish';

export interface CreateRevisionInput {
  sessionId: string;
  trigger: RevisionTrigger;
  authorId: string;
  published: boolean;
  restoredFrom?: number | null;
}

export interface RevisionListItem {
  number: number;
  createdAt: string;
  author: { accountId: string | null; displayName: string | null };
  trigger: RevisionTrigger;
  readinessScore: number | null;
  published: boolean;
}

export interface Revision extends RevisionListItem {
  sections: SpecSections;
  restoredFrom: number | null;
}

export interface SectionComparison {
  section: SectionName;
  changed: boolean;
  hunks: ChangeObject<string>[];
}

export class RevisionNotFoundError extends Error {
  constructor(
    readonly sessionId: string,
    readonly number: number,
  ) {
    super(`Revision ${number} not found for session ${sessionId}`);
    this.name = 'RevisionNotFoundError';
  }
}

/**
 * Snapshots the session's Working Copy as the next revision. Must run inside the caller's transaction: the
 * planning_session row lock serialises numbering, and the (session_id, number) primary key backs it up.
 */
export async function createRevision(client: PoolClient, input: CreateRevisionInput): Promise<{ number: number }> {
  await client.query('SELECT id FROM planning_session WHERE id = $1 FOR UPDATE', [input.sessionId]);
  const wc = await client.query<{ sections: WorkingCopySections }>(
    'SELECT sections FROM working_copy WHERE session_id = $1',
    [input.sessionId],
  );
  if (wc.rows.length === 0) throw new Error(`Working copy not found for session ${input.sessionId}`);
  const bodies = {} as SpecSections;
  for (const name of SECTION_NAMES) bodies[name] = wc.rows[0].sections[name]?.body ?? '';

  const score = await client.query<{ score: number }>(
    'SELECT score FROM evaluation WHERE session_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
    [input.sessionId],
  );
  const { rows } = await client.query<{ number: number }>(
    `INSERT INTO revision (session_id, number, sections, trigger, readiness_score, published, author_id, restored_from)
     SELECT $1, coalesce(max(number), 0) + 1, $2, $3, $4, $5, $6, $7 FROM revision WHERE session_id = $1
     RETURNING number`,
    [
      input.sessionId,
      JSON.stringify(bodies),
      input.trigger,
      score.rows[0]?.score ?? null,
      input.published,
      input.authorId,
      input.restoredFrom ?? null,
    ],
  );
  return { number: rows[0].number };
}

type RevisionRow = {
  number: number;
  sections: SpecSections;
  trigger: RevisionTrigger;
  readiness_score: number | null;
  published: boolean;
  author_id: string | null;
  author_name: string | null;
  restored_from: number | null;
  created_at: Date;
};

const REVISION_SELECT = `SELECT r.number, r.sections, r.trigger, r.readiness_score, r.published, r.author_id,
       u.display_name AS author_name, r.restored_from, r.created_at
  FROM revision r LEFT JOIN app_user u ON u.atlassian_account_id = r.author_id`;

function toListItem(row: RevisionRow): RevisionListItem {
  return {
    number: row.number,
    createdAt: row.created_at.toISOString(),
    author: { accountId: row.author_id, displayName: row.author_name },
    trigger: row.trigger,
    readinessScore: row.readiness_score,
    published: row.published,
  };
}

/** Revisions for a session, newest first (SR-11.2). */
export async function listRevisions(sessionId: string): Promise<RevisionListItem[]> {
  const rows = await query<RevisionRow>(`${REVISION_SELECT} WHERE r.session_id = $1 ORDER BY r.number DESC`, [
    sessionId,
  ]);
  return rows.map(toListItem);
}

export async function getRevision(sessionId: string, number: number): Promise<Revision | null> {
  const rows = await query<RevisionRow>(`${REVISION_SELECT} WHERE r.session_id = $1 AND r.number = $2`, [
    sessionId,
    number,
  ]);
  if (rows.length === 0) return null;
  return { ...toListItem(rows[0]), sections: rows[0].sections, restoredFrom: rows[0].restored_from };
}

/** Section-aligned diff between revisions a and b, in SECTION_NAMES order (SR-11.3). */
export async function compareRevisions(sessionId: string, a: number, b: number): Promise<SectionComparison[]> {
  const [ra, rb] = await Promise.all([getRevision(sessionId, a), getRevision(sessionId, b)]);
  if (!ra) throw new RevisionNotFoundError(sessionId, a);
  if (!rb) throw new RevisionNotFoundError(sessionId, b);
  return SECTION_NAMES.map((section) => {
    const before = ra.sections[section] ?? '';
    const after = rb.sections[section] ?? '';
    return { section, changed: before !== after, hunks: diffLines(before, after) };
  });
}

/**
 * Copies revision `number` into the Working Copy and records the result as a new revision (trigger 'restore').
 * Existing revisions are untouched (SR-11.4).
 */
export async function restoreRevision(
  sessionId: string,
  number: number,
  actor: EditAuditActor,
): Promise<{ number: number }> {
  const source = await getRevision(sessionId, number);
  if (!source) throw new RevisionNotFoundError(sessionId, number);
  await replaceAllSections(sessionId, source.sections);
  const created = await withTransaction(async (client) => {
    const rev = await createRevision(client, {
      sessionId,
      trigger: 'restore',
      authorId: actor.user.accountId,
      published: false,
      restoredFrom: number,
    });
    await recordAudit(
      {
        action: 'revision.restored',
        result: 'success',
        userId: actor.user.accountId,
        userDisplayName: actor.user.displayName,
        sessionId,
        ticketIds: actor.ticketIds,
        details: { from: number, newNumber: rev.number },
        correlationId: actor.correlationId ?? null,
      },
      client,
    );
    return rev;
  });
  return created;
}
