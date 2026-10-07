import { recordAudit } from '@/server/audit/audit';
import type { CurrentUser } from '@/server/auth/session';
import { getConfig } from '@/server/config';
import { withTransaction } from '@/server/db/pool';
import { getLlmClient } from '@/server/llm';
import type { LlmMessage } from '@/server/llm/types';
import { scheduleEvaluation } from '@/server/readiness/schedule';
import { markAiRead } from '@/server/spec/workingCopyRepo';
import type { PoolClient } from 'pg';
import { loadSessionContext } from './context';
import { buildFacilitatorMessages, buildFacilitatorSystemPrompt, CORRECTIVE_MESSAGE } from './prompt';
import { createFacilitatorTools, createTurnState, type FacilitatorEvent, type FacilitatorTurnState } from './tools';

// Server-only: never import from src/lib or client components.
// One facilitation turn (FR-3/FR-4). Callers guarantee one turn at a time per session (task 25).

export type { FacilitatorEvent } from './tools';

export interface FacilitatorTurnInput {
  sessionId: string;
  user: CurrentUser;
  text: string;
  correlationId?: string | null;
  signal?: AbortSignal;
}

type Role = 'facilitator' | 'ai';

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

/**
 * Runs one turn: persists the facilitator message, streams the model's reply and tool effects, persists the AI
 * message, audits the turn once (ai.suggestion) and schedules a readiness evaluation when a patch was applied.
 * An LLM error ends the turn with an 'error' event; the facilitator message stays persisted (NFR-8).
 */
export async function* runFacilitatorTurn(input: FacilitatorTurnInput): AsyncGenerator<FacilitatorEvent> {
  const { sessionId, user, text, signal } = input;
  const turnStart = new Date();
  await withTransaction((client) => insertMessage(client, sessionId, 'facilitator', text));
  await markAiRead(sessionId, turnStart);

  const ctx = await loadSessionContext(sessionId);
  const state = createTurnState(sessionId, turnStart, ctx.clarificationEnded);
  const system = buildFacilitatorSystemPrompt({ gatePasses: ctx.gatePasses, clarificationEnded: ctx.clarificationEnded });
  const messages = buildFacilitatorMessages(ctx, { supportsImages: getLlmClient().supportsImages });

  let outcome = yield* runModel(state, system, messages, signal);
  const texts = [outcome.text];
  // SR-3.2: one corrective follow-up when the turn neither patched nor asked; its outcome is accepted as is.
  if (!outcome.error && !ctx.clarificationEnded && state.patches.length === 0 && state.questionIds.length === 0) {
    const followUp: LlmMessage[] = [
      ...messages,
      ...(outcome.text.trim() !== '' ? [{ role: 'assistant' as const, content: outcome.text }] : []),
      { role: 'user', content: CORRECTIVE_MESSAGE },
    ];
    outcome = yield* runModel(state, system, followUp, signal);
    texts.push(outcome.text);
  }
  const fullText = texts.filter((t) => t !== '').join('\n\n');

  const messageSeq = await withTransaction(async (client) => {
    const seq = outcome.error ? null : await insertMessage(client, sessionId, 'ai', fullText);
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
          messageSeq: seq,
          patches: state.patches,
          questions: state.questionIds,
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
