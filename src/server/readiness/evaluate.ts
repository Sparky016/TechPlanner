import type { PoolClient } from 'pg';
import { recordAudit } from '@/server/audit/audit';
import { getConfig } from '@/server/config';
import { query, withTransaction } from '@/server/db/pool';
import { getLlmClient } from '@/server/llm';
import { observeReadinessScore } from '@/server/observability/metrics';
import { SECTION_NAMES, type SectionName } from '../../lib/spec/sections';
import type { SpecSections } from '../../lib/spec/document';
import { gatePasses, mandatoryCriticalIssues } from '../../lib/readiness/rules';
import { computeReadinessScore } from '../../lib/readiness/score';
import type { IssueSeverity, SectionStatuses } from '../../lib/readiness/types';
import { getWorkingCopy, WorkingCopyNotFoundError } from '../spec/workingCopyRepo';
import { buildCorrectiveMessage, buildEvaluatorMessage, EVALUATOR_SYSTEM_PROMPT } from './evaluatorPrompt';
import {
  createEvaluatorCollector,
  createEvaluatorTools,
  type EvaluatorCollector,
  type SectionEvaluation,
} from './evaluatorTools';
import { reconcileIssues, type ExistingIssue, type ReportedIssue } from './reconcile';

// Server-only: never import from src/lib or client components.
// Readiness evaluation (FR-6/FR-7): one stateless evaluator run per evaluation (LLM-4), merged with the
// deterministic critical rules (SR-7.3), reconciled against existing issues (SR-7.4), scored (SR-6.3),
// persisted and audited (SR-6.6) in one transaction.

export const NOT_EVALUATED_REASON = 'Not evaluated';

export interface EvaluationIssue {
  id: string;
  severity: IssueSeverity;
  section: SectionName;
  description: string;
  fingerprint: string;
  status: 'open' | 'accepted-risk';
}

export interface EvaluationResult {
  evaluationId: string;
  score: number;
  statuses: Record<SectionName, SectionEvaluation>;
  /** Current issues after reconciliation: open and accepted-risk. */
  issues: EvaluationIssue[];
  gatePasses: boolean;
}

export interface EvaluateOptions {
  userId: string;
  userDisplayName?: string | null;
  correlationId?: string | null;
  signal?: AbortSignal;
}

export class EvaluatorRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(`Evaluator run failed (${code}): ${message}`);
    this.name = 'EvaluatorRunError';
  }
}

type IssueRow = ExistingIssue;

const SELECT_ISSUES =
  'SELECT id, severity, section, description, fingerprint, status FROM issue WHERE session_id = $1 ORDER BY created_at, id';

async function runOnce(content: string, collector: EvaluatorCollector, signal?: AbortSignal): Promise<void> {
  const events = getLlmClient().run({
    kind: 'evaluator',
    model: getConfig().EVALUATOR_MODEL,
    system: EVALUATOR_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
    tools: createEvaluatorTools(collector),
    signal,
  });
  for await (const event of events) {
    if (event.type === 'error') throw new EvaluatorRunError(event.code, event.message, event.retryable);
    if (event.type === 'done') return;
  }
}

function unreported(collector: EvaluatorCollector): SectionName[] {
  return SECTION_NAMES.filter((n) => !collector.statuses.has(n));
}

/** Runs the evaluator, with one corrective follow-up for unreported sections; still-unreported ones become missing. */
async function assess(
  sections: SpecSections,
  current: readonly IssueRow[],
  signal?: AbortSignal,
): Promise<{ statuses: Record<SectionName, SectionEvaluation>; reported: ReportedIssue[] }> {
  const collector = createEvaluatorCollector();
  const message = buildEvaluatorMessage(sections, current);
  await runOnce(message, collector, signal);
  const missing = unreported(collector);
  if (missing.length > 0) await runOnce(`${message}\n\n${buildCorrectiveMessage(missing)}`, collector, signal);

  const statuses = {} as Record<SectionName, SectionEvaluation>;
  for (const name of SECTION_NAMES) {
    statuses[name] = collector.statuses.get(name) ?? { status: 'missing', reason: NOT_EVALUATED_REASON };
  }
  const plain = statusOnly(statuses);
  // Issues = LLM issues ∪ deterministic critical rules; duplicates collapse in reconcileIssues.
  const reported: ReportedIssue[] = [
    ...collector.issues,
    ...mandatoryCriticalIssues(plain).map(({ severity, section, description }) => ({ severity, section, description })),
  ];
  return { statuses, reported };
}

function statusOnly(statuses: Record<SectionName, SectionEvaluation>): SectionStatuses {
  const out = {} as SectionStatuses;
  for (const name of SECTION_NAMES) out[name] = statuses[name].status;
  return out;
}

function bodies(sections: Record<SectionName, { body: string }>): SpecSections {
  const out = {} as SpecSections;
  for (const name of SECTION_NAMES) out[name] = sections[name]?.body ?? '';
  return out;
}

async function applyReconciliation(
  client: PoolClient,
  sessionId: string,
  reported: readonly ReportedIssue[],
): Promise<EvaluationIssue[]> {
  const existing = await client.query<IssueRow>(`${SELECT_ISSUES} FOR UPDATE`, [sessionId]);
  const changes = reconcileIssues(existing.rows, reported);
  const current: EvaluationIssue[] = [];

  for (const i of changes.keep) {
    await client.query('UPDATE issue SET severity = $2, status = $3 WHERE id = $1', [i.id, i.severity, i.status]);
    current.push(toResultIssue(i));
  }
  for (const i of changes.reopen) {
    await client.query("UPDATE issue SET severity = $2, status = 'open', resolved_at = NULL WHERE id = $1", [
      i.id,
      i.severity,
    ]);
    current.push(toResultIssue(i));
  }
  for (const i of changes.resolve) {
    await client.query("UPDATE issue SET status = 'resolved', resolved_at = now() WHERE id = $1", [i.id]);
  }
  for (const i of changes.insert) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO issue (session_id, severity, section, description, fingerprint, status)
       VALUES ($1, $2, $3, $4, $5, 'open') RETURNING id`,
      [sessionId, i.severity, i.section, i.description, i.fingerprint],
    );
    current.push({ id: rows[0].id, ...i, status: 'open' });
  }
  // Accepted-risk issues that were not reported again are left untouched but remain current.
  const touched = new Set(current.map((i) => i.id));
  for (const i of existing.rows) {
    if (i.status === 'accepted-risk' && !touched.has(i.id)) current.push(toResultIssue({ ...i, status: 'accepted-risk' }));
  }
  return current;
}

function toResultIssue(i: ExistingIssue & { status: 'open' | 'accepted-risk' }): EvaluationIssue {
  return {
    id: i.id,
    severity: i.severity,
    section: i.section,
    description: i.description,
    fingerprint: i.fingerprint,
    status: i.status,
  };
}

function countBySeverity(issues: readonly EvaluationIssue[]): Record<IssueSeverity, number> {
  const counts: Record<IssueSeverity, number> = { critical: 0, warning: 0, informational: 0 };
  for (const i of issues) counts[i.severity]++;
  return counts;
}

export async function evaluateSession(sessionId: string, opts: EvaluateOptions): Promise<EvaluationResult> {
  const wc = await getWorkingCopy(sessionId);
  if (!wc) throw new WorkingCopyNotFoundError(sessionId);

  const before = await query<IssueRow>(SELECT_ISSUES, [sessionId]);
  const current = before.filter((i) => i.status !== 'resolved');
  const { statuses, reported } = await assess(bodies(wc.sections), current, opts.signal);

  const plain = statusOnly(statuses);
  const weights = (getConfig().SECTION_WEIGHTS ?? {}) as Partial<Record<SectionName, number>>;
  const score = computeReadinessScore(plain, weights);

  const result = await withTransaction(async (client) => {
    // Serialises concurrent evaluations of one session (the issue fingerprint is unique per session).
    await client.query('SELECT id FROM planning_session WHERE id = $1 FOR UPDATE', [sessionId]);
    const issues = await applyReconciliation(client, sessionId, reported);
    const { rows } = await client.query<{ id: string }>(
      'INSERT INTO evaluation (session_id, section_statuses, score) VALUES ($1, $2, $3) RETURNING id',
      [sessionId, JSON.stringify(statuses), score],
    );
    const evaluationId = rows[0].id;
    const passes = gatePasses(issues);
    await recordAudit(
      {
        action: 'readiness.evaluated',
        result: 'success',
        userId: opts.userId,
        userDisplayName: opts.userDisplayName ?? null,
        sessionId,
        correlationId: opts.correlationId ?? null,
        details: { evaluationId, score, statuses: plain, counts: countBySeverity(issues), gatePasses: passes },
      },
      client,
    );
    return { evaluationId, score, statuses, issues, gatePasses: passes };
  });

  observeReadinessScore(score);
  return result;
}
