import type { SectionName } from '../spec/sections';
import type { ReadinessIssue, SectionStatuses } from './types';

const CORE_SECTIONS: readonly SectionName[] = [
  'Problem Statement',
  'Scope',
  'Functional Requirements',
  'Technical Design',
  'Acceptance Criteria',
];

/** SR-7.3 deterministic subset: a missing core section is always Critical. */
export function mandatoryCriticalIssues(statuses: SectionStatuses): ReadinessIssue[] {
  return CORE_SECTIONS.filter((section) => statuses[section] === 'missing').map((section) => ({
    severity: 'critical',
    section,
    description: `${section} is missing`,
    status: 'open',
  }));
}

/** D-6: gate passes iff no open Critical issue; the score is informational only. */
export function gatePasses(issues: readonly Pick<ReadinessIssue, 'severity' | 'status'>[]): boolean {
  return !issues.some((i) => i.severity === 'critical' && i.status === 'open');
}
