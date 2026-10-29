import { z } from 'zod';
import { query } from '@/server/db/pool';
import { runFacilitatorTurn } from '@/server/facilitator/runTurn';
import { HttpError } from '@/server/http/errors';
import { withApiHandler } from '@/server/http/handler';
import { turnStreamResponse } from '@/server/http/turnStream';
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
  question_id: string | null;
  created_at: Date;
}

// Conversation history in order (role, content, createdAt, seq, and the question a message answers, if any).
export const GET = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  const rows = await query<MessageRow>(
    'SELECT seq, role, content, question_id, created_at FROM conversation_message WHERE session_id = $1 ORDER BY seq',
    [session.id],
  );
  const messages = rows.map((r) => ({
    seq: r.seq,
    role: r.role,
    content: r.content,
    questionId: r.question_id,
    createdAt: r.created_at,
  }));
  return Response.json({ messages }, { headers: { 'Cache-Control': 'no-store' } });
});

// Sends a facilitator message and streams the AI turn as SSE. One turn at a time per session (409 turn_in_progress)
// and only once the sources are ingested (409 not_ingested, GI-23); see turnStreamResponse.
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

  return turnStreamResponse(ctx, session, ({ user, correlationId, signal }) =>
    runFacilitatorTurn({ sessionId: session.id, user, turn: { kind: 'message', text }, correlationId, signal }),
  );
});
