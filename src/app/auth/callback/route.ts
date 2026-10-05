import { timingSafeEqual } from 'node:crypto';
import { recordAudit } from '@/server/audit/audit';
import {
  exchangeCode,
  getAccessibleResources,
  getProfile,
  type AtlassianProfile,
  type TokenSet,
} from '@/server/auth/atlassianOAuth';
import {
  OAUTH_STATE_COOKIE,
  clearOauthStateCookie,
  createSession,
  readCookie,
  sessionCookie,
} from '@/server/auth/session';
import { storeTokens } from '@/server/auth/tokens';
import { getConfig } from '@/server/config';
import { withTransaction } from '@/server/db/pool';
import { getCorrelationId } from '@/server/observability/context';
import { logger } from '@/server/observability/logger';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

type FailureReason =
  | 'authorization_denied'
  | 'state_mismatch'
  | 'token_exchange_failed'
  | 'site_not_granted'
  | 'profile_unavailable';

// Maps each failure to the /login error key the login page (task 32) will render.
const LOGIN_ERROR: Record<FailureReason, string> = {
  authorization_denied: 'denied',
  state_mismatch: 'state',
  token_exchange_failed: 'oauth',
  site_not_granted: 'site',
  profile_unavailable: 'oauth',
};

function redirect(path: string, cookies: string[]): Response {
  const headers = new Headers({ Location: `${getConfig().APP_BASE_URL}${path}`, 'Cache-Control': 'no-store' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Never records the code, state, verifier or tokens — only the reason.
async function fail(reason: FailureReason, profile?: AtlassianProfile): Promise<Response> {
  await recordAudit({
    action: 'auth.failure',
    result: 'failure',
    userId: profile?.accountId ?? null,
    userDisplayName: profile?.displayName ?? null,
    details: { reason },
    correlationId: getCorrelationId() ?? null,
  });
  logger.warn({ reason }, 'Atlassian login failed');
  return redirect(`/login?error=${LOGIN_ERROR[reason]}`, [clearOauthStateCookie()]);
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const code = params.get('code');
  const state = params.get('state');

  // The state cookie is "<state>.<verifier>"; both halves are base64url so contain no '.'.
  const stored = readCookie(request, OAUTH_STATE_COOKIE);
  const dot = stored ? stored.indexOf('.') : -1;
  const storedState = stored && dot > 0 ? stored.slice(0, dot) : null;
  const verifier = stored && dot > 0 ? stored.slice(dot + 1) : null;
  if (!state || !storedState || !verifier || !sameString(state, storedState)) return fail('state_mismatch');
  if (params.get('error') || !code) return fail('authorization_denied');

  let tokens: TokenSet;
  try {
    tokens = await exchangeCode(code, verifier);
  } catch {
    return fail('token_exchange_failed');
  }

  // SR-1.4: the grant must include the configured Atlassian site.
  let profile: AtlassianProfile;
  try {
    const resources = await getAccessibleResources(tokens.accessToken);
    if (!resources.some((r) => r.id === getConfig().ATLASSIAN_CLOUD_ID)) return fail('site_not_granted');
    profile = await getProfile(tokens.accessToken);
  } catch {
    return fail('profile_unavailable');
  }

  const sessionValue = await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO app_user (atlassian_account_id, display_name, email)
       VALUES ($1, $2, $3)
       ON CONFLICT (atlassian_account_id) DO UPDATE
         SET display_name = EXCLUDED.display_name, email = EXCLUDED.email`,
      [profile.accountId, profile.displayName, profile.email],
    );
    await storeTokens(client, profile.accountId, tokens);
    const value = await createSession(client, profile.accountId);
    await recordAudit(
      {
        action: 'auth.login',
        result: 'success',
        userId: profile.accountId,
        userDisplayName: profile.displayName,
        details: { cloudId: getConfig().ATLASSIAN_CLOUD_ID },
        correlationId: getCorrelationId() ?? null,
      },
      client,
    );
    return value;
  });

  logger.info({ userId: profile.accountId }, 'Atlassian login succeeded');
  return redirect('/sessions', [sessionCookie(sessionValue), clearOauthStateCookie()]);
}
