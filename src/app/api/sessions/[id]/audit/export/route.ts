import { withApiHandler } from '@/server/http/handler';
import { streamSessionAudit } from '@/server/audit/read';
import { requireSessionAccess } from '@/server/sessions/access';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// Exports audit records for a session as JSON Lines (application/x-ndjson), oldest first.
// Returns a stream with attachment Content-Disposition header.
export const GET = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);

  const stream = await streamSessionAudit(session.id);

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Content-Disposition': `attachment; filename=audit-${session.id}.jsonl`,
      'Cache-Control': 'no-store',
    },
  });
});
