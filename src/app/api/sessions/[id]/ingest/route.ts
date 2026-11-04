import { withApiHandler } from '@/server/http/handler';
import { requireSessionAccess } from '@/server/sessions/access';
import { ingestSources } from '@/server/sessions/ingestSources';
import { readTabId, requireLock } from '@/server/sessions/lock';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// First ingestion of the session's sources as the acting user (GI-4); requires the session lock for the tab named
// by x-tab-id. No body. 409 already_ingested once ingested (use Refresh sources).
export const POST = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));
  const result = await ingestSources(ctx.user!, session.id, { via: 'ingest', correlationId: ctx.correlationId });
  return Response.json(
    {
      ingestedAt: result.ingestedAt.toISOString(),
      // Same shape as the sources in GET /api/sessions/:id.
      sources: result.sources.map((s) => {
        // Image data is model input only; the sources list never carries it.
        const detail = { ...s.detail };
        delete detail.base64;
        return {
          id: s.id,
          kind: s.kind,
          ref: s.ref,
          title: s.title,
          ingestStatus: s.ingestStatus,
          detail,
          retrievedAt: s.retrievedAt.toISOString(),
        };
      }),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
