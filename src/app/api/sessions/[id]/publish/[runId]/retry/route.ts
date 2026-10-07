import { z } from 'zod';
import { withApiHandler } from '@/server/http/handler';
import { HttpError } from '@/server/http/errors';
import { retryRun } from '@/server/publish/orchestrator';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, requireLock } from '@/server/sessions/lock';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

const retryBody = z.object({
  confluenceAction: z.enum(['overwrite', 'cancel']).optional(),
});

// Retry failed steps (SR-13.3): re-runs the run's non-successful steps in the worker. 409 unless the run failed.
export const POST = withApiHandler<{ id: string; runId: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));
  const body = retryBody.parse((await ctx.req.json().catch(() => null)) ?? {});

  const result = await retryRun(
    session.id,
    ctx.params.runId,
    body.confluenceAction ? { confluenceAction: body.confluenceAction } : {},
  );
  if (result.kind === 'not_found') throw new HttpError(404, 'Publish run not found', 'not_found');
  if (result.kind === 'not_retryable') throw new HttpError(409, 'Only a failed publish run can be retried', 'run_not_failed');
  return Response.json({ runId: result.runId }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
});
