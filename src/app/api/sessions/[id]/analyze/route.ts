import { runFacilitatorTurn } from '@/server/facilitator/runTurn';
import { HttpError } from '@/server/http/errors';
import { withApiHandler } from '@/server/http/handler';
import { turnStreamResponse } from '@/server/http/turnStream';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, requireLock } from '@/server/sessions/lock';

// Server-only route; streamed, never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Runs the initial analysis turn (GI-9, GI-10) and streams it as SSE, with the same events and turn lock as
// POST /messages. No body. 409 not_ingested before ingest, already_analyzed once an analysis has succeeded
// (use Discuss with AI), turn_in_progress while any turn runs.
export const POST = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));

  return turnStreamResponse(
    ctx,
    session,
    ({ user, correlationId, signal }) =>
      runFacilitatorTurn({ sessionId: session.id, user, turn: { kind: 'analysis' }, correlationId, signal }),
    {
      prepare: async (current) => {
        if (current.analyzedAt) {
          throw new HttpError(409, 'The initial analysis has already run; use Discuss with AI', 'already_analyzed');
        }
      },
    },
  );
});
