import { query } from '@/server/db/pool';
import { withApiHandler } from '@/server/http/handler';
import { requireSessionAccess } from '@/server/sessions/access';
import { loadCurrentSnapshots } from '@/server/sessions/sources';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

interface PublishRunRow {
  id: string;
  revision_number: number;
  status: string | null;
  created_at: Date;
  updated_at: Date;
}

// Session detail: the session row, its current sources (without content) and publish status.
// Any user who can read the primary ticket may open a session (D-12).
export const GET = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  const [sources, runs] = await Promise.all([
    loadCurrentSnapshots(session.id),
    query<PublishRunRow>(
      `SELECT id, revision_number, status, created_at, updated_at
         FROM publish_run WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [session.id],
    ),
  ]);
  const run = runs[0];

  return Response.json(
    {
      session: {
        id: session.id,
        primaryTicketKey: session.primaryTicketKey,
        ticketKeys: session.ticketKeys,
        facilitatorId: session.facilitatorId,
        status: session.status,
        clarificationEnded: session.clarificationEnded,
        confluencePageId: session.confluencePageId,
        confluencePageVersion: session.confluencePageVersion,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      },
      sources: sources.map((s) => {
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
      publish: {
        status: session.status,
        latestRun: run
          ? {
              id: run.id,
              revisionNumber: run.revision_number,
              status: run.status,
              createdAt: run.created_at.toISOString(),
              updatedAt: run.updated_at.toISOString(),
            }
          : null,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
