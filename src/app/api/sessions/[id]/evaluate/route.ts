import { withApiHandler } from '@/server/http/handler';
import { HttpError } from '@/server/http/errors';
import { evaluateSession } from '@/server/readiness/evaluate';
import { requireSessionAccess } from '@/server/sessions/access';
import { WorkingCopyNotFoundError } from '@/server/spec/workingCopyRepo';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// Runs a readiness evaluation now (synchronously) and returns the EvaluationResult.
export const POST = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  try {
    const result = await evaluateSession(session.id, {
      userId: ctx.user!.accountId,
      userDisplayName: ctx.user!.displayName,
      correlationId: ctx.correlationId,
    });
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof WorkingCopyNotFoundError) throw new HttpError(404, 'Working copy not found', 'not_found');
    throw err;
  }
});
