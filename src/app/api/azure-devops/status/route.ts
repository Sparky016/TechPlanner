import { checkConnection } from '@/server/azureDevOps/client';
import { withApiHandler } from '@/server/http/handler';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// Live Azure DevOps connection check (ADR-0016): calls Azure DevOps with the configured PAT and returns the
// repositories the facilitator may pick from. A failed connection is a 200 with connected: false and the reason.
export const GET = withApiHandler({}, async () => {
  const status = await checkConnection();
  return Response.json({ ...status, checkedAt: new Date().toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
});
