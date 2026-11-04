// Server-only: never import from src/lib or client components.
// Classifies database errors so callers never compare driver codes themselves. mysql2 reports the MySQL error
// number in `errno` and the SQLSTATE in `sqlState`.

const ER_DUP_ENTRY = 1062;
const ER_ROW_IS_REFERENCED_2 = 1451;
const ER_NO_REFERENCED_ROW_2 = 1452;
const ER_LOCK_DEADLOCK = 1213;
const ER_LOCK_WAIT_TIMEOUT = 1205;
const ER_CHECK_CONSTRAINT_VIOLATED = 3819;
// SIGNAL with a user SQLSTATE; the schema's triggers raise '45000'.
const ER_SIGNAL_EXCEPTION = 1644;

function field(err: unknown, name: 'errno' | 'sqlState'): unknown {
  return typeof err === 'object' && err !== null ? (err as Record<string, unknown>)[name] : undefined;
}

const hasErrno = (err: unknown, ...codes: number[]): boolean => {
  const errno = field(err, 'errno');
  return typeof errno === 'number' && codes.includes(errno);
};

export function isUniqueViolation(err: unknown): boolean {
  return hasErrno(err, ER_DUP_ENTRY);
}

/** A row references a missing parent, or a parent still referenced was deleted. */
export function isForeignKeyViolation(err: unknown): boolean {
  return hasErrno(err, ER_NO_REFERENCED_ROW_2, ER_ROW_IS_REFERENCED_2);
}

export function isCheckViolation(err: unknown): boolean {
  return hasErrno(err, ER_CHECK_CONSTRAINT_VIOLATED);
}

export function isDeadlock(err: unknown): boolean {
  return hasErrno(err, ER_LOCK_DEADLOCK);
}

export function isLockWaitTimeout(err: unknown): boolean {
  return hasErrno(err, ER_LOCK_WAIT_TIMEOUT);
}

/** A write refused by one of the schema's triggers (immutable revisions, append-only audit records). */
export function isTriggerRejection(err: unknown): boolean {
  return hasErrno(err, ER_SIGNAL_EXCEPTION) && field(err, 'sqlState') === '45000';
}

/** connect() gave up waiting for a free pooled connection (PoolAcquireTimeoutError in ./mysql). */
export function isPoolAcquireTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'DB_POOL_ACQUIRE_TIMEOUT';
}
