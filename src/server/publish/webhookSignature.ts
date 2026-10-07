import { createHmac, timingSafeEqual } from 'node:crypto';

// Server-only: never import from src/lib or client components.
// Downstream webhook signature (SPEC_DOC §7.4). The exact header format is unspecified in the spec; fallback is
// `sha256=<hex HMAC-SHA256 of the exact raw body>`. Downstream consumers must verify against the raw request bytes.

const PREFIX = 'sha256=';

export function signPayload(rawBody: string | Buffer, secret: string): string {
  return PREFIX + createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifySignature(rawBody: string | Buffer, secret: string, signature: string): boolean {
  const expected = Buffer.from(signPayload(rawBody, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
