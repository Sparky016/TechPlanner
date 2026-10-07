import { HttpError } from '@/server/http/errors';
import { withApiHandler } from '@/server/http/handler';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, takeOverLock } from '@/server/sessions/lock';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// Takes the session lock from whichever tab holds it (audited as session.lock_taken_over). No body.
export const POST = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  const tabId = readTabId(ctx.req);
  if (!ctx.user) throw new HttpError(401, 'Not authenticated', 'unauthenticated');
  const lock = await takeOverLock(session.id, tabId, { user: ctx.user, correlationId: ctx.correlationId });
  return Response.json(
    { holder: lock.holder, expiresAt: lock.expiresAt?.toISOString() ?? null },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
