import { z } from 'zod';
import { recordAudit } from '@/server/audit/audit';
import { query } from '@/server/db/pool';
import { HttpError } from '@/server/http/errors';
import { withApiHandler } from '@/server/http/handler';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, requireLock } from '@/server/sessions/lock';
import { isUuid } from '@/server/sessions/repo';
import { recordDraftUpdated } from '@/server/spec/editAudit';
import { SuggestionNotFoundError, SuggestionNotPendingError, acceptSuggestion } from '@/server/spec/workingCopyRepo';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

const MAX_SECTION_CHARS = 100_000;

const AcceptBody = z.object({ editedContent: z.string().optional() });

// Accepts a pending AI suggestion, optionally with facilitator-edited content. Returns the new working copy version.
export const POST = withApiHandler<{ id: string; sid: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));

  const text = await ctx.req.text();
  let raw: unknown = {};
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Request body must be JSON', 'invalid_json');
    }
  }
  const { editedContent } = AcceptBody.parse(raw);
  if (editedContent !== undefined && editedContent.length > MAX_SECTION_CHARS) {
    throw new HttpError(413, `Edited content exceeds ${MAX_SECTION_CHARS} characters`, 'body_too_large');
  }

  // The repository does not scope suggestions to a session; only this session's suggestions may be decided here.
  const sid = ctx.params.sid;
  const rows = isUuid(sid)
    ? await query<{ section: string }>('SELECT section FROM pending_suggestion WHERE id = $1 AND session_id = $2', [
        sid,
        session.id,
      ])
    : [];
  if (rows.length === 0) throw new HttpError(404, 'Suggestion not found', 'suggestion_not_found');

  let version: number;
  try {
    version = await acceptSuggestion(sid, editedContent);
  } catch (err) {
    if (err instanceof SuggestionNotFoundError)
      throw new HttpError(404, 'Suggestion not found', 'suggestion_not_found');
    if (err instanceof SuggestionNotPendingError) {
      throw new HttpError(409, 'Suggestion has already been decided', 'suggestion_not_pending');
    }
    throw err;
  }

  const actor = { user: ctx.user!, ticketIds: session.ticketKeys, correlationId: ctx.correlationId };
  await recordAudit({
    action: 'ai.suggestion.accepted',
    result: 'success',
    userId: actor.user.accountId,
    userDisplayName: actor.user.displayName,
    sessionId: session.id,
    ticketIds: actor.ticketIds,
    details: { suggestionId: sid, section: rows[0].section, edited: editedContent !== undefined },
    correlationId: actor.correlationId,
  });
  await recordDraftUpdated(session.id, version, actor);
  return Response.json({ version }, { headers: { 'Cache-Control': 'no-store' } });
});
