import { recordAudit } from '@/server/audit/audit';
import type { CurrentUser } from '@/server/auth/session';
import { isAzureDevOpsEnabled } from '@/server/azureDevOps/client';
import { getConfig } from '@/server/config';
import { query, withTransaction } from '@/server/db/pool';
import { getLlmClient } from '@/server/llm';
import type { LlmMessage } from '@/server/llm/types';
import { scheduleEvaluation } from '@/server/readiness/schedule';
import { markAiRead } from '@/server/spec/workingCopyRepo';
import type { PoolClient } from 'pg';
import { loadSessionContext } from './context';
import { buildFacilitatorMessages, buildFacilitatorSystemPrompt, correctiveMessage, type PromptTurn } from './prompt';
import { createFacilitatorTools, createTurnState, type FacilitatorEvent, type FacilitatorTurnState } from './tools';

// Server-only: never import from src/lib or client components.
// One facilitation turn (FR-3/FR-4) of one of three kinds (spec §8.2). Callers guarantee one turn at a time per
// session (task 25, src/server/http/turnStream.ts).

export type { FacilitatorEvent } from './tools';

/**
 * - message: the facilitator's message, persisted by the runner (unchanged behaviour).
 * - analysis: the initial analysis (GI-10); the runner persists a system message and sets analyzed_at on success.
 * - answer: an answer to an AI question (GI-14). The route stores the answer and persists `text` as the facilitator
 *   message (with question_id) before the turn runs; the runner only adds ANSWER_TEXT for that question.
 */
export type TurnKind =
  | { kind: 'message'; text: string }
  | { kind: 'analysis' }
  | { kind: 'answer'; questionId: string; text: string };

export interface FacilitatorTurnInput {
  sessionId: string;
  user: CurrentUser;
  turn: TurnKind;
  correlationId?: string | null;
  signal?: AbortSignal;
}

type Role = 'facilitator' | 'ai' | 'system';

async function insertMessage(client: PoolClient, sessionId: string, role: Role, content: string): Promise<number> {
  // Serialises concurrent writers for this session while seq is computed (same pattern as refreshSources).
  await client.query('SELECT 1 FROM planning_session WHERE id = $1 FOR UPDATE', [sessionId]);
  const { rows } = await client.query<{ seq: number }>(
    `INSERT INTO conversation_message (session_id, seq, role, content)
     VALUES ($1, (SELECT coalesce(max(seq), 0) + 1 FROM conversation_message WHERE session_id = $1), $2, $3)
     RETURNING seq`,
    [sessionId, role, content],
  );
  return rows[0].seq;
}

interface RunOutcome {
  text: string;
  error?: { code: string; message: string };
}

async function* runModel(
  state: FacilitatorTurnState,
  system: string,
  messages: LlmMessage[],
  signal: AbortSignal | undefined,
): AsyncGenerator<FacilitatorEvent, RunOutcome> {
  let text = '';
  const events = getLlmClient().run({
    kind: 'facilitator',
    model: getConfig().FACILITATOR_MODEL,
    system,
    messages,
    tools: createFacilitatorTools(state),
    signal,
  });
  for await (const event of events) {
    // Tool handlers finish before their tool-call event is yielded, so their events are ready here.
    while (state.pending.length > 0) yield state.pending.shift() as FacilitatorEvent;
    if (event.type === 'text-delta') {
      text += event.text;
      yield { type: 'token', text: event.text };
    } else if (event.type === 'error') {
      return { text, error: { code: event.code, message: event.message } };
    } else if (event.type === 'done') {
      break;
    }
  }
  while (state.pending.length > 0) yield state.pending.shift() as FacilitatorEvent;
  return { text };
}

export class QuestionNotFoundError extends Error {
  constructor(readonly questionId: string) {
    super(`AI question not found: ${questionId}`);
    this.name = 'QuestionNotFoundError';
  }
}

// What the turn persists before the model runs, and the prompt's view of the turn.
async function startTurn(sessionId: string, user: CurrentUser, turn: TurnKind): Promise<PromptTurn> {
  if (turn.kind === 'message') {
    await withTransaction((client) => insertMessage(client, sessionId, 'facilitator', turn.text));
    return { kind: 'message' };
  }
  if (turn.kind === 'analysis') {
    const notice = `Initial analysis requested by ${user.displayName}.`;
    await withTransaction((client) => insertMessage(client, sessionId, 'system', notice));
    return { kind: 'analysis', maxQuestions: getConfig().ANALYSIS_MAX_QUESTIONS };
  }
  const [question] = await query<{ id: string; text: string }>(
    'SELECT id, text FROM ai_question WHERE id = $1 AND session_id = $2',
    [turn.questionId, sessionId],
  );
  if (!question) throw new QuestionNotFoundError(turn.questionId);
  return { kind: 'answer', question };
}

/**
 * Runs one turn: persists the turn's opening message (facilitator message, or the analysis system notice; an
 * answer's message is persisted by its route), streams the model's reply and tool effects, persists the AI message,
 * audits the turn once (ai.suggestion) and schedules a readiness evaluation when a patch was applied. A successful
 * analysis sets analyzed_at in the AI-message transaction. An LLM error ends the turn with an 'error' event; the
 * opening message stays persisted (NFR-8) and analyzed_at stays NULL.
 */
export async function* runFacilitatorTurn(input: FacilitatorTurnInput): AsyncGenerator<FacilitatorEvent> {
  const { sessionId, user, turn, signal } = input;
  const turnStart = new Date();
  const promptTurn = await startTurn(sessionId, user, turn);
  await markAiRead(sessionId, turnStart);

  const ctx = await loadSessionContext(sessionId);
  const state = createTurnState(sessionId, turnStart, ctx.clarificationEnded, {
    user,
    ticketKeys: ctx.ticketKeys,
    codeRepository: ctx.codeRepository,
    ...(promptTurn.kind === 'analysis' ? { maxQuestions: promptTurn.maxQuestions } : {}),
  });
  const system = buildFacilitatorSystemPrompt({
    gatePasses: ctx.gatePasses,
    clarificationEnded: ctx.clarificationEnded,
    codeInvestigation: isAzureDevOpsEnabled(),
    codeRepository: ctx.codeRepository,
    turn: promptTurn,
  });
  const messages = buildFacilitatorMessages(ctx, { supportsImages: getLlmClient().supportsImages });

  let outcome = yield* runModel(state, system, messages, signal);
  const texts = [outcome.text];
  // SR-3.2 (every kind): one corrective follow-up when the turn neither patched nor asked; its outcome is accepted.
  if (!outcome.error && !ctx.clarificationEnded && state.patches.length === 0 && state.questionIds.length === 0) {
    const followUp: LlmMessage[] = [
      ...messages,
      ...(outcome.text.trim() !== '' ? [{ role: 'assistant' as const, content: outcome.text }] : []),
      { role: 'user', content: correctiveMessage(turn.kind) },
    ];
    outcome = yield* runModel(state, system, followUp, signal);
    texts.push(outcome.text);
  }
  const fullText = texts.filter((t) => t !== '').join('\n\n');

  const messageSeq = await withTransaction(async (client) => {
    const seq = outcome.error ? null : await insertMessage(client, sessionId, 'ai', fullText);
    if (!outcome.error && turn.kind === 'analysis') {
      await client.query(
        'UPDATE planning_session SET analyzed_at = now(), updated_at = now() WHERE id = $1 AND analyzed_at IS NULL',
        [sessionId],
      );
    }
    await recordAudit(
      {
        action: 'ai.suggestion',
        result: outcome.error ? 'failure' : 'success',
        userId: user.accountId,
        userDisplayName: user.displayName,
        sessionId,
        ticketIds: ctx.ticketKeys,
        correlationId: input.correlationId ?? null,
        details: {
          turnKind: turn.kind,
          ...(turn.kind === 'answer' ? { questionId: turn.questionId } : {}),
          messageSeq: seq,
          patches: state.patches,
          questions: state.questionIds,
          ...(state.codeCalls > 0 ? { codeCalls: state.codeCalls, codeRepository: state.codeRepository } : {}),
          ...(state.ticketUpdates.length > 0 ? { ticketUpdates: state.ticketUpdates } : {}),
          model: getConfig().FACILITATOR_MODEL,
          clarificationEnded: ctx.clarificationEnded,
          ...(outcome.error ? { errorCode: outcome.error.code } : {}),
        },
      },
      client,
    );
    return seq;
  });

  if (state.patches.some((p) => p.disposition === 'applied')) await scheduleEvaluation(sessionId);

  if (outcome.error) yield { type: 'error', code: outcome.error.code, message: outcome.error.message };
  else yield { type: 'done', messageSeq: messageSeq as number };
}
