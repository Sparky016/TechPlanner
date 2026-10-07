import { withApiHandler } from '@/server/http/handler';
import { listSessionAudit } from '@/server/audit/read';
import { requireSessionAccess } from '@/server/sessions/access';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// Lists audit records for a session, newest first, with keyset pagination and action filter.
// Query params: cursor (string, optional), limit (number, default 50, max 200), action (string, optional).
export const GET = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);

  const url = new URL(ctx.req.url);
  const cursor = url.searchParams.get('cursor');
  const limitParam = url.searchParams.get('limit');
  const action = url.searchParams.get('action');

  // Validate cursor format if provided
  if (cursor !== null && !/^\d+$/.test(cursor)) {
    return Response.json({ error: 'cursor must be a number' }, { status: 400 });
  }

  // Parse and clamp limit
  let limit = 50;
  if (limitParam !== null) {
    const parsed = Number.parseInt(limitParam, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return Response.json({ error: 'limit must be a positive integer' }, { status: 400 });
    }
    limit = Math.min(parsed, 200);
  }

  const { records, nextCursor } = await listSessionAudit(session.id, cursor, limit, action);

  return Response.json(
    { records, nextCursor },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
