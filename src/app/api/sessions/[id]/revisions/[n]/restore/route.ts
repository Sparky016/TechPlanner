import { HttpError } from '@/server/http/errors';
import { withApiHandler } from '@/server/http/handler';
import { RevisionNotFoundError, restoreRevision } from '@/server/revisions/revisions';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, requireLock } from '@/server/sessions/lock';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// Restores revision n into the Working Copy and records it as a new revision. Existing revisions are unchanged.
export const POST = withApiHandler<{ id: string; n: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));

  const n = ctx.params.n;
  if (!/^\d+$/.test(n) || !Number.isSafeInteger(Number(n))) {
    throw new HttpError(404, 'Revision not found', 'revision_not_found');
  }
  try {
    const { number } = await restoreRevision(session.id, Number(n), {
      user: ctx.user!,
      ticketIds: session.ticketKeys,
      correlationId: ctx.correlationId,
    });
    return Response.json({ number, restoredFrom: Number(n) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof RevisionNotFoundError) throw new HttpError(404, 'Revision not found', 'revision_not_found');
    throw err;
  }
});
