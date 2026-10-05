import { z } from 'zod';
import { db, query } from '@/server/db/pool';
import { runFacilitatorTurn } from '@/server/facilitator/runTurn';
import { HttpError } from '@/server/http/errors';
import { withApiHandler } from '@/server/http/handler';
import { type SseEvent, sseResponse } from '@/server/http/sse';
import { logger } from '@/server/observability/logger';
import { observeLlmRequest } from '@/server/observability/metrics';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, requireLock } from '@/server/sessions/lock';

// Server-only route; streamed, never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_MESSAGE_CHARS = 10_000;

const MessageBody = z.object({ text: z.string().refine((s) => s.trim() !== '', 'Message must not be empty') });

interface MessageRow {
  seq: number;
  role: string;
  content: string;
  created_at: Date;
}

// Conversation history in order (role, content, createdAt, seq).
export const GET = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  const rows = await query<MessageRow>(
    'SELECT seq, role, content, created_at FROM conversation_message WHERE session_id = $1 ORDER BY seq',
    [session.id],
  );
  const messages = rows.map((r) => ({ seq: r.seq, role: r.role, content: r.content, createdAt: r.created_at }));
  return Response.json({ messages }, { headers: { 'Cache-Control': 'no-store' } });
});

// Sends a facilitator message and streams the AI turn as SSE. One turn at a time per session (409 turn_in_progress),
// enforced by a session-level advisory lock held on a dedicated connection for the life of the stream.
export const POST = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));

  const raw: unknown = await ctx.req.json().catch(() => {
    throw new HttpError(400, 'Request body must be JSON', 'invalid_json');
  });
  const { text } = MessageBody.parse(raw);
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new HttpError(413, `Message exceeds ${MAX_MESSAGE_CHARS} characters`, 'body_too_large');
  }

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
      for await (const e of runFacilitatorTurn({ sessionId: session.id, user, text, correlationId, signal })) {
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
      // The facilitator message is persisted before the model runs, so it survives any failure here (NFR-8).
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
});
