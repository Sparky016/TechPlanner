import type { SectionName } from '../spec/sections';

export type SectionStatus = 'complete' | 'partial' | 'missing';
export type IssueSeverity = 'critical' | 'warning' | 'informational';
export type IssueStatus = 'open' | 'resolved' | 'accepted-risk';

export type SectionStatuses = Record<SectionName, SectionStatus>;

export interface ReadinessIssue {
  severity: IssueSeverity;
  section: SectionName;
  description: string;
  status: IssueStatus;
}
