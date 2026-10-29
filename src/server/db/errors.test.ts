import { describe, expect, it } from 'vitest';
import {
  isCheckViolation,
  isDeadlock,
  isForeignKeyViolation,
  isLockWaitTimeout,
  isPoolAcquireTimeout,
  isTriggerRejection,
  isUniqueViolation,
} from './errors';
import { PoolAcquireTimeoutError } from './mysql';

const mysqlError = (errno: number, sqlState = 'HY000'): Error =>
  Object.assign(new Error('db error'), { errno, sqlState });

describe('database error classification', () => {
  it('recognises MySQL error numbers', () => {
    expect(isUniqueViolation(mysqlError(1062, '23000'))).toBe(true);
    expect(isForeignKeyViolation(mysqlError(1452, '23000'))).toBe(true);
    expect(isForeignKeyViolation(mysqlError(1451, '23000'))).toBe(true);
    expect(isCheckViolation(mysqlError(3819))).toBe(true);
    expect(isDeadlock(mysqlError(1213, '40001'))).toBe(true);
    expect(isLockWaitTimeout(mysqlError(1205))).toBe(true);
    expect(isTriggerRejection(mysqlError(1644, '45000'))).toBe(true);
  });

  it('does not confuse one class with another', () => {
    expect(isUniqueViolation(mysqlError(1452, '23000'))).toBe(false);
    expect(isForeignKeyViolation(mysqlError(1062, '23000'))).toBe(false);
    expect(isDeadlock(mysqlError(1205))).toBe(false);
    expect(isLockWaitTimeout(mysqlError(1213, '40001'))).toBe(false);
    expect(isTriggerRejection(mysqlError(3819))).toBe(false);
    // A SIGNAL with another SQLSTATE is not one of the schema's triggers.
    expect(isTriggerRejection(mysqlError(1644, '02000'))).toBe(false);
  });

  it('recognises a pool acquire timeout, and nothing else as one', () => {
    expect(isPoolAcquireTimeout(new PoolAcquireTimeoutError(100))).toBe(true);
    expect(isPoolAcquireTimeout(mysqlError(1205))).toBe(false);
    expect(isDeadlock(new PoolAcquireTimeoutError(100))).toBe(false);
  });

  it('is false for values that are not database errors', () => {
    for (const value of [new Error('plain'), null, undefined, 'boom', { errno: '1062' }]) {
      expect(isUniqueViolation(value)).toBe(false);
      expect(isTriggerRejection(value)).toBe(false);
      expect(isPoolAcquireTimeout(value)).toBe(false);
    }
  });
});
