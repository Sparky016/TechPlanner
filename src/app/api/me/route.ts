import { query } from '@/server/db/pool';
import { withApiHandler } from '@/server/http/handler';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// The signed-in user and whether they have acknowledged the data-handling notice (NFR-7).
export const GET = withApiHandler({}, async (ctx) => {
  const rows = await query<{ data_notice_ack_at: Date | null }>(
    'SELECT data_notice_ack_at FROM app_user WHERE atlassian_account_id = $1',
    [ctx.user!.accountId],
  );
  return Response.json(
    {
      accountId: ctx.user!.accountId,
      displayName: ctx.user!.displayName,
      dataNoticeAcknowledged: rows[0]?.data_notice_ack_at != null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
