import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getConfig } from '@/server/config';
import { HttpError } from '@/server/http/errors';

// Server-only: never import from src/lib or client components.
// CSRF protection (NFR-6): double-submit cookie + header, plus an Origin check against APP_BASE_URL.
// The session cookie is SameSite=Lax as a further layer.

export const CSRF_COOKIE = 'tp_csrf';
export const CSRF_HEADER = 'x-csrf-token';

// Aligned with the app session's absolute lifetime.
const CSRF_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Returns a fresh token and the Set-Cookie value carrying it. The client sends the token back in x-csrf-token.
export function issueCsrfToken(): { token: string; cookie: string } {
  const token = randomBytes(32).toString('base64url');
  const attrs = [`${CSRF_COOKIE}=${token}`, 'Path=/', `Max-Age=${CSRF_MAX_AGE_SECONDS}`, 'HttpOnly', 'SameSite=Lax'];
  if (process.env.NODE_ENV !== 'development') attrs.push('Secure');
  return { token, cookie: attrs.join('; ') };
}

function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function tokensMatch(cookie: string | undefined, header: string | null): boolean {
  if (!cookie || !header || !TOKEN_PATTERN.test(cookie) || !TOKEN_PATTERN.test(header)) return false;
  return timingSafeEqual(Buffer.from(cookie), Buffer.from(header));
}

// Throws HttpError 403 unless the request comes from APP_BASE_URL's origin (Origin, else Referer; a request
// carrying neither is rejected) and carries a matching cookie/header token pair.
export function verifyCsrf(req: NextRequest): void {
  const expected = new URL(getConfig().APP_BASE_URL).origin;
  const origin = req.headers.get('origin');
  const actual = origin !== null ? originOf(origin) : originOf(req.headers.get('referer'));
  if (actual !== expected) throw new HttpError(403, 'Cross-site request rejected', 'csrf_origin');
  if (!tokensMatch(req.cookies.get(CSRF_COOKIE)?.value, req.headers.get(CSRF_HEADER))) {
    throw new HttpError(403, 'Missing or invalid CSRF token', 'csrf_token');
  }
}
