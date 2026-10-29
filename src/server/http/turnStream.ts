import type { CurrentUser } from '@/server/auth/session';
import { db } from '@/server/db/pool';
import type { FacilitatorEvent } from '@/server/facilitator/runTurn';
import { HttpError } from '@/server/http/errors';
import type { ApiContext } from '@/server/http/handler';
import { type SseEvent, sseResponse } from '@/server/http/sse';
import { logger } from '@/server/observability/logger';
import { observeLlmRequest } from '@/server/observability/metrics';
import { intakeState, mapSessionRow, type PlanningSessionDbRow, type PlanningSessionRow } from '@/server/sessions/repo';

// Server-only: never import from src/lib or client components.
// The shared SSE turn route (spec §8.1): every facilitator turn route (/messages, /analyze, /answer) streams through
// here, so they all hold the same per-session turn lock (GI-22) and map errors the same way.

export interface TurnRunContext {
  /** The session, re-read once the turn lock is held. */
  session: PlanningSessionRow;
  user: CurrentUser;
  correlationId: string;
  /** Aborts on client disconnect; the turn still runs to completion so its persistence finishes. */
  signal: AbortSignal;
}

export interface TurnStreamOptions {
  /**
   * Runs once the turn lock is held and the intake check passed, before the stream starts: route-specific
   * preconditions (e.g. 409 already_analyzed) and any write the turn needs first (an answer, task 46). Anything it
   * throws releases the lock and becomes an ordinary JSON error response.
   */
  prepare?: (session: PlanningSessionRow) => Promise<void>;
}

/**
 * Takes the session-level advisory turn lock on a dedicated pool connection (409 turn_in_progress when another
 * turn holds it), checks the session is ingested (409 not_ingested, GI-23), runs `prepare`, then streams `run` as SSE.
 * Facilitator events map one-to-one to SSE events; `error` events and unexpected failures carry the correlationId.
 * The lock is released when the turn ends, including after a client abort; it is held for the life of the stream.
 */
export async function turnStreamResponse<P>(
  ctx: ApiContext<P>,
  session: PlanningSessionRow,
  run: (turn: TurnRunContext) => AsyncIterable<FacilitatorEvent>,
  opts: TurnStreamOptions = {},
): Promise<Response> {
  const client = await db.connect();
  let released = false;
  // Idempotent. If unlocking fails the connection is destroyed, which drops its session-level lock.
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('turn:' || $1::text))", [session.id]);
      client.release();
    } catch (err) {
      logger.error({ err }, 'Failed to release turn lock; discarding connection');
      client.release(true);
    }
  };

  let current: PlanningSessionRow;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('turn:' || $1::text)) AS locked",
      [session.id],
    );
    if (!rows[0]?.locked) {
      released = true;
      client.release();
      throw new HttpError(409, 'A facilitator turn is already in progress for this session', 'turn_in_progress');
    }
    // Re-read under the lock (on the lock connection, so no second pool connection is held): analyzed_at only
    // changes inside a turn, so preconditions on it are race-free here.
    const fresh = await client.query<PlanningSessionDbRow>('SELECT * FROM planning_session WHERE id = $1', [session.id]);
    current = fresh.rows[0] ? mapSessionRow(fresh.rows[0]) : session;
    if (intakeState(current) === 'not_ingested') {
      throw new HttpError(409, 'Ingest the session sources before running an AI turn', 'not_ingested');
    }
    await opts.prepare?.(current);
  } catch (err) {
    await release();
    throw err;
  }

  const { correlationId } = ctx;
  const signal = ctx.req.signal;
  const user = ctx.user!;

  async function* events(): AsyncGenerator<SseEvent> {
    const started = performance.now();
    let firstToken = true;
    try {
      for await (const e of run({ session: current, user, correlationId, signal })) {
        if (e.type === 'token' && firstToken) {
          firstToken = false;
          observeLlmRequest('facilitator_first_token', (performance.now() - started) / 1000);
        }
        if (e.type === 'error') {
          yield { event: 'error', data: { code: e.code, message: e.message, correlationId } };
        } else {
          yield { event: e.type, data: e };
        }
      }
    } catch (err) {
      // The turn's opening message is persisted before the model runs, so it survives any failure here (NFR-8).
      logger.error({ err, sessionId: session.id }, 'Facilitator turn failed');
      yield { event: 'error', data: { code: 'internal_error', message: 'Unexpected error', correlationId } };
    } finally {
      await release();
    }
  }

  try {
    return sseResponse(events(), { signal });
  } catch (err) {
    await release();
    throw err;
  }
}
