import { runHealthChecks } from '@/server/observability/health';

// Server-only route; never cache health results.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const report = await runHealthChecks();
  return Response.json(
    { status: report.ok ? 'ok' : 'unhealthy', checks: report.checks },
    { status: report.ok ? 200 : 503 },
  );
}
