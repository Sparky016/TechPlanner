import { query } from '@/server/db/pool';
import { HttpError } from '@/server/http/errors';
import { withApiHandler } from '@/server/http/handler';
import { requireSessionAccess } from '@/server/sessions/access';
import { getWorkingCopy } from '@/server/spec/workingCopyRepo';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// Returns the Working Copy: version, each section's body and lastUserEditAt (keyed by section name), and the
// pending AI suggestions. Read-only, so no lock is required.
export const GET = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  const wc = await getWorkingCopy(session.id);
  if (!wc) throw new HttpError(404, 'Working copy not found', 'not_found');

  const sections: Record<string, { body: string; lastUserEditAt: string | null }> = {};
  for (const [name, state] of Object.entries(wc.sections)) {
    sections[name] = { body: state.body, lastUserEditAt: state.lastUserEditAt };
  }
  const suggestions = await query<{ id: string; section: string; patch: unknown; created_at: Date }>(
    `SELECT id, section, patch, created_at FROM pending_suggestion
      WHERE session_id = $1 AND status = 'pending' ORDER BY created_at, id`,
    [session.id],
  );
  return Response.json(
    {
      version: wc.version,
      sections,
      pendingSuggestions: suggestions.map((s) => ({
        id: s.id,
        section: s.section,
        patch: s.patch,
        createdAt: s.created_at.toISOString(),
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
