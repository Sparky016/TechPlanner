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
