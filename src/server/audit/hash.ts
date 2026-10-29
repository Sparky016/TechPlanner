import { createHash } from 'node:crypto';

// Server-only: never import from src/lib or client components.
// Pure functions (no config or DB access) so the hashing rules are unit-testable in isolation.

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY = /token|secret|password|authorization|cookie/i;

// The fields covered by a record's hash, in the exact shape stored in audit_record.
export interface AuditHashPayload {
  ts: string;
  userId: string | null;
  userDisplayName: string | null;
  sessionId: string | null;
  ticketIds: string[];
  action: string;
  result: 'success' | 'failure';
  details: Record<string, unknown>;
  correlationId: string | null;
}

// Deterministic JSON: object keys sorted recursively, array order kept, no whitespace.
// Input should be JSON-compatible; like JSON.stringify, undefined object members are omitted
// and undefined array elements become null.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const members = Object.keys(obj)
      .sort()
      .filter((key) => obj[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// Recursively replaces the value of every key matching SENSITIVE_KEY with "[REDACTED]" (SR-12.4).
export function redactDetails(details: Record<string, unknown>): Record<string, unknown> {
  return redactValue(details) as Record<string, unknown>;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, SENSITIVE_KEY.test(key) ? REDACTED : redactValue(inner)]),
    );
  }
  return value;
}

// SHA-256 over the previous record's hash (lowercase hex; '' for the first record) followed by the
// canonical JSON of the payload. Returns lowercase hex.
export function computeHash(prevHashHex: string, payload: AuditHashPayload): string {
  return createHash('sha256')
    .update(prevHashHex + canonicalJson(payload))
    .digest('hex');
}

const INT64_MIN = -(2n ** 63n);
const UINT64_MAX = 2n ** 64n - 1n;
const MAX_EXACT_SIGNIFICAND = 2n ** 53n - 1n;

/**
 * True when MySQL's JSON column is guaranteed to store `value` so that it reads back as the same JS number. MySQL
 * parses JSON numbers without full precision: about one random double in eight comes back one or two units in the
 * last place off, which would break the hash chain. Integer literals within (u)int64 are stored as integers, exactly.
 * Other numbers are exact when their shortest decimal form is m × 10^p with m < 2^53 and |p| ≤ 22, because then the
 * parser's single multiplication or division by an exact power of ten rounds correctly. Some numbers outside that
 * rule would round-trip too; they are rejected anyway (the audit callers record counts, scores and ids).
 */
export function jsonNumberRoundTrips(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(JSON.stringify(value));
  if (!match) return false;
  const [, sign, int, frac = '', exp] = match;
  if (frac === '' && exp === undefined) {
    const n = BigInt(sign + int);
    return n >= INT64_MIN && n <= UINT64_MAX;
  }
  const p = Number(exp ?? 0) - frac.length;
  return BigInt(int + frac) <= MAX_EXACT_SIGNIFICAND && p >= -22 && p <= 22;
}

/**
 * Throws unless the JSON value `details` reads back from a MySQL JSON column exactly as written: every string (keys
 * included) well-formed Unicode and every number accepted by jsonNumberRoundTrips. Pass the JSON-round-tripped form.
 */
export function assertStorableDetails(value: unknown, path = 'details'): void {
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new Error(`${path} must be well-formed Unicode`);
  } else if (typeof value === 'number') {
    if (!jsonNumberRoundTrips(value)) {
      throw new Error(
        `${path} must be a number MySQL JSON stores exactly (an int64 integer, or at most 15 significant digits)`,
      );
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => assertStorableDetails(item, `${path}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (!key.isWellFormed()) throw new Error(`${path} keys must be well-formed Unicode`);
      const step = /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
      assertStorableDetails(inner, `${path}${step}`);
    }
  }
}
