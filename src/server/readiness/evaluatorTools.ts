import type { LlmToolDefinition } from '@/server/llm';
import { SECTION_NAMES, type SectionName } from '../../lib/spec/sections';
import type { SectionStatus } from '../../lib/readiness/types';
import type { ReportedIssue } from './reconcile';

// Server-only: never import from src/lib or client components.
// Evaluator tools (LLM-5). Arguments are schema-validated by executeToolCall before a handler runs.

export const REASON_MAX = 200;
export const DESCRIPTION_MAX = 300;

export interface SectionEvaluation {
  status: SectionStatus;
  reason: string;
}

/** Collects what the evaluator reports during one or more runs. A later report for a section replaces an earlier one. */
export interface EvaluatorCollector {
  statuses: Map<SectionName, SectionEvaluation>;
  issues: ReportedIssue[];
}

export function createEvaluatorCollector(): EvaluatorCollector {
  return { statuses: new Map(), issues: [] };
}

interface ReportSectionStatusArgs {
  section: SectionName;
  status: SectionStatus;
  reason: string;
}

interface RaiseIssueArgs {
  severity: ReportedIssue['severity'];
  section: SectionName;
  description: string;
}

export function createEvaluatorTools(collector: EvaluatorCollector): LlmToolDefinition[] {
  return [
    {
      name: 'report_section_status',
      description:
        'Report the status of one specification section with a one-line reason. Call exactly once for every section.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'status', 'reason'],
        properties: {
          section: { type: 'string', enum: [...SECTION_NAMES] },
          status: { type: 'string', enum: ['complete', 'partial', 'missing'] },
          reason: { type: 'string', minLength: 1, maxLength: REASON_MAX },
        },
      },
      handler: async (args) => {
        const { section, status, reason } = args as ReportSectionStatusArgs;
        collector.statuses.set(section, { status, reason });
        return `Recorded ${section}: ${status}`;
      },
    },
    {
      name: 'raise_issue',
      description:
        'Raise one readiness issue against a section. Reuse the exact wording of a currently open issue when it still applies.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'section', 'description'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'warning', 'informational'] },
          section: { type: 'string', enum: [...SECTION_NAMES] },
          description: { type: 'string', minLength: 1, maxLength: DESCRIPTION_MAX },
        },
      },
      handler: async (args) => {
        const { severity, section, description } = args as RaiseIssueArgs;
        collector.issues.push({ severity, section, description });
        return `Recorded ${severity} issue on ${section}`;
      },
    },
  ];
}
