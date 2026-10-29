import { withApiHandler } from '@/server/http/handler';
import { questionNotFound, readReasonBody, resolveQuestion } from '@/server/questions/lifecycle';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, requireLock } from '@/server/sessions/lock';
import { isUuid } from '@/server/sessions/repo';

// Server-only route; never cache.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Resolves an AI question (GI-16): answered -> resolution 'answered', open -> 'not_relevant' with an optional reason
// (max 500). 409 question_not_open when already resolved. No AI call. Response { id, status, resolution, reason }.
export const POST = withApiHandler<{ id: string; qid: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));

  const reason = await readReasonBody(ctx.req);
  const questionId = ctx.params.qid;
  if (!isUuid(questionId)) throw questionNotFound();

  const result = await resolveQuestion({
    sessionId: session.id,
    ticketKeys: session.ticketKeys,
    questionId,
    reason,
    user: ctx.user!,
    correlationId: ctx.correlationId,
  });
  return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
});
