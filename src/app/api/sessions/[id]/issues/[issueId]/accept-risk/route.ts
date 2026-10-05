import { recordAudit } from '@/server/audit/audit';
import { withTransaction } from '@/server/db/pool';
import { HttpError } from '@/server/http/errors';
import { withApiHandler } from '@/server/http/handler';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, requireLock } from '@/server/sessions/lock';
import { isUuid } from '@/server/sessions/repo';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

interface IssueRow {
  id: string;
  severity: string;
  section: string;
  description: string;
  status: string;
}

// Marks a warning or informational issue as accepted risk (SR-7.4). Critical issues need an override: 400.
export const POST = withApiHandler<{ id: string; issueId: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));
  const notFound = () => new HttpError(404, 'Issue not found', 'not_found');
  if (!isUuid(ctx.params.issueId)) throw notFound();

  const issue = await withTransaction(async (client) => {
    const { rows } = await client.query<IssueRow>(
      'SELECT id, severity, section, description, status FROM issue WHERE id = $1 AND session_id = $2 FOR UPDATE',
      [ctx.params.issueId, session.id],
    );
    const row = rows[0];
    if (!row) throw notFound();
    if (row.severity === 'critical') {
      throw new HttpError(400, 'Critical issues cannot be accepted as risk', 'critical_requires_override');
    }
    if (row.status === 'resolved') throw new HttpError(409, 'Issue is already resolved', 'issue_resolved');
    if (row.status === 'accepted-risk') return row;

    await client.query("UPDATE issue SET status = 'accepted-risk' WHERE id = $1", [row.id]);
    await recordAudit(
      {
        action: 'issue.accepted_risk',
        result: 'success',
        userId: ctx.user!.accountId,
        userDisplayName: ctx.user!.displayName,
        sessionId: session.id,
        ticketIds: session.ticketKeys,
        correlationId: ctx.correlationId,
        details: { issueId: row.id, severity: row.severity, section: row.section, description: row.description },
      },
      client,
    );
    return row;
  });

  return Response.json(
    { id: issue.id, severity: issue.severity, section: issue.section, status: 'accepted-risk' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
