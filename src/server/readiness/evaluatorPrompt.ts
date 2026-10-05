import { SECTION_NAMES, type SectionName } from '../../lib/spec/sections';
import type { SpecSections } from '../../lib/spec/document';
import type { IssueSeverity, IssueStatus } from '../../lib/readiness/types';

// Server-only: never import from src/lib or client components.
// Readiness evaluator rubric (SR-6.4, PRD §10, SR-7.2, SR-7.3, SR-3.3, SR-5.2). The evaluator runs stateless (LLM-4):
// it sees only the rendered Working Copy and the current issues, never the facilitation conversation.

export const EVALUATOR_SYSTEM_PROMPT = `You are the readiness evaluator for a technical specification. You did not take part in writing it; judge only the document you are given.

Definition of ready: a developer unfamiliar with the project can complete the work without clarification.

For EVERY one of the ${SECTION_NAMES.length} sections call report_section_status exactly once with:
- complete: the section fully meets the definition of ready for its subject;
- partial: the section has relevant content but gaps remain;
- missing: the section is empty or has no usable content.
Give a one-line reason (at most 200 characters).

Rubric. Check that:
- the problem is clearly defined;
- scope is explicitly documented;
- requirements are measurable;
- edge cases are documented;
- dependencies are identified;
- assumptions are recorded;
- security is addressed;
- performance expectations are defined;
- monitoring is specified;
- logging is specified;
- the testing strategy is documented;
- the rollback strategy is documented;
- acceptance criteria are measurable;
- risks are documented;
- outstanding questions are identified or resolved.

Vague statements (no quantity, owner, condition or acceptance test where one is needed, e.g. "should be fast", "handle errors properly") never make a section complete.
A section containing an explicit "Not applicable — <reason>" statement with a credible reason may be complete.

Call raise_issue for each gap (description at most 300 characters), with severity:
- critical: implementation cannot reasonably begin;
- warning: implementation can proceed with risk;
- informational: an improvement is suggested.
Always raise as critical: any acceptance criterion that is not measurable or testable, and any unresolved contradiction between sections.

When a currently open issue still applies, raise it again with exactly the same section and description so it keeps its identity. Do not raise an issue that the document now resolves.
Do not write prose; use only the tools.`;

export interface PromptIssue {
  severity: IssueSeverity;
  section: SectionName;
  description: string;
  status: IssueStatus;
}

const EMPTY_BODY = '_Not yet specified._';

/** The single user message of an evaluation run: the Working Copy plus the currently open/accepted-risk issues. */
export function buildEvaluatorMessage(sections: SpecSections, currentIssues: readonly PromptIssue[]): string {
  const lines: string[] = ['# Specification under evaluation'];
  for (const name of SECTION_NAMES) {
    const body = sections[name].trim();
    lines.push('', `## ${name}`, '', body === '' ? EMPTY_BODY : body);
  }
  lines.push('', '# Currently open issues');
  if (currentIssues.length === 0) lines.push('', 'None.');
  else {
    lines.push('');
    for (const i of currentIssues) {
      lines.push(`- [${i.severity}] [${i.section}]${i.status === 'accepted-risk' ? ' (accepted risk)' : ''} ${i.description}`);
    }
  }
  return lines.join('\n');
}

/** Appended for the single corrective follow-up when sections were not reported. */
export function buildCorrectiveMessage(unreported: readonly SectionName[]): string {
  return [
    'You did not report a status for these sections:',
    ...unreported.map((s) => `- ${s}`),
    'Call report_section_status once for each of them now. Raise any further issues with raise_issue.',
  ].join('\n');
}
