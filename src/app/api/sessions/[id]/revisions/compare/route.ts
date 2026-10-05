import { HttpError } from '@/server/http/errors';
import { withApiHandler } from '@/server/http/handler';
import { RevisionNotFoundError, compareRevisions } from '@/server/revisions/revisions';
import { requireSessionAccess } from '@/server/sessions/access';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

function parseNumber(value: string | null, name: string): number {
  if (value === null || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new HttpError(400, `Query parameter ${name} must be a revision number`, 'invalid_revision');
  }
  return Number(value);
}

// Section-aligned diff between revisions a and b, in canonical section order.
export const GET = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  const url = new URL(ctx.req.url);
  const a = parseNumber(url.searchParams.get('a'), 'a');
  const b = parseNumber(url.searchParams.get('b'), 'b');
  try {
    const sections = await compareRevisions(session.id, a, b);
    return Response.json({ a, b, sections }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof RevisionNotFoundError) throw new HttpError(404, 'Revision not found', 'revision_not_found');
    throw err;
  }
});
