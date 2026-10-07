import { query } from '@/server/db/pool';
import { withApiHandler } from '@/server/http/handler';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// Records the data-handling notice acknowledgement (NFR-7). Idempotent: the first acknowledgement time is kept.
export const POST = withApiHandler({}, async (ctx) => {
  await query(
    'UPDATE app_user SET data_notice_ack_at = COALESCE(data_notice_ack_at, now()) WHERE atlassian_account_id = $1',
    [ctx.user!.accountId],
  );
  return Response.json({ dataNoticeAcknowledged: true }, { headers: { 'Cache-Control': 'no-store' } });
});
