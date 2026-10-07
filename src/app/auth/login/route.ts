import { buildAuthorizeUrl, createCodeVerifier, createState } from '@/server/auth/atlassianOAuth';
import { oauthStateCookie } from '@/server/auth/session';

// Server-only route; never cache: every login gets a fresh state and PKCE verifier.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const state = createState();
  const verifier = createCodeVerifier();
  return new Response(null, {
    status: 302,
    headers: {
      Location: buildAuthorizeUrl(state, verifier),
      'Set-Cookie': oauthStateCookie(state, verifier),
      'Cache-Control': 'no-store',
    },
  });
}
