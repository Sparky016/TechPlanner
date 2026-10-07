import { z } from 'zod';
import { recordAudit } from '@/server/audit/audit';
import { withTransaction } from '@/server/db/pool';
import { HttpError } from '@/server/http/errors';
import { withApiHandler } from '@/server/http/handler';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, requireLock } from '@/server/sessions/lock';
import { isUuid } from '@/server/sessions/repo';

// Server-only route; never cache.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_REASON_CHARS = 500;

const DismissBody = z.object({ reason: z.string().optional() });

function questionNotFound(): HttpError {
  return new HttpError(404, 'Question not found', 'question_not_found');
}

// Dismisses an open AI question, optionally with a reason, and audits question.dismissed.
export const POST = withApiHandler<{ id: string; qid: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));

  const body = await ctx.req.text();
  let raw: unknown = {};
  if (body.trim() !== '') {
    try {
      raw = JSON.parse(body);
    } catch {
      throw new HttpError(400, 'Request body must be JSON', 'invalid_json');
    }
  }
  const parsed = DismissBody.parse(raw);
  const reason = parsed.reason?.trim() ? parsed.reason : null;
  if (reason !== null && reason.length > MAX_REASON_CHARS) {
    throw new HttpError(413, `Reason exceeds ${MAX_REASON_CHARS} characters`, 'body_too_large');
  }

  const qid = ctx.params.qid;
  if (!isUuid(qid)) throw questionNotFound();

  await withTransaction(async (client) => {
    const current = await client.query<{ status: string; section: string | null }>(
      'SELECT status, section FROM ai_question WHERE id = $1 AND session_id = $2 FOR UPDATE',
      [qid, session.id],
    );
    const question = current.rows[0];
    if (!question) throw questionNotFound();
    if (question.status !== 'open') {
      throw new HttpError(409, `Question is already ${question.status}`, 'question_not_open');
    }
    await client.query("UPDATE ai_question SET status = 'dismissed', dismiss_reason = $2 WHERE id = $1", [
      qid,
      reason,
    ]);
    await recordAudit(
      {
        action: 'question.dismissed',
        result: 'success',
        userId: ctx.user!.accountId,
        userDisplayName: ctx.user!.displayName,
        sessionId: session.id,
        ticketIds: session.ticketKeys,
        details: { questionId: qid, section: question.section, reason },
        correlationId: ctx.correlationId,
      },
      client,
    );
  });

  return Response.json({ id: qid, status: 'dismissed', dismissReason: reason }, { headers: { 'Cache-Control': 'no-store' } });
});
