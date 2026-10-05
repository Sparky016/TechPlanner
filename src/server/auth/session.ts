import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query } from '@/server/db/pool';
import { HttpError } from '@/server/http/errors';

// Server-only: never import from src/lib or client components.
// App sessions (SR-1.5): the browser holds an opaque random value; the database stores only its SHA-256.

export const SESSION_COOKIE = 'tp_session';
// Short-lived cookie binding an in-flight login to this browser: "<state>.<pkce verifier>".
export const OAUTH_STATE_COOKIE = 'tp_oauth';

const IDLE_HOURS = 8;
const ABSOLUTE_DAYS = 7;
const OAUTH_STATE_MAX_AGE_SECONDS = 600;

export interface CurrentUser {
  accountId: string;
  displayName: string;
}

export function hashSessionId(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value === '' ? null : value;
    }
  }
  return null;
}

function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  const attrs = [`${name}=${value}`, 'Path=/', `Max-Age=${maxAgeSeconds}`, 'HttpOnly', 'SameSite=Lax'];
  if (process.env.NODE_ENV !== 'development') attrs.push('Secure');
  return attrs.join('; ');
}

export function sessionCookie(value: string): string {
  return serializeCookie(SESSION_COOKIE, value, ABSOLUTE_DAYS * 24 * 60 * 60);
}

export function clearSessionCookie(): string {
  return serializeCookie(SESSION_COOKIE, '', 0);
}

export function oauthStateCookie(state: string, codeVerifier: string): string {
  return serializeCookie(OAUTH_STATE_COOKIE, `${state}.${codeVerifier}`, OAUTH_STATE_MAX_AGE_SECONDS);
}

export function clearOauthStateCookie(): string {
  return serializeCookie(OAUTH_STATE_COOKIE, '', 0);
}

// Creates an app_session row inside the caller's transaction; returns the cookie value (never stored).
export async function createSession(client: PoolClient, userId: string): Promise<string> {
  const value = randomBytes(32).toString('base64url');
  await client.query(
    `INSERT INTO app_session (id_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [hashSessionId(value), userId, IDLE_HOURS],
  );
  return value;
}

// Resolves the session cookie to a user and slides the idle expiry (capped at the absolute lifetime).
export async function getCurrentUser(request: Request): Promise<CurrentUser | null> {
  const value = readCookie(request, SESSION_COOKIE);
  if (!value) return null;
  const rows = await query<{ account_id: string; display_name: string }>(
    `UPDATE app_session s
        SET last_seen_at = now(),
            expires_at = LEAST(s.created_at + make_interval(days => $2), now() + make_interval(hours => $3))
       FROM app_user u
      WHERE s.id_hash = $1
        AND s.expires_at > now()
        AND u.atlassian_account_id = s.user_id
     RETURNING u.atlassian_account_id AS account_id, u.display_name`,
    [hashSessionId(value), ABSOLUTE_DAYS, IDLE_HOURS],
  );
  const row = rows[0];
  return row ? { accountId: row.account_id, displayName: row.display_name } : null;
}

export async function requireUser(request: Request): Promise<CurrentUser> {
  const user = await getCurrentUser(request);
  if (!user) throw new HttpError(401, 'Authentication required', 'unauthenticated');
  return user;
}

// Deletes the session named by the request's cookie; returns its user id, if there was one.
export async function deleteSession(request: Request): Promise<string | null> {
  const value = readCookie(request, SESSION_COOKIE);
  if (!value) return null;
  const rows = await query<{ user_id: string | null }>(
    'DELETE FROM app_session WHERE id_hash = $1 RETURNING user_id',
    [hashSessionId(value)],
  );
  return rows[0]?.user_id ?? null;
}
