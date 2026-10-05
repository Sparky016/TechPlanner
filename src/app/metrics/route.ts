import { timingSafeEqual } from 'node:crypto';
import { getConfig } from '@/server/config';
import { registry } from '@/server/observability/metrics';

// Server-only route; never cache metrics.
export const dynamic = 'force-dynamic';

function tokenMatches(header: string | null, expected: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  if (!match) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request): Promise<Response> {
  const expected = getConfig().METRICS_TOKEN;
  if (!expected) return new Response('Not Found', { status: 404 });
  if (!tokenMatches(request.headers.get('authorization'), expected)) {
    return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
  }
  return new Response(await registry.metrics(), { status: 200, headers: { 'Content-Type': registry.contentType } });
}
