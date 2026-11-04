import { withApiHandler } from '@/server/http/handler';
import { questionNotFound, readReasonBody, resolveQuestion } from '@/server/questions/lifecycle';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, requireLock } from '@/server/sessions/lock';
import { isUuid } from '@/server/sessions/repo';

// Server-only route; never cache.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Legacy alias of "resolve from open" (GI-16), kept for one release (expand/contract): an open question becomes
// resolved / not_relevant with the optional reason, audited as question.resolved. Anything not open -> 409
// question_not_open. Response { id, status: 'resolved', dismissReason, resolution }.
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
    fromOpenOnly: true,
    user: ctx.user!,
    correlationId: ctx.correlationId,
  });
  return Response.json(
    { id: result.id, status: result.status, dismissReason: result.reason, resolution: result.resolution },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
