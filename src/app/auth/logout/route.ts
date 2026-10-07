import { recordAudit } from '@/server/audit/audit';
import { clearSessionCookie, deleteSession } from '@/server/auth/session';
import { getConfig } from '@/server/config';
import { query } from '@/server/db/pool';
import { getCorrelationId } from '@/server/observability/context';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// Always clears the cookie; audits auth.logout only when a session row was actually deleted.
export async function POST(request: Request): Promise<Response> {
  const userId = await deleteSession(request);
  if (userId) {
    const [user] = await query<{ display_name: string }>(
      'SELECT display_name FROM app_user WHERE atlassian_account_id = $1',
      [userId],
    );
    await recordAudit({
      action: 'auth.logout',
      result: 'success',
      userId,
      userDisplayName: user?.display_name ?? null,
      correlationId: getCorrelationId() ?? null,
    });
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${getConfig().APP_BASE_URL}/login`,
      'Set-Cookie': clearSessionCookie(),
      'Cache-Control': 'no-store',
    },
  });
}
