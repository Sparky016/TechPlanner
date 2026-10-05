import { withApiHandler } from '@/server/http/handler';
import { HttpError } from '@/server/http/errors';
import { getRun } from '@/server/publish/orchestrator';
import { requireSessionAccess } from '@/server/sessions/access';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// The publish run with its per-step states (SR-13.3).
export const GET = withApiHandler<{ id: string; runId: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  const run = await getRun(session.id, ctx.params.runId);
  if (!run) throw new HttpError(404, 'Publish run not found', 'not_found');
  return Response.json({ run }, { headers: { 'Cache-Control': 'no-store' } });
});
