import { describe, expect, it } from 'vitest';
import type { SectionName } from '../../lib/spec/sections';
import type { IssueSeverity, IssueStatus } from '../../lib/readiness/types';
import { issueFingerprint } from './fingerprint';
import { reconcileIssues, type ExistingIssue } from './reconcile';

function existing(
  id: string,
  section: SectionName,
  description: string,
  status: IssueStatus,
  severity: IssueSeverity = 'warning',
): ExistingIssue {
  return { id, section, description, status, severity, fingerprint: issueFingerprint(section, description) };
}

describe('reconcileIssues', () => {
  it('keeps a reported open issue, matching despite re-worded punctuation and case', () => {
    const e = existing('1', 'Security', 'No auth model defined.', 'open');
    const r = reconcileIssues([e], [{ severity: 'critical', section: 'Security', description: 'no AUTH model defined' }]);
    expect(r.keep).toEqual([{ ...e, severity: 'critical', status: 'open' }]);
    expect(r.insert).toEqual([]);
    expect(r.resolve).toEqual([]);
    expect(r.reopen).toEqual([]);
  });

  it('inserts a newly reported issue as new with its fingerprint', () => {
    const r = reconcileIssues([], [{ severity: 'warning', section: 'Logging', description: 'No log levels' }]);
    expect(r.insert).toEqual([
      {
        severity: 'warning',
        section: 'Logging',
        description: 'No log levels',
        fingerprint: issueFingerprint('Logging', 'No log levels'),
      },
    ]);
  });

  it('resolves an open issue that is no longer reported', () => {
    const e = existing('1', 'Risks', 'Risks not listed', 'open');
    expect(reconcileIssues([e], []).resolve).toEqual([e]);
  });

  it('reopens a resolved issue that is reported again, with the reported severity', () => {
    const e = existing('1', 'Scope', 'Scope is missing', 'resolved', 'warning');
    const r = reconcileIssues([e], [{ severity: 'critical', section: 'Scope', description: 'Scope is missing' }]);
    expect(r.reopen).toEqual([{ ...e, severity: 'critical', status: 'open' }]);
    expect(r.insert).toEqual([]);
  });

  it('leaves resolved issues that are not reported untouched', () => {
    const r = reconcileIssues([existing('1', 'Scope', 'x', 'resolved')], []);
    expect(r).toEqual({ keep: [], insert: [], resolve: [], reopen: [] });
  });

  it('accepted-risk warnings survive re-evaluation, reported or not', () => {
    const a = existing('1', 'Performance', 'No latency target', 'accepted-risk');
    const b = existing('2', 'Monitoring', 'No alert thresholds', 'accepted-risk');
    const r = reconcileIssues([a, b], [{ severity: 'warning', section: 'Performance', description: 'No latency target' }]);
    expect(r.keep).toEqual([{ ...a, status: 'accepted-risk' }]);
    expect(r.resolve).toEqual([]);
    expect(r.reopen).toEqual([]);
    expect(r.insert).toEqual([]);
  });

  it('reopens an accepted-risk issue when it is now critical', () => {
    const a = existing('1', 'Performance', 'No latency target', 'accepted-risk');
    const r = reconcileIssues([a], [{ severity: 'critical', section: 'Performance', description: 'No latency target' }]);
    expect(r.keep).toEqual([{ ...a, severity: 'critical', status: 'open' }]);
  });

  it('collapses duplicate reported issues, highest severity wins', () => {
    const r = reconcileIssues(
      [],
      [
        { severity: 'warning', section: 'Scope', description: 'Scope is missing' },
        { severity: 'critical', section: 'Scope', description: 'scope is missing!' },
      ],
    );
    expect(r.insert).toHaveLength(1);
    expect(r.insert[0]).toMatchObject({ severity: 'critical', description: 'Scope is missing' });
  });

  it('treats the same wording in different sections as different issues', () => {
    const e = existing('1', 'Security', 'Not specified', 'open');
    const r = reconcileIssues([e], [{ severity: 'warning', section: 'Logging', description: 'Not specified' }]);
    expect(r.resolve).toEqual([e]);
    expect(r.insert).toHaveLength(1);
  });
});
