import { createHash, randomBytes } from 'node:crypto';
import { getConfig } from '@/server/config';

// Server-only: never import from src/lib or client components.
// Atlassian OAuth 2.0 (3LO) protocol calls. Error messages never include codes, verifiers or tokens.

// The real-host URLs, used when ATLASSIAN_AUTH_BASE_URL / ATLASSIAN_API_BASE_URL are unset.
export const AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
export const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
export const ACCESSIBLE_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';
export const ME_URL = 'https://api.atlassian.com/me';

const authorizeUrl = () => `${getConfig().ATLASSIAN_AUTH_BASE_URL}/authorize`;
const tokenUrl = () => `${getConfig().ATLASSIAN_AUTH_BASE_URL}/oauth/token`;
const meUrl = () => `${getConfig().ATLASSIAN_API_BASE_URL}/me`;

export function accessibleResourcesUrl(): string {
  return `${getConfig().ATLASSIAN_API_BASE_URL}/oauth/token/accessible-resources`;
}

// SR-1.3
export const OAUTH_SCOPES = [
  'read:me',
  'read:jira-work',
  'write:jira-work',
  'read:jira-user',
  'read:confluence-content.all',
  'read:confluence-space.summary',
  'write:confluence-content',
  'write:confluence-file',
  'search:confluence',
  'offline_access',
] as const;

export class AtlassianOAuthError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AtlassianOAuthError';
    this.status = status;
  }
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scopes: string[];
}

export interface AccessibleResource {
  id: string;
  url?: string;
  name?: string;
}

export interface AtlassianProfile {
  accountId: string;
  displayName: string;
  email: string | null;
}

const base64url = (buf: Buffer) => buf.toString('base64url');

export function createState(): string {
  return base64url(randomBytes(32));
}

// RFC 7636: 43-128 chars from the unreserved set; 32 random bytes base64url-encode to 43.
export function createCodeVerifier(): string {
  return base64url(randomBytes(32));
}

export function codeChallengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function buildAuthorizeUrl(state: string, codeVerifier: string): string {
  const config = getConfig();
  const url = new URL(authorizeUrl());
  url.searchParams.set('audience', 'api.atlassian.com');
  url.searchParams.set('client_id', config.ATLASSIAN_CLIENT_ID);
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '));
  url.searchParams.set('redirect_uri', config.OAUTH_REDIRECT_URI);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('code_challenge', codeChallengeFor(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<TokenSet> {
  const config = getConfig();
  return tokenRequest({
    grant_type: 'authorization_code',
    client_id: config.ATLASSIAN_CLIENT_ID,
    client_secret: config.ATLASSIAN_CLIENT_SECRET,
    code,
    redirect_uri: config.OAUTH_REDIRECT_URI,
    code_verifier: codeVerifier,
  });
}

export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  const config = getConfig();
  return tokenRequest({
    grant_type: 'refresh_token',
    client_id: config.ATLASSIAN_CLIENT_ID,
    client_secret: config.ATLASSIAN_CLIENT_SECRET,
    refresh_token: refreshToken,
  });
}

export async function getAccessibleResources(accessToken: string): Promise<AccessibleResource[]> {
  const body = await getJson(accessibleResourcesUrl(), accessToken, 'accessible-resources');
  if (!Array.isArray(body)) throw new AtlassianOAuthError('accessible-resources response is not a list');
  return body
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && typeof r.id === 'string')
    .map((r) => ({
      id: r.id as string,
      url: typeof r.url === 'string' ? r.url : undefined,
      name: typeof r.name === 'string' ? r.name : undefined,
    }));
}

export async function getProfile(accessToken: string): Promise<AtlassianProfile> {
  const body = (await getJson(meUrl(), accessToken, 'me')) as Record<string, unknown> | null;
  if (!body || typeof body.account_id !== 'string' || body.account_id === '') {
    throw new AtlassianOAuthError('me response has no account_id');
  }
  const name = typeof body.name === 'string' && body.name !== '' ? body.name : body.account_id;
  return {
    accountId: body.account_id,
    displayName: name,
    email: typeof body.email === 'string' ? body.email : null,
  };
}

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  let response: Response;
  try {
    response = await fetch(tokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(params),
    });
  } catch {
    throw new AtlassianOAuthError('token endpoint unreachable');
  }
  if (!response.ok) throw new AtlassianOAuthError('token endpoint rejected the request', response.status);
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
    throw new AtlassianOAuthError('token endpoint returned an invalid response');
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresInSeconds: body.expires_in,
    scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [],
  };
}

async function getJson(url: string, accessToken: string, name: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
  } catch {
    throw new AtlassianOAuthError(`${name} endpoint unreachable`);
  }
  if (!response.ok) throw new AtlassianOAuthError(`${name} request failed`, response.status);
  return response.json().catch(() => {
    throw new AtlassianOAuthError(`${name} returned invalid JSON`);
  });
}
