import { withApiHandler } from '@/server/http/handler';
import { requireSessionAccess } from '@/server/sessions/access';
import { refreshSources } from '@/server/sessions/ingestSources';
import { readTabId, requireLock } from '@/server/sessions/lock';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// Refetches all sources as the acting user; requires the session lock for the tab named by x-tab-id. No body.
// 409 not_ingested before the first ingest (GI-6): that is POST /ingest.
export const POST = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));
  const result = await refreshSources(ctx.user!, session.id);
  return Response.json(
    {
      added: result.added,
      removed: result.removed,
      changed: result.changed,
      messageSeq: result.messageSeq,
      retrievedAt: result.retrievedAt.toISOString(),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
