import { describe, expect, it } from 'vitest';
import { applyPatchToBody } from './patch';

describe('applyPatchToBody', () => {
  it('replace returns the patch content', () => {
    expect(
      applyPatchToBody('old body', {
        section: 'Scope',
        op: 'replace',
        content: 'new',
      }),
    ).toBe('new');
  });

  it('replace with empty content clears the body', () => {
    expect(
      applyPatchToBody('old body', {
        section: 'Scope',
        op: 'replace',
        content: '',
      }),
    ).toBe('');
  });

  it('append to a non-empty body joins with a newline', () => {
    expect(
      applyPatchToBody('line 1', {
        section: 'Scope',
        op: 'append',
        content: 'line 2',
      }),
    ).toBe('line 1\nline 2');
  });

  it('append to an empty body adds no separator', () => {
    expect(
      applyPatchToBody('', {
        section: 'Scope',
        op: 'append',
        content: 'first',
      }),
    ).toBe('first');
  });
});
