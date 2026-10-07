import { describe, expect, it } from 'vitest';
import { SECTION_NAMES, type SectionName } from '../spec/sections';
import { gatePasses, mandatoryCriticalIssues } from './rules';
import { computeReadinessScore } from './score';
import type { SectionStatus, SectionStatuses } from './types';

function all(status: SectionStatus): SectionStatuses {
  const out = {} as SectionStatuses;
  for (const n of SECTION_NAMES) out[n] = status;
  return out;
}

describe('computeReadinessScore', () => {
  it('scores 100 / 0 / 98 for the basic cases', () => {
    expect(computeReadinessScore(all('complete'))).toBe(100);
    expect(computeReadinessScore(all('missing'))).toBe(0);
    expect(computeReadinessScore({ ...all('complete'), Scope: 'partial' })).toBe(98);
  });

  it('applies custom weights', () => {
    const s = { ...all('complete'), Security: 'missing' as const };
    expect(computeReadinessScore(s, { Security: 3 })).toBe(90);
  });

  it('throws on unknown sections and non-positive weights', () => {
    expect(() => computeReadinessScore(all('complete'), { Nope: 1 } as never)).toThrow();
    expect(() => computeReadinessScore(all('complete'), { Scope: 0 })).toThrow();
    expect(() => computeReadinessScore(all('complete'), { Scope: -1 })).toThrow();
  });
});

describe('mandatoryCriticalIssues', () => {
  it('returns one critical issue per missing core section only', () => {
    const s: SectionStatuses = {
      ...all('complete'),
      Scope: 'missing',
      'Technical Design': 'missing',
      Security: 'missing',
      Monitoring: 'missing',
      'Problem Statement': 'partial',
    };
    const issues = mandatoryCriticalIssues(s);
    expect(issues.map((i) => i.section).sort()).toEqual(['Scope', 'Technical Design'] as SectionName[]);
    for (const i of issues) {
      expect(i.severity).toBe('critical');
      expect(i.description).toBe(`${i.section} is missing`);
    }
    expect(mandatoryCriticalIssues({ ...all('complete'), Security: 'missing' })).toEqual([]);
  });
});

describe('gatePasses', () => {
  it('fails on an open critical, passes when resolved or only warnings', () => {
    const crit = { severity: 'critical', status: 'open' } as const;
    expect(gatePasses([crit])).toBe(false);
    expect(gatePasses([{ ...crit, status: 'resolved' }])).toBe(true);
    expect(gatePasses([{ severity: 'warning', status: 'open' }])).toBe(true);
    expect(gatePasses([])).toBe(true);
  });
});
