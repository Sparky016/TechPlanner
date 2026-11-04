import { withApiHandler } from '@/server/http/handler';
import { questionNotFound, reopenQuestion } from '@/server/questions/lifecycle';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, requireLock } from '@/server/sessions/lock';
import { isUuid } from '@/server/sessions/repo';

// Server-only route; never cache.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Reopens a resolved AI question (GI-17): back to 'answered' when it has an answer, else 'open'. No body.
// 409 question_not_resolved otherwise. Response { id, status }.
export const POST = withApiHandler<{ id: string; qid: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));

  const questionId = ctx.params.qid;
  if (!isUuid(questionId)) throw questionNotFound();

  const result = await reopenQuestion({
    sessionId: session.id,
    ticketKeys: session.ticketKeys,
    questionId,
    user: ctx.user!,
    correlationId: ctx.correlationId,
  });
  return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
});
