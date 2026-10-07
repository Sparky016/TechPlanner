import { AtlassianApiError, atlassianFetch } from '@/server/atlassian/client';
import type { CurrentUser } from '@/server/auth/session';
import { HttpError } from '@/server/http/errors';
import { type PlanningSessionRow, getSessionById } from './repo';

// Server-only: never import from src/lib or client components.
// Session access is delegated to Jira (D-12): a user may use a session only if they can read its primary ticket.
// Unauthorized and missing sessions are indistinguishable (both 404), so session existence is never revealed.

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_SWEEP_SIZE = 10_000;

// userId:ticketKey -> outcome and expiry (epoch ms). Both outcomes are cached for at most 5 minutes (§7.3).
const cache = new Map<string, { allowed: boolean; expiresAt: number }>();

function notFound(): HttpError {
  return new HttpError(404, 'Session not found', 'not_found');
}

function remember(key: string, allowed: boolean): void {
  const now = Date.now();
  if (cache.size >= CACHE_SWEEP_SIZE) {
    for (const [k, entry] of cache) if (entry.expiresAt <= now) cache.delete(k);
  }
  cache.set(key, { allowed, expiresAt: now + CACHE_TTL_MS });
}

async function canReadTicket(userId: string, ticketKey: string): Promise<boolean> {
  const key = `${userId}:${ticketKey}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.allowed;

  let allowed: boolean;
  try {
    const res = await atlassianFetch(
      userId,
      'jira',
      `/rest/api/3/issue/${encodeURIComponent(ticketKey)}?fields=summary`,
    );
    await res.body?.cancel();
    allowed = true;
  } catch (err) {
    if (!(err instanceof AtlassianApiError) || (err.status !== 403 && err.status !== 404)) throw err;
    allowed = false;
  }
  remember(key, allowed);
  return allowed;
}

// Loads the session and checks the acting user can read its primary Jira ticket; otherwise HttpError 404.
// Other Atlassian failures (and ReauthRequiredError) propagate unchanged.
export async function requireSessionAccess(
  ctx: { user: CurrentUser | null },
  sessionId: string,
): Promise<PlanningSessionRow> {
  if (!ctx.user) throw new HttpError(401, 'Authentication required', 'unauthenticated');
  const session = await getSessionById(sessionId);
  if (!session) throw notFound();
  if (!(await canReadTicket(ctx.user.accountId, session.primaryTicketKey))) throw notFound();
  return session;
}

export function clearAccessCacheForTests(): void {
  cache.clear();
}
