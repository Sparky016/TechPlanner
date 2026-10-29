// Server-only: never import from src/lib or client components.
// Classifies database errors so callers never compare driver codes themselves. PostgreSQL reports a SQLSTATE in
// `code`; MySQL errno mapping is added with the driver swap (task 46).

// The schema's triggers raise these: revision_immutable (restrict_violation) and audit_record append-only
// (insufficient_privilege).
const TRIGGER_REJECTION_STATES = new Set(['23001', '42501']);

function sqlState(err: unknown): string | undefined {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

export function isUniqueViolation(err: unknown): boolean {
  return sqlState(err) === '23505';
}

export function isForeignKeyViolation(err: unknown): boolean {
  return sqlState(err) === '23503';
}

export function isDeadlock(err: unknown): boolean {
  return sqlState(err) === '40P01';
}

/** A write refused by one of the schema's triggers (immutable revisions, append-only audit records). */
export function isTriggerRejection(err: unknown): boolean {
  const state = sqlState(err);
  return state !== undefined && TRIGGER_REJECTION_STATES.has(state);
}
