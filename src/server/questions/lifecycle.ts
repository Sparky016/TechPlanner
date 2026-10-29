import type { PoolClient } from 'pg';
import { z } from 'zod';
import { recordAudit } from '@/server/audit/audit';
import type { CurrentUser } from '@/server/auth/session';
import { withTransaction } from '@/server/db/pool';
import { HttpError } from '@/server/http/errors';

// Server-only: never import from src/lib or client components.
// The AI question lifecycle (GI-12, GI-14, GI-16, GI-17): open -> answered -> resolved, and back via reopen.
// Every transition locks the question row FOR UPDATE, writes and audits in one transaction.

/** Max answer length: the same as a facilitator message (GI-13). */
export const MAX_ANSWER_CHARS = 10_000;
/** Max resolve / dismiss reason length (GI-16). */
export const MAX_REASON_CHARS = 500;

const ReasonBody = z.object({ reason: z.string().optional() });

export type QuestionResolution = 'answered' | 'not_relevant';

export interface QuestionActionInput {
  sessionId: string;
  ticketKeys: string[];
  questionId: string;
  user: CurrentUser;
  correlationId?: string | null;
}

interface LockedQuestion {
  status: string;
  section: string | null;
  answer_text: string | null;
}

export function questionNotFound(): HttpError {
  return new HttpError(404, 'Question not found', 'question_not_found');
}

/** Legacy 'dismissed' rows (expand/contract, spec §7) count as resolved. */
const isResolved = (status: string): boolean => status === 'resolved' || status === 'dismissed';

async function lockQuestion(client: PoolClient, sessionId: string, questionId: string): Promise<LockedQuestion> {
  const { rows } = await client.query<LockedQuestion>(
    'SELECT status, section, answer_text FROM ai_question WHERE id = $1 AND session_id = $2 FOR UPDATE',
    [questionId, sessionId],
  );
  if (!rows[0]) throw questionNotFound();
  return rows[0];
}

async function audit(
  client: PoolClient,
  input: QuestionActionInput,
  action: 'question.answered' | 'question.resolved' | 'question.reopened',
  details: Record<string, unknown>,
): Promise<void> {
  await recordAudit(
    {
      action,
      result: 'success',
      userId: input.user.accountId,
      userDisplayName: input.user.displayName,
      sessionId: input.sessionId,
      ticketIds: input.ticketKeys,
      details: { questionId: input.questionId, ...details },
      correlationId: input.correlationId ?? null,
    },
    client,
  );
}

/**
 * GI-14: stores the facilitator's answer (answer_text, answered_at, answered_via 'facilitator', status 'answered'),
 * persists it as a facilitator conversation message carrying question_id, and audits question.answered. Allowed from
 * open and answered (a new answer replaces answer_text); resolved -> 409 question_resolved.
 */
export async function answerQuestion(
  input: QuestionActionInput & { text: string },
): Promise<{ id: string; status: 'answered'; messageSeq: number }> {
  return withTransaction(async (client) => {
    const question = await lockQuestion(client, input.sessionId, input.questionId);
    if (isResolved(question.status)) {
      throw new HttpError(409, 'Question is resolved; reopen it before answering', 'question_resolved');
    }
    await client.query(
      `UPDATE ai_question
          SET answer_text = $2, answered_at = now(), answered_via = 'facilitator', status = 'answered'
        WHERE id = $1`,
      [input.questionId, input.text],
    );
    // Serialises concurrent writers for this session while seq is computed (same pattern as runTurn).
    await client.query('SELECT 1 FROM planning_session WHERE id = $1 FOR UPDATE', [input.sessionId]);
    const { rows } = await client.query<{ seq: number }>(
      `INSERT INTO conversation_message (session_id, seq, role, content, question_id)
       VALUES ($1, (SELECT coalesce(max(seq), 0) + 1 FROM conversation_message WHERE session_id = $1), 'facilitator', $2, $3)
       RETURNING seq`,
      [input.sessionId, input.text, input.questionId],
    );
    await audit(client, input, 'question.answered', {
      section: question.section,
      answerLength: input.text.length,
      previousStatus: question.status,
    });
    return { id: input.questionId, status: 'answered', messageSeq: rows[0].seq };
  });
}

/**
 * GI-16: answered -> resolved/answered; open -> resolved/not_relevant (the reason is kept in dismiss_reason);
 * resolved -> 409 question_not_open. `fromOpenOnly` is the legacy /dismiss alias: an answered question is rejected too.
 * Audits question.resolved; the AI learns of it from the next turn's context (GI-21).
 */
export async function resolveQuestion(
  input: QuestionActionInput & { reason: string | null; fromOpenOnly?: boolean },
): Promise<{ id: string; status: 'resolved'; resolution: QuestionResolution; reason: string | null }> {
  return withTransaction(async (client) => {
    const question = await lockQuestion(client, input.sessionId, input.questionId);
    const allowed = question.status === 'open' || (question.status === 'answered' && !input.fromOpenOnly);
    if (!allowed) {
      throw new HttpError(409, `Question is already ${question.status}`, 'question_not_open');
    }
    const resolution: QuestionResolution = question.status === 'answered' ? 'answered' : 'not_relevant';
    await client.query(
      `UPDATE ai_question SET status = 'resolved', resolution = $2, resolved_at = now(), dismiss_reason = $3
        WHERE id = $1`,
      [input.questionId, resolution, input.reason],
    );
    await audit(client, input, 'question.resolved', { section: question.section, resolution, reason: input.reason });
    return { id: input.questionId, status: 'resolved', resolution, reason: input.reason };
  });
}

/**
 * GI-17: resolved -> answered when an answer is recorded, else open; clears the resolution, resolved_at and its
 * reason. Anything else -> 409 question_not_resolved. Audits question.reopened.
 */
export async function reopenQuestion(
  input: QuestionActionInput,
): Promise<{ id: string; status: 'open' | 'answered' }> {
  return withTransaction(async (client) => {
    const question = await lockQuestion(client, input.sessionId, input.questionId);
    if (!isResolved(question.status)) {
      throw new HttpError(409, `Question is ${question.status}, not resolved`, 'question_not_resolved');
    }
    const status = question.answer_text !== null ? 'answered' : 'open';
    await client.query(
      `UPDATE ai_question SET status = $2, resolution = NULL, resolved_at = NULL, dismiss_reason = NULL
        WHERE id = $1`,
      [input.questionId, status],
    );
    await audit(client, input, 'question.reopened', { section: question.section, status });
    return { id: input.questionId, status };
  });
}

/**
 * Reads the optional `{ reason?: string }` body of /resolve and /dismiss (an empty body is allowed). A blank reason
 * is null; over MAX_REASON_CHARS -> 413 body_too_large.
 */
export async function readReasonBody(req: Request): Promise<string | null> {
  const body = await req.text();
  let raw: unknown = {};
  if (body.trim() !== '') {
    try {
      raw = JSON.parse(body);
    } catch {
      throw new HttpError(400, 'Request body must be JSON', 'invalid_json');
    }
  }
  const parsed = ReasonBody.parse(raw);
  const reason = parsed.reason?.trim() ? parsed.reason : null;
  if (reason !== null && reason.length > MAX_REASON_CHARS) {
    throw new HttpError(413, `Reason exceeds ${MAX_REASON_CHARS} characters`, 'body_too_large');
  }
  return reason;
}
