import { issueCsrfToken } from '@/server/http/csrf';
import { withApiHandler } from '@/server/http/handler';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// Issues a CSRF token: returned in the body for the client to send as x-csrf-token, and set as the tp_csrf cookie.
export const GET = withApiHandler({}, async () => {
  const { token, cookie } = issueCsrfToken();
  return Response.json({ token }, { headers: { 'Set-Cookie': cookie, 'Cache-Control': 'no-store' } });
});
