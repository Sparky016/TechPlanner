import { describe, expect, it } from 'vitest';
import { isDeadlock, isForeignKeyViolation, isTriggerRejection, isUniqueViolation } from './errors';

const pgError = (code: string): Error => Object.assign(new Error('db error'), { code });

describe('database error classification', () => {
  it('recognises PostgreSQL SQLSTATEs', () => {
    expect(isUniqueViolation(pgError('23505'))).toBe(true);
    expect(isForeignKeyViolation(pgError('23503'))).toBe(true);
    expect(isDeadlock(pgError('40P01'))).toBe(true);
    expect(isTriggerRejection(pgError('23001'))).toBe(true);
    expect(isTriggerRejection(pgError('42501'))).toBe(true);
  });

  it('does not confuse one class with another', () => {
    expect(isUniqueViolation(pgError('23503'))).toBe(false);
    expect(isForeignKeyViolation(pgError('23505'))).toBe(false);
    expect(isDeadlock(pgError('40001'))).toBe(false);
    expect(isTriggerRejection(pgError('23514'))).toBe(false);
  });

  it('is false for values that are not database errors', () => {
    for (const value of [new Error('plain'), null, undefined, 'boom', { code: 23505 }]) {
      expect(isUniqueViolation(value)).toBe(false);
      expect(isTriggerRejection(value)).toBe(false);
    }
  });
});
