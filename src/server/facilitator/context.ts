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
}

export interface SessionContext {
  sessionId: string;
  ticketKeys: string[];
  /** The current source batch (SR-2.6). */
  snapshots: SourceSnapshot[];
  /** Notes (SR-3.6): included as context, never treated as a reply. */
  notes: ConversationMessage[];
  /** Conversation history (facilitator, ai and system messages), oldest first. */
  messages: ConversationMessage[];
  workingCopy: WorkingCopy;
  /** Issues that are not resolved: open and accepted-risk. */
  issues: ContextIssue[];
  openQuestions: ContextQuestion[];
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
      "SELECT id, issue_id, section, text FROM ai_question WHERE session_id = $1 AND status = 'open' ORDER BY created_at, id",
      [sessionId],
    ),
  ]);

  const all = messageRows.map(
    (r): ConversationMessage => ({ seq: r.seq, role: r.role, content: r.content, createdAt: r.created_at }),
  );
  return {
    sessionId,
    ticketKeys: session.ticketKeys,
    snapshots,
    notes: all.filter((m) => m.role === 'note'),
    messages: all.filter((m) => m.role !== 'note'),
    workingCopy,
    issues,
    openQuestions: questionRows.map((q) => ({ id: q.id, issueId: q.issue_id, section: q.section, text: q.text })),
    gatePasses: gatePasses(issues),
    clarificationEnded: session.clarificationEnded,
  };
}
