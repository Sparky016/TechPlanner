import { query } from '@/server/db/pool';
import { getSessionById } from '@/server/sessions/repo';
import { loadCurrentSnapshots, type SourceSnapshot } from '@/server/sessions/sources';
import { getWorkingCopy, WorkingCopyNotFoundError, type WorkingCopy } from '@/server/spec/workingCopyRepo';
import type { SectionName } from '../../lib/spec/sections';
import { gatePasses } from '../../lib/readiness/rules';
import type { IssueSeverity } from '../../lib/readiness/types';

// Server-only: never import from src/lib or client components.
// Everything one facilitation turn needs (LLM-4: the app DB is the source of truth and is replayed every turn).

export type ConversationRole = 'facilitator' | 'ai' | 'note' | 'system';

export interface ConversationMessage {
  seq: number;
  role: ConversationRole;
  content: string;
  createdAt: Date;
}

export interface ContextIssue {
  id: string;
  severity: IssueSeverity;
  section: SectionName;
  description: string;
  status: 'open' | 'accepted-risk';
}

export interface ContextQuestion {
  id: string;
  issueId: string | null;
  section: SectionName | null;
  text: string;
  /** Legacy 'dismissed' rows are reported as resolved / not_relevant. */
  status: 'open' | 'answered' | 'resolved';
  answerText: string | null;
  answeredVia: 'facilitator' | 'ai' | null;
  resolution: 'answered' | 'not_relevant' | null;
  /** The resolve reason (stored in dismiss_reason). */
  reason: string | null;
}

export interface SessionContext {
  sessionId: string;
  ticketKeys: string[];
  /** Azure DevOps repository the facilitator picked for code investigation (ADR-0016), or null. */
  codeRepository: string | null;
  /** The current source batch (SR-2.6). */
  snapshots: SourceSnapshot[];
  /** Notes (SR-3.6): included as context, never treated as a reply. */
  notes: ConversationMessage[];
  /** Conversation history (facilitator, ai and system messages), oldest first. */
  messages: ConversationMessage[];
  workingCopy: WorkingCopy;
  /** Issues that are not resolved: open and accepted-risk. */
  issues: ContextIssue[];
  /** Every AI question, oldest first (GI-21): the prompt groups them into open, answered and resolved. */
  questions: ContextQuestion[];
  gatePasses: boolean;
  clarificationEnded: boolean;
}

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Planning session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

interface MessageRow {
  seq: number;
  role: ConversationRole;
  content: string;
  created_at: Date;
}

interface QuestionRow {
  id: string;
  issue_id: string | null;
  section: SectionName | null;
  text: string;
  status: 'open' | 'answered' | 'resolved' | 'dismissed';
  answer_text: string | null;
  answered_via: 'facilitator' | 'ai' | null;
  resolution: 'answered' | 'not_relevant' | null;
  dismiss_reason: string | null;
}

function mapQuestion(q: QuestionRow): ContextQuestion {
  const status = q.status === 'dismissed' ? 'resolved' : q.status;
  return {
    id: q.id,
    issueId: q.issue_id,
    section: q.section,
    text: q.text,
    status,
    answerText: q.answer_text,
    answeredVia: q.answered_via,
    resolution: status === 'resolved' ? (q.resolution ?? 'not_relevant') : q.resolution,
    reason: q.dismiss_reason,
  };
}

export async function loadSessionContext(sessionId: string): Promise<SessionContext> {
  const session = await getSessionById(sessionId);
  if (!session) throw new SessionNotFoundError(sessionId);
  const workingCopy = await getWorkingCopy(sessionId);
  if (!workingCopy) throw new WorkingCopyNotFoundError(sessionId);

  const [snapshots, messageRows, issues, questionRows] = await Promise.all([
    loadCurrentSnapshots(sessionId),
    query<MessageRow>(
      'SELECT seq, role, content, created_at FROM conversation_message WHERE session_id = $1 ORDER BY seq',
      [sessionId],
    ),
    query<ContextIssue>(
      `SELECT id, severity, section, description, status FROM issue
       WHERE session_id = $1 AND status <> 'resolved' ORDER BY created_at, id`,
      [sessionId],
    ),
    query<QuestionRow>(
      `SELECT id, issue_id, section, text, status, answer_text, answered_via, resolution, dismiss_reason
         FROM ai_question WHERE session_id = $1 ORDER BY created_at, id`,
      [sessionId],
    ),
  ]);

  const all = messageRows.map(
    (r): ConversationMessage => ({ seq: r.seq, role: r.role, content: r.content, createdAt: r.created_at }),
  );
  return {
    sessionId,
    ticketKeys: session.ticketKeys,
    codeRepository: session.codeRepository,
    snapshots,
    notes: all.filter((m) => m.role === 'note'),
    messages: all.filter((m) => m.role !== 'note'),
    workingCopy,
    issues,
    questions: questionRows.map(mapQuestion),
    gatePasses: gatePasses(issues),
    clarificationEnded: session.clarificationEnded,
  };
}
