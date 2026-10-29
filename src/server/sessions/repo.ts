import { query } from '@/server/db/pool';

// Server-only: never import from src/lib or client components.

export type SessionStatus = 'draft' | 'published' | 'partially_published';

/** Guided intake state (GI-1), derived from ingestedAt / analyzedAt. */
export type IntakeState = 'not_ingested' | 'ingested' | 'analyzed';

export interface PlanningSessionRow {
  id: string;
  primaryTicketKey: string;
  ticketKeys: string[];
  facilitatorId: string | null;
  status: SessionStatus;
  clarificationEnded: boolean;
  confluencePageId: string | null;
  confluencePageVersion: number | null;
  lockHolder: string | null;
  lockExpiresAt: Date | null;
  /** Azure DevOps repository for code investigation (ADR-0016); null searches every allowed repository. */
  codeRepository: string | null;
  /** When the sources were first ingested (GI-4); null until then. */
  ingestedAt: Date | null;
  /** When the initial analysis turn succeeded (GI-10); null until then. */
  analyzedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlanningSessionDbRow {
  id: string;
  primary_ticket_key: string;
  ticket_keys: string[];
  facilitator_id: string | null;
  status: SessionStatus;
  clarification_ended: boolean;
  confluence_page_id: string | null;
  confluence_page_version: number | null;
  lock_holder: string | null;
  lock_expires_at: Date | null;
  code_repository: string | null;
  ingested_at: Date | null;
  analyzed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function mapSessionRow(row: PlanningSessionDbRow): PlanningSessionRow {
  return {
    id: row.id,
    primaryTicketKey: row.primary_ticket_key,
    ticketKeys: row.ticket_keys,
    facilitatorId: row.facilitator_id,
    status: row.status,
    clarificationEnded: row.clarification_ended,
    confluencePageId: row.confluence_page_id,
    confluencePageVersion: row.confluence_page_version,
    lockHolder: row.lock_holder,
    lockExpiresAt: row.lock_expires_at,
    codeRepository: row.code_repository ?? null,
    ingestedAt: row.ingested_at ?? null,
    analyzedAt: row.analyzed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GI-1: analyzed wins over ingested, so a session is never reported as needing ingest once analyzed.
export function intakeState(row: Pick<PlanningSessionRow, 'ingestedAt' | 'analyzedAt'>): IntakeState {
  if (row.analyzedAt) return 'analyzed';
  if (row.ingestedAt) return 'ingested';
  return 'not_ingested';
}

// Returns null for an unknown id, including one that is not a UUID (which Postgres would otherwise reject).
export async function getSessionById(id: string): Promise<PlanningSessionRow | null> {
  if (!isUuid(id)) return null;
  const rows = await query<PlanningSessionDbRow>('SELECT * FROM planning_session WHERE id = $1', [id]);
  return rows[0] ? mapSessionRow(rows[0]) : null;
}
