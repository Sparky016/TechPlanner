import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { buildCsp, middleware } from './middleware';

function nonceOf(csp: string): string {
  const match = /'nonce-([^']+)'/.exec(csp);
  if (!match) throw new Error('no nonce in CSP');
  return match[1];
}

describe('middleware security headers', () => {
  it.each(['/', '/api/csrf', '/_next/static/chunk.js'])('sets every security header on %s', (path) => {
    const res = middleware(new NextRequest(`http://localhost:3000${path}`));
    const csp = res.headers.get('content-security-policy') ?? '';

    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("form-action 'self' https://auth.atlassian.com");
    expect(res.headers.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
  });

  it('forwards the same nonce to Next.js via the x-nonce request header', () => {
    const res = middleware(new NextRequest('http://localhost:3000/'));
    const nonce = nonceOf(res.headers.get('content-security-policy') ?? '');
    expect(res.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(res.headers.get('x-middleware-request-content-security-policy')).toContain(`'nonce-${nonce}'`);
  });

  it('uses a fresh nonce per request', () => {
    const a = nonceOf(middleware(new NextRequest('http://localhost:3000/')).headers.get('content-security-policy')!);
    const b = nonceOf(middleware(new NextRequest('http://localhost:3000/')).headers.get('content-security-policy')!);
    expect(a).not.toBe(b);
  });

  it('builds the exact production policy, and adds unsafe-eval only in development', () => {
    expect(buildCsp('abc', false)).toBe(
      "default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https://*.atlassian.net; connect-src 'self'; frame-ancestors 'none'; " +
        "base-uri 'self'; form-action 'self' https://auth.atlassian.com",
    );
    expect(buildCsp('abc', true)).toContain("'strict-dynamic' 'unsafe-eval'");
  });
});
