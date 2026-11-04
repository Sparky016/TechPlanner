import { z } from 'zod';
import { runFacilitatorTurn } from '@/server/facilitator/runTurn';
import { HttpError } from '@/server/http/errors';
import { withApiHandler } from '@/server/http/handler';
import { turnStreamResponse } from '@/server/http/turnStream';
import { answerQuestion, MAX_ANSWER_CHARS, questionNotFound } from '@/server/questions/lifecycle';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, requireLock } from '@/server/sessions/lock';
import { isUuid } from '@/server/sessions/repo';

// Server-only route; streamed, never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AnswerBody = z.object({ text: z.string().refine((s) => s.trim() !== '', 'Answer must not be empty') });

// Answers an AI question (GI-14) and streams the facilitator turn that works it into the spec, with the same events
// and turn lock as POST /messages. The answer is stored only once the turn lock is held and the session is ingested
// (turnStreamResponse prepare), so 409 turn_in_progress / not_ingested persist nothing; once stored it survives an
// LLM failure (NFR-8). 409 question_resolved for a resolved question; 413 body_too_large over 10 000 characters.
export const POST = withApiHandler<{ id: string; qid: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));

  const raw: unknown = await ctx.req.json().catch(() => {
    throw new HttpError(400, 'Request body must be JSON', 'invalid_json');
  });
  const { text } = AnswerBody.parse(raw);
  if (text.length > MAX_ANSWER_CHARS) {
    throw new HttpError(413, `Answer exceeds ${MAX_ANSWER_CHARS} characters`, 'body_too_large');
  }

  const questionId = ctx.params.qid;
  if (!isUuid(questionId)) throw questionNotFound();

  return turnStreamResponse(
    ctx,
    session,
    ({ user, correlationId, signal }) =>
      runFacilitatorTurn({ sessionId: session.id, user, turn: { kind: 'answer', questionId, text }, correlationId, signal }),
    {
      prepare: async (current) => {
        await answerQuestion({
          sessionId: current.id,
          ticketKeys: current.ticketKeys,
          questionId,
          text,
          user: ctx.user!,
          correlationId: ctx.correlationId,
        });
      },
    },
  );
});
