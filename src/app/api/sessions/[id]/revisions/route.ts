import { recordAudit } from '@/server/audit/audit';
import { withTransaction } from '@/server/db/pool';
import { withApiHandler } from '@/server/http/handler';
import { createRevision, listRevisions } from '@/server/revisions/revisions';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, requireLock } from '@/server/sessions/lock';
import { flushEditAudits } from '@/server/spec/editAudit';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// Lists the session's revisions, newest first.
export const GET = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  const revisions = await listRevisions(session.id);
  return Response.json({ revisions }, { headers: { 'Cache-Control': 'no-store' } });
});

// Save Draft: snapshots the Working Copy as a new revision. Never calls Jira or Confluence (SR-10.2).
export const POST = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));

  const user = ctx.user!;
  const actor = { user, ticketIds: session.ticketKeys, correlationId: ctx.correlationId };
  await flushEditAudits(session.id, actor);
  const { number } = await withTransaction(async (client) => {
    const rev = await createRevision(client, {
      sessionId: session.id,
      trigger: 'save',
      authorId: user.accountId,
      published: false,
    });
    await recordAudit(
      {
        action: 'draft.saved',
        result: 'success',
        userId: user.accountId,
        userDisplayName: user.displayName,
        sessionId: session.id,
        ticketIds: actor.ticketIds,
        details: { number: rev.number },
        correlationId: actor.correlationId,
      },
      client,
    );
    return rev;
  });
  return Response.json({ number }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
});
