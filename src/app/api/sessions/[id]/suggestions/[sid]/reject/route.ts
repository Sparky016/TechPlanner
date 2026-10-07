import { recordAudit } from '@/server/audit/audit';
import { query } from '@/server/db/pool';
import { HttpError } from '@/server/http/errors';
import { withApiHandler } from '@/server/http/handler';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, requireLock } from '@/server/sessions/lock';
import { isUuid } from '@/server/sessions/repo';
import { SuggestionNotFoundError, SuggestionNotPendingError, rejectSuggestion } from '@/server/spec/workingCopyRepo';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// Rejects a pending AI suggestion. The working copy is unchanged. No body.
export const POST = withApiHandler<{ id: string; sid: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));

  // The repository does not scope suggestions to a session; only this session's suggestions may be decided here.
  const sid = ctx.params.sid;
  const rows = isUuid(sid)
    ? await query<{ section: string }>('SELECT section FROM pending_suggestion WHERE id = $1 AND session_id = $2', [
        sid,
        session.id,
      ])
    : [];
  if (rows.length === 0) throw new HttpError(404, 'Suggestion not found', 'suggestion_not_found');

  try {
    await rejectSuggestion(sid);
  } catch (err) {
    if (err instanceof SuggestionNotFoundError)
      throw new HttpError(404, 'Suggestion not found', 'suggestion_not_found');
    if (err instanceof SuggestionNotPendingError) {
      throw new HttpError(409, 'Suggestion has already been decided', 'suggestion_not_pending');
    }
    throw err;
  }

  await recordAudit({
    action: 'ai.suggestion.rejected',
    result: 'success',
    userId: ctx.user!.accountId,
    userDisplayName: ctx.user!.displayName,
    sessionId: session.id,
    ticketIds: session.ticketKeys,
    details: { suggestionId: sid, section: rows[0].section, edited: false },
    correlationId: ctx.correlationId,
  });
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
});
