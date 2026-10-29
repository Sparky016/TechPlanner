import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from './actions';
import {
  assertStorableDetails,
  type AuditHashPayload,
  canonicalJson,
  computeHash,
  jsonNumberRoundTrips,
  REDACTED,
  redactDetails,
} from './hash';

const PAYLOAD: AuditHashPayload = {
  ts: '2026-10-05T12:00:00.123Z',
  userId: 'acc-1',
  userDisplayName: 'Ada',
  sessionId: null,
  ticketIds: ['ABC-1'],
  action: 'draft.saved',
  result: 'success',
  details: { b: 1, a: [2, 1] },
  correlationId: null,
};

describe('canonicalJson', () => {
  it('sorts object keys recursively, keeps array order and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x y' } })).toBe(
      '{"a":{"c":"x y","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('is independent of key insertion order', () => {
    expect(canonicalJson({ x: 1, y: { p: true, q: null } })).toBe(canonicalJson({ y: { q: null, p: true }, x: 1 }));
  });

  it('omits undefined members like JSON.stringify', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });
});

describe('redactDetails', () => {
  it('redacts accessToken, refresh_token and Authorization', () => {
    expect(
      redactDetails({
        accessToken: 'at',
        refresh_token: 'rt',
        Authorization: 'Bearer x',
        ticket: 'ABC-1',
      }),
    ).toEqual({
      accessToken: REDACTED,
      refresh_token: REDACTED,
      Authorization: REDACTED,
      ticket: 'ABC-1',
    });
  });

  it('redacts nested objects and objects inside arrays, matching keys case-insensitively', () => {
    const redacted = redactDetails({
      request: {
        headers: { COOKIE: 'c', accept: 'json' },
        clientSecret: { nested: 'value' },
      },
      attempts: [{ password: 'p', n: 1 }, 'plain'],
    });
    expect(redacted).toEqual({
      request: {
        headers: { COOKIE: REDACTED, accept: 'json' },
        clientSecret: REDACTED,
      },
      attempts: [{ password: REDACTED, n: 1 }, 'plain'],
    });
    expect(JSON.stringify(redacted)).not.toMatch(/"c"|"p"|value/);
  });

  it('does not mutate its input', () => {
    const input = { token: 't' };
    redactDetails(input);
    expect(input).toEqual({ token: 't' });
  });
});

describe('computeHash', () => {
  it('is SHA-256 of the previous hash hex followed by the canonical JSON', () => {
    const prev = 'ab'.repeat(32);
    const expected = createHash('sha256')
      .update(prev + canonicalJson(PAYLOAD))
      .digest('hex');
    expect(computeHash(prev, PAYLOAD)).toBe(expected);
    expect(computeHash(prev, PAYLOAD)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the previous hash or any field changes', () => {
    const base = computeHash('', PAYLOAD);
    expect(computeHash('00', PAYLOAD)).not.toBe(base);
    expect(computeHash('', { ...PAYLOAD, details: { b: 2, a: [2, 1] } })).not.toBe(base);
    expect(computeHash('', { ...PAYLOAD, details: { a: [2, 1], b: 1 } })).toBe(base);
  });
});

describe('jsonNumberRoundTrips', () => {
  it('accepts integer literals within (u)int64 and short decimals', () => {
    for (const n of [0, -0, 1, -1, 100, 2 ** 53 - 1, 2 ** 53, 2 ** 53 + 2, 2 ** 63, 2 ** 64 - 2048, -(2 ** 62)]) {
      expect(jsonNumberRoundTrips(n), String(n)).toBe(true);
    }
    for (const n of [1.5, 0.1, 4.35, 1e-7, 1e-22, 1e21, 1e22, 123456.789, 123456789012.345]) {
      expect(jsonNumberRoundTrips(n), String(n)).toBe(true);
    }
  });

  it('rejects numbers the MySQL JSON parser may round: 16-17 significant digits, or a far exponent', () => {
    // 123456789.12345679 and 226.31531953811646 read back as 123456789.1234568 and 226.31531953811648 on MySQL 8.4.
    for (const n of [123456789.12345679, 226.31531953811646, 0.40480745641475435, 1e23, 1e-23, 2 ** 64, -(2 ** 63)]) {
      expect(jsonNumberRoundTrips(n), String(n)).toBe(false);
    }
    for (const n of [Number.MAX_VALUE, Number.MIN_VALUE, NaN, Infinity]) expect(jsonNumberRoundTrips(n)).toBe(false);
  });
});

describe('assertStorableDetails', () => {
  it('accepts nested JSON of storable strings and numbers', () => {
    expect(() => assertStorableDetails({ a: [1, 'Zoë 😀', null, true, { b: 2.5, '': [] }], c: {} })).not.toThrow();
  });

  it('names the path of a value that would not read back unchanged', () => {
    expect(() => assertStorableDetails({ a: [{ b: 0.1 + 0.7 * 3.3 }] })).toThrow(
      /^details\.a\[0\]\.b must be a number/,
    );
    expect(() => assertStorableDetails({ 'a b': 2 ** 64 })).toThrow(/^details\["a b"\] must be a number/);
    expect(() => assertStorableDetails({ a: { b: 'x\uD800' } })).toThrow('details.a.b must be well-formed Unicode');
    expect(() => assertStorableDetails({ ['k\uDC00']: 1 })).toThrow('details keys must be well-formed Unicode');
  });
});

describe('AUDIT_ACTIONS', () => {
  it('contains every SR-12.1 event type and the four additional events', () => {
    const sr121 = [
      'auth.login',
      'auth.logout',
      'auth.failure',
      'draft.created',
      'draft.updated',
      'draft.saved',
      'ai.suggestion',
      'ai.suggestion.accepted',
      'ai.suggestion.rejected',
      'user.edit',
      'readiness.evaluated',
      'readiness.override',
      'publish.started',
      'publish.completed',
      'publish.failed',
      'jira.updated',
      'confluence.updated',
      'downstream.triggered',
      'revision.restored',
      'error',
    ];
    const extra = ['auth.refresh_failed', 'question.dismissed', 'issue.accepted_risk', 'session.lock_taken_over'];
    expect([...AUDIT_ACTIONS].sort()).toEqual([...sr121, ...extra].sort());
  });
});
