import { withApiHandler } from '@/server/http/handler';
import { requireSessionAccess } from '@/server/sessions/access';
import { acquireOrRenewLock, readTabId } from '@/server/sessions/lock';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// Acquires or renews the session lock for the tab named by x-tab-id. No body.
export const POST = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  const tabId = readTabId(ctx.req);
  const lock = await acquireOrRenewLock(session.id, tabId);
  return Response.json(
    { holder: lock.holder, expiresAt: lock.expiresAt?.toISOString() ?? null },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
