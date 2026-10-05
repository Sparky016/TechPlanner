import type { PoolClient } from 'pg';
import { query, withTransaction } from '@/server/db/pool';
import { SECTION_NAMES, type SectionName } from '../../lib/spec/sections';
import { emptySections, validateSections, type SpecSections } from '../../lib/spec/document';
import { applyPatchToBody, type SectionPatch } from './patch';

// Server-only: never import from src/lib or client components.

export type SectionState = {
  body: string;
  lastAiReadAt: string | null;
  lastUserEditAt: string | null;
};
export type WorkingCopySections = Record<SectionName, SectionState>;
export type WorkingCopy = {
  sessionId: string;
  sections: WorkingCopySections;
  version: number;
  updatedAt: Date;
};

export type AiPatchResult =
  { disposition: 'applied'; version: number } | { disposition: 'suggested'; suggestionId: string };

export class VersionConflictError extends Error {
  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`Working copy version conflict: expected ${expectedVersion}, actual ${actualVersion}`);
    this.name = 'VersionConflictError';
  }
}

export class WorkingCopyNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Working copy not found for session ${sessionId}`);
    this.name = 'WorkingCopyNotFoundError';
  }
}

export class SuggestionNotFoundError extends Error {
  constructor(readonly suggestionId: string) {
    super(`Suggestion not found: ${suggestionId}`);
    this.name = 'SuggestionNotFoundError';
  }
}

export class SuggestionNotPendingError extends Error {
  constructor(
    readonly suggestionId: string,
    readonly status: string,
  ) {
    super(`Suggestion ${suggestionId} is not pending (status: ${status})`);
    this.name = 'SuggestionNotPendingError';
  }
}

export class InvalidSectionsError extends Error {
  constructor(readonly errors: string[]) {
    super(`Invalid sections: ${errors.join('; ')}`);
    this.name = 'InvalidSectionsError';
  }
}

type WorkingCopyRow = {
  session_id: string;
  sections: WorkingCopySections;
  version: number;
  updated_at: Date;
};

function toWorkingCopy(row: WorkingCopyRow): WorkingCopy {
  return {
    sessionId: row.session_id,
    sections: row.sections,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function isSectionName(name: string): name is SectionName {
  return (SECTION_NAMES as readonly string[]).includes(name);
}

async function lockWorkingCopy(client: PoolClient, sessionId: string): Promise<WorkingCopy> {
  const { rows } = await client.query<WorkingCopyRow>(
    'SELECT session_id, sections, version, updated_at FROM working_copy WHERE session_id = $1 FOR UPDATE',
    [sessionId],
  );
  if (rows.length === 0) throw new WorkingCopyNotFoundError(sessionId);
  return toWorkingCopy(rows[0]);
}

async function writeSections(client: PoolClient, sessionId: string, sections: WorkingCopySections): Promise<number> {
  const { rows } = await client.query<{ version: number }>(
    'UPDATE working_copy SET sections = $2, version = version + 1, updated_at = now() WHERE session_id = $1 RETURNING version',
    [sessionId, JSON.stringify(sections)],
  );
  return rows[0].version;
}

/** Creates the working copy for a session (all sections empty unless initial bodies are given). */
export async function initWorkingCopy(sessionId: string, initial?: SpecSections): Promise<WorkingCopy> {
  const bodies = initial ?? emptySections();
  const sections = {} as WorkingCopySections;
  for (const name of SECTION_NAMES)
    sections[name] = {
      body: bodies[name],
      lastAiReadAt: null,
      lastUserEditAt: null,
    };
  const [row] = await query<WorkingCopyRow>(
    'INSERT INTO working_copy (session_id, sections) VALUES ($1, $2) RETURNING session_id, sections, version, updated_at',
    [sessionId, JSON.stringify(sections)],
  );
  return toWorkingCopy(row);
}

export async function getWorkingCopy(sessionId: string): Promise<WorkingCopy | null> {
  const rows = await query<WorkingCopyRow>(
    'SELECT session_id, sections, version, updated_at FROM working_copy WHERE session_id = $1',
    [sessionId],
  );
  return rows.length === 0 ? null : toWorkingCopy(rows[0]);
}

/** Facilitator edit with optimistic concurrency. Returns the new version. */
export async function updateSectionByUser(
  sessionId: string,
  section: SectionName,
  body: string,
  expectedVersion: number,
): Promise<number> {
  return withTransaction(async (client) => {
    const wc = await lockWorkingCopy(client, sessionId);
    if (wc.version !== expectedVersion) throw new VersionConflictError(expectedVersion, wc.version);
    const sections = {
      ...wc.sections,
      [section]: {
        ...wc.sections[section],
        body,
        lastUserEditAt: new Date().toISOString(),
      },
    };
    return writeSections(client, sessionId, sections);
  });
}

/** Records that the AI snapshotted the document at `at`. Metadata only: does not bump the version. */
export async function markAiRead(sessionId: string, at: Date): Promise<void> {
  await withTransaction(async (client) => {
    const wc = await lockWorkingCopy(client, sessionId);
    const iso = at.toISOString();
    const sections = {} as WorkingCopySections;
    for (const name of SECTION_NAMES) sections[name] = { ...wc.sections[name], lastAiReadAt: iso };
    await client.query('UPDATE working_copy SET sections = $2 WHERE session_id = $1', [
      sessionId,
      JSON.stringify(sections),
    ]);
  });
}

/**
 * D-5: the AI never overwrites a section the user edited after the AI last read it.
 * If lastUserEditAt > aiReadAt the patch becomes a pending suggestion; otherwise it is applied.
 */
export async function applyAiPatch(sessionId: string, patch: SectionPatch, aiReadAt: Date): Promise<AiPatchResult> {
  if (!isSectionName(patch.section)) throw new InvalidSectionsError([`Unknown section: ${patch.section}`]);
  return withTransaction(async (client) => {
    const wc = await lockWorkingCopy(client, sessionId);
    const current = wc.sections[patch.section];
    if (current.lastUserEditAt !== null && new Date(current.lastUserEditAt).getTime() > aiReadAt.getTime()) {
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO pending_suggestion (session_id, section, patch, status) VALUES ($1, $2, $3, 'pending') RETURNING id",
        [sessionId, patch.section, JSON.stringify(patch)],
      );
      return { disposition: 'suggested', suggestionId: rows[0].id };
    }
    const sections = {
      ...wc.sections,
      [patch.section]: {
        ...current,
        body: applyPatchToBody(current.body, patch),
      },
    };
    return {
      disposition: 'applied',
      version: await writeSections(client, sessionId, sections),
    };
  });
}

type SuggestionRow = {
  id: string;
  session_id: string;
  patch: SectionPatch;
  status: string;
};

async function lockPendingSuggestion(client: PoolClient, suggestionId: string): Promise<SuggestionRow> {
  const { rows } = await client.query<SuggestionRow>(
    'SELECT id, session_id, patch, status FROM pending_suggestion WHERE id = $1 FOR UPDATE',
    [suggestionId],
  );
  if (rows.length === 0) throw new SuggestionNotFoundError(suggestionId);
  if (rows[0].status !== 'pending') throw new SuggestionNotPendingError(suggestionId, rows[0].status);
  return rows[0];
}

/**
 * Facilitator accepts a suggestion; editedContent (if given) replaces the patch content.
 * The accepted content is a facilitator decision, so lastUserEditAt is set. Returns the new version.
 */
export async function acceptSuggestion(suggestionId: string, editedContent?: string): Promise<number> {
  return withTransaction(async (client) => {
    const suggestion = await lockPendingSuggestion(client, suggestionId);
    const patch: SectionPatch =
      editedContent === undefined ? suggestion.patch : { ...suggestion.patch, content: editedContent };
    const wc = await lockWorkingCopy(client, suggestion.session_id);
    const current = wc.sections[patch.section];
    const sections = {
      ...wc.sections,
      [patch.section]: {
        ...current,
        body: applyPatchToBody(current.body, patch),
        lastUserEditAt: new Date().toISOString(),
      },
    };
    const version = await writeSections(client, suggestion.session_id, sections);
    await client.query("UPDATE pending_suggestion SET status = 'accepted', decided_at = now() WHERE id = $1", [
      suggestionId,
    ]);
    return version;
  });
}

export async function rejectSuggestion(suggestionId: string): Promise<void> {
  await withTransaction(async (client) => {
    await lockPendingSuggestion(client, suggestionId);
    await client.query("UPDATE pending_suggestion SET status = 'rejected', decided_at = now() WHERE id = $1", [
      suggestionId,
    ]);
  });
}

/**
 * Replaces every section body (revision restore). Restoring is a facilitator action, so lastUserEditAt is set
 * on every section; lastAiReadAt is preserved. Returns the new version.
 */
export async function replaceAllSections(sessionId: string, sections: unknown): Promise<number> {
  const result = validateSections(sections);
  if (!result.ok) throw new InvalidSectionsError(result.errors);
  return withTransaction(async (client) => {
    const wc = await lockWorkingCopy(client, sessionId);
    const now = new Date().toISOString();
    const next = {} as WorkingCopySections;
    for (const name of SECTION_NAMES) {
      next[name] = {
        ...wc.sections[name],
        body: result.sections[name],
        lastUserEditAt: now,
      };
    }
    return writeSections(client, sessionId, next);
  });
}
