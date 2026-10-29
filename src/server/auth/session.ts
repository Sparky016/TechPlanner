import { createHash, randomBytes } from 'node:crypto';
import { type DbClient, query, withTransaction } from '@/server/db/pool';
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
export async function createSession(client: DbClient, userId: string): Promise<string> {
  const value = randomBytes(32).toString('base64url');
  await client.query(
    `INSERT INTO app_session (id_hash, user_id, expires_at)
     VALUES (?, ?, NOW(6) + INTERVAL ? HOUR)`,
    [hashSessionId(value), userId, IDLE_HOURS],
  );
  return value;
}

// Resolves the session cookie to a user and slides the idle expiry (capped at the absolute lifetime).
export async function getCurrentUser(request: Request): Promise<CurrentUser | null> {
  const value = readCookie(request, SESSION_COOKIE);
  if (!value) return null;
  const idHash = hashSessionId(value);
  // user_id references app_user, so a non-null user_id means the user exists. The read-back repeats the validity
  // check: a session that was not slid (expired or deleted meanwhile) yields no row.
  await query(
    `UPDATE app_session
        SET last_seen_at = NOW(6),
            expires_at = LEAST(created_at + INTERVAL ? DAY, NOW(6) + INTERVAL ? HOUR)
      WHERE id_hash = ?
        AND expires_at > NOW(6)
        AND user_id IS NOT NULL`,
    [ABSOLUTE_DAYS, IDLE_HOURS, idHash],
  );
  const rows = await query<{ account_id: string; display_name: string }>(
    `SELECT u.atlassian_account_id AS account_id, u.display_name
       FROM app_session s JOIN app_user u ON u.atlassian_account_id = s.user_id
      WHERE s.id_hash = ?
        AND s.expires_at > NOW(6)`,
    [idHash],
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
  const idHash = hashSessionId(value);
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ user_id: string | null }>(
      'SELECT user_id FROM app_session WHERE id_hash = ? FOR UPDATE',
      [idHash],
    );
    if (rows.length === 0) return null;
    await client.query('DELETE FROM app_session WHERE id_hash = ?', [idHash]);
    return rows[0].user_id;
  });
}
