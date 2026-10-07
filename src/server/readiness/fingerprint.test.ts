import { describe, expect, it } from 'vitest';
import { issueFingerprint, normalizeIssueText } from './fingerprint';

describe('normalizeIssueText', () => {
  it('lowercases, strips punctuation, collapses whitespace and trims', () => {
    expect(normalizeIssueText('  Scope   is MISSING!!\n')).toBe('scope is missing');
  });
});

describe('issueFingerprint', () => {
  it('ignores case, punctuation and whitespace differences', () => {
    const a = issueFingerprint('Security', 'No auth model defined.');
    expect(issueFingerprint('Security', '  no AUTH   model, defined!! ')).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs across sections and across wording', () => {
    expect(issueFingerprint('Security', 'x issue')).not.toBe(issueFingerprint('Performance', 'x issue'));
    expect(issueFingerprint('Security', 'x issue')).not.toBe(issueFingerprint('Security', 'y issue'));
  });
});
