// Audit event names: every SR-12.1 event type, plus events other SRs require auditing that SR-12.1 does not name
// (refresh failure, question dismissal, accepted risk, lock take-over) and the guided intake events (spec §8.4).
// question.dismissed is no longer emitted but stays for historical records.

export const AUDIT_ACTIONS = [
  // SR-12.1
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
  // Additional events
  'auth.refresh_failed',
  'question.dismissed',
  'issue.accepted_risk',
  'session.lock_taken_over',
  // Guided intake (docs/specs/guided-intake-and-question-answering.md §8.4)
  'sources.ingested',
  'question.answered',
  'question.resolved',
  'question.reopened',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
