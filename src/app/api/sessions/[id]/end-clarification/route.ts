import { query } from '@/server/db/pool';
import { withApiHandler } from '@/server/http/handler';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, requireLock } from '@/server/sessions/lock';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// Ends the clarification phase. Idempotent. No dedicated audit action exists (SR-12.1); the next
// ai.suggestion context carries the state.
export const POST = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));
  await query('UPDATE planning_session SET clarification_ended = true, updated_at = now() WHERE id = $1', [
    session.id,
  ]);
  return Response.json({ clarificationEnded: true }, { headers: { 'Cache-Control': 'no-store' } });
});
