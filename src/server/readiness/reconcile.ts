import type { SectionName } from '../../lib/spec/sections';
import type { IssueSeverity, IssueStatus } from '../../lib/readiness/types';
import { issueFingerprint } from './fingerprint';

// Server-only: never import from src/lib or client components.
// SR-7.4 issue reconciliation: pure, no I/O. The caller applies the result to the issue table.

export interface ExistingIssue {
  id: string;
  severity: IssueSeverity;
  section: SectionName;
  description: string;
  fingerprint: string;
  status: IssueStatus;
}

export interface ReportedIssue {
  severity: IssueSeverity;
  section: SectionName;
  description: string;
}

/** An existing issue that stays current (open or accepted-risk), with its severity/status after this evaluation. */
export interface KeptIssue extends ExistingIssue {
  status: 'open' | 'accepted-risk';
}

export interface NewIssue extends ReportedIssue {
  fingerprint: string;
}

export interface ReconcileResult {
  /** Reported again and still current. Description is the existing wording; severity is the reported one. */
  keep: KeptIssue[];
  /** Reported for the first time: insert as open. */
  insert: NewIssue[];
  /** Open but no longer reported: mark resolved. */
  resolve: ExistingIssue[];
  /** Resolved earlier and reported again: set open (resolved_at cleared) with the reported severity. */
  reopen: KeptIssue[];
}

const SEVERITY_RANK: Record<IssueSeverity, number> = { informational: 0, warning: 1, critical: 2 };

/** Collapses reported issues sharing a fingerprint; the highest severity wins, the first wording is kept. */
function dedupe(reported: readonly ReportedIssue[]): Map<string, NewIssue> {
  const out = new Map<string, NewIssue>();
  for (const r of reported) {
    const fingerprint = issueFingerprint(r.section, r.description);
    const prev = out.get(fingerprint);
    if (!prev) out.set(fingerprint, { ...r, fingerprint });
    else if (SEVERITY_RANK[r.severity] > SEVERITY_RANK[prev.severity]) prev.severity = r.severity;
  }
  return out;
}

/**
 * Matches by fingerprint (Section + normalized description):
 * - reported & existing open -> keep (severity updated to the reported one)
 * - reported & existing accepted-risk -> keep as accepted-risk, unless now critical -> open
 * - reported & new -> insert open
 * - existing open not reported -> resolve
 * - existing resolved & reported -> reopen
 * Existing accepted-risk or resolved issues that are not reported are left untouched.
 */
export function reconcileIssues(
  existing: readonly ExistingIssue[],
  reported: readonly ReportedIssue[],
): ReconcileResult {
  const result: ReconcileResult = { keep: [], insert: [], resolve: [], reopen: [] };
  const byFingerprint = dedupe(reported);
  const seen = new Set<string>();

  for (const issue of existing) {
    const match = byFingerprint.get(issue.fingerprint);
    if (match) seen.add(issue.fingerprint);
    if (issue.status === 'open') {
      if (match) result.keep.push({ ...issue, severity: match.severity, status: 'open' });
      else result.resolve.push(issue);
    } else if (issue.status === 'accepted-risk') {
      if (!match) continue;
      const status = match.severity === 'critical' ? 'open' : 'accepted-risk';
      result.keep.push({ ...issue, severity: match.severity, status });
    } else if (match) {
      result.reopen.push({ ...issue, severity: match.severity, status: 'open' });
    }
  }

  for (const [fingerprint, issue] of byFingerprint) {
    if (!seen.has(fingerprint)) result.insert.push(issue);
  }
  return result;
}
