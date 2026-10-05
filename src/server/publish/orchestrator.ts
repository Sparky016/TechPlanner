import { recordAudit } from '@/server/audit/audit';
import { getSiteUrl } from '@/server/atlassian/jira';
import type { CurrentUser } from '@/server/auth/session';
import { ReauthRequiredError } from '@/server/auth/tokens';
import { query, withTransaction } from '@/server/db/pool';
import { JOB_NAMES } from '@/server/jobs/names';
import { enqueue } from '@/server/jobs/queue';
import { logger } from '@/server/observability/logger';
import {
  countPublish,
  countPublishStepFailure,
  observeReadinessScoreAtPublish,
} from '@/server/observability/metrics';
import { evaluateSession } from '@/server/readiness/evaluate';
import { createRevision, getRevision } from '@/server/revisions/revisions';
import { isUuid } from '@/server/sessions/repo';
import { loadCurrentSnapshots } from '@/server/sessions/sources';
import { flushEditAudits } from '@/server/spec/editAudit';
import { renderPublishedMarkdown } from './render';
import { confluenceStep } from './steps/confluenceStep';
import { downstreamStep } from './steps/downstreamStep';
import { jiraAttachStep, jiraCommentStep, jiraDescriptionStep, jiraLabelStep } from './steps/jiraSteps';
import type { PublishContext, PublishStep, PublishStepName, StepResult } from './types';

// Server-only: never import from src/lib or client components.
// Publish orchestration (FR-13, FR-9): the request path runs the mandatory evaluation, the gate/Override check and
// creates the published Revision and publish_run; the worker executes the external steps with per-step state
// persisted after every transition; failed runs are retried step by step. Successful steps never re-run.

export const MIN_OVERRIDE_JUSTIFICATION_LENGTH = 20;

export type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'waiting' | 'cancelled';
export type RunStatus = 'running' | 'completed' | 'failed';
export type ConfluenceAction = 'overwrite' | 'cancel';

export interface StepState {
  name: PublishStepName;
  status: StepStatus;
  attempts: number;
  lastError: { code: string; message: string } | null;
  result: Record<string, unknown> | null;
}

export interface PublishRun {
  id: string;
  sessionId: string;
  revisionNumber: number;
  status: RunStatus;
  overrideJustification: string | null;
  steps: StepState[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OpenCriticalIssue {
  id: string;
  section: string;
  description: string;
}

export interface StartPublishInput {
  sessionId: string;
  primaryTicketKey: string;
  ticketKeys: string[];
  user: CurrentUser;
  correlationId?: string | null;
  overrideJustification?: string;
  confirmOverride?: boolean;
}

export type StartPublishResult =
  | { kind: 'started'; runId: string; revisionNumber: number }
  | { kind: 'gate_failed'; openCriticalIssues: OpenCriticalIssue[] };

export type RetryResult = { kind: 'retried'; runId: string } | { kind: 'not_found' } | { kind: 'not_retryable' };

// SR-13.2 order. Execution is sequential in this order; description and comment embed the Confluence URL, so they
// wait for the confluence step, and downstream fires only once all five others have succeeded.
const STEPS: readonly PublishStep[] = [
  confluenceStep,
  jiraAttachStep,
  jiraDescriptionStep,
  jiraCommentStep,
  jiraLabelStep,
  downstreamStep,
];
const NEEDS_CONFLUENCE = new Set<PublishStepName>(['jira_description', 'jira_comment']);

interface RunRow {
  id: string;
  session_id: string;
  revision_number: number;
  override_justification: string | null;
  steps: StepState[];
  status: RunStatus;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

function projectOf(ticketKey: string): string {
  return ticketKey.split('-')[0] ?? ticketKey;
}

function initialSteps(): StepState[] {
  return STEPS.map((s) => ({ name: s.name, status: 'pending', attempts: 0, lastError: null, result: null }));
}

function toRun(row: RunRow): PublishRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    revisionNumber: row.revision_number,
    status: row.status,
    overrideJustification: row.override_justification,
    steps: row.steps,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function loadRunRow(runId: string): Promise<RunRow | null> {
  if (!isUuid(runId)) return null;
  const rows = await query<RunRow>('SELECT * FROM publish_run WHERE id = $1', [runId]);
  return rows[0] ?? null;
}

/** The run with its step states, or null when it does not exist or belongs to another session. */
export async function getRun(sessionId: string, runId: string): Promise<PublishRun | null> {
  const row = await loadRunRow(runId);
  return row && row.session_id === sessionId ? toRun(row) : null;
}

/**
 * SR-13.1: flush edit audits, run the mandatory evaluation, enforce the gate (SR-9.1) or record the Override
 * (SR-9.2), then create the published Revision and the publish_run and queue the worker. The Override is stored on
 * this run only (SR-9.3).
 */
export async function startPublish(input: StartPublishInput): Promise<StartPublishResult> {
  const { user, sessionId } = input;
  const correlationId = input.correlationId ?? null;
  await flushEditAudits(sessionId, { user, ticketIds: input.ticketKeys, correlationId });

  const evaluation = await evaluateSession(sessionId, {
    userId: user.accountId,
    userDisplayName: user.displayName,
    correlationId,
  });

  let overrideJustification: string | null = null;
  let openCriticalIssues: OpenCriticalIssue[] = [];
  if (!evaluation.gatePasses) {
    openCriticalIssues = evaluation.issues
      .filter((i) => i.severity === 'critical' && i.status === 'open')
      .map((i) => ({ id: i.id, section: i.section, description: i.description }));
    const justification = input.overrideJustification?.trim() ?? '';
    if (input.confirmOverride !== true || justification.length < MIN_OVERRIDE_JUSTIFICATION_LENGTH) {
      return { kind: 'gate_failed', openCriticalIssues };
    }
    overrideJustification = justification;
  }

  const audit = { userId: user.accountId, userDisplayName: user.displayName, sessionId, ticketIds: input.ticketKeys };
  const { runId, revisionNumber } = await withTransaction(async (client) => {
    const rev = await createRevision(client, {
      sessionId,
      trigger: 'publish',
      authorId: user.accountId,
      published: true,
    });
    // Audit after the session row lock (taken by createRevision), matching the lock order of other chain writers.
    if (overrideJustification !== null) {
      await recordAudit(
        {
          ...audit,
          action: 'readiness.override',
          result: 'success',
          correlationId,
          details: { justification: overrideJustification, openCriticalIssues },
        },
        client,
      );
    }
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO publish_run (session_id, revision_number, override_justification, steps, status, created_by)
       VALUES ($1, $2, $3, $4, 'running', $5) RETURNING id`,
      [sessionId, rev.number, overrideJustification, JSON.stringify(initialSteps()), user.accountId],
    );
    const id = rows[0].id;
    await recordAudit(
      {
        ...audit,
        action: 'publish.started',
        result: 'success',
        correlationId: id,
        details: {
          runId: id,
          revision: rev.number,
          readinessScore: evaluation.score,
          override: overrideJustification !== null,
        },
      },
      client,
    );
    return { runId: id, revisionNumber: rev.number };
  });

  countPublish(projectOf(input.primaryTicketKey), overrideJustification !== null);
  observeReadinessScoreAtPublish(evaluation.score);

  await enqueueRun(runId, {});
  return { kind: 'started', runId, revisionNumber };
}

// pg-boss cannot join the publish transaction, so the job is queued after commit. If queueing fails the run is
// marked failed (its steps stay pending) so that Retry can pick it up.
async function enqueueRun(runId: string, options: { confluenceAction?: ConfluenceAction }): Promise<void> {
  try {
    await enqueue(JOB_NAMES.publishRun, { runId, ...(options.confluenceAction ? { options } : {}) });
  } catch (err) {
    await query("UPDATE publish_run SET status = 'failed', updated_at = now() WHERE id = $1", [runId]);
    throw err;
  }
}

/**
 * Re-runs every step of a failed run that has not succeeded (failed, waiting, cancelled or still pending), passing
 * the Confluence overwrite/cancel choice through to the confluence step. Successful steps are never re-run.
 */
export async function retryRun(
  sessionId: string,
  runId: string,
  options: { confluenceAction?: ConfluenceAction } = {},
): Promise<RetryResult> {
  if (!isUuid(runId)) return { kind: 'not_found' };
  const outcome = await withTransaction(async (client): Promise<RetryResult> => {
    const { rows } = await client.query<{ session_id: string; status: RunStatus }>(
      'SELECT session_id, status FROM publish_run WHERE id = $1 FOR UPDATE',
      [runId],
    );
    if (!rows[0] || rows[0].session_id !== sessionId) return { kind: 'not_found' };
    if (rows[0].status !== 'failed') return { kind: 'not_retryable' };
    await client.query("UPDATE publish_run SET status = 'running', updated_at = now() WHERE id = $1", [runId]);
    return { kind: 'retried', runId };
  });
  if (outcome.kind === 'retried') await enqueueRun(runId, options);
  return outcome;
}

type BaseContext = Omit<PublishContext, 'confluencePageUrl' | 'previousResult'>;

async function buildContext(run: RunRow, options: { confluenceAction?: ConfluenceAction }): Promise<BaseContext> {
  const sessions = await query<{
    primary_ticket_key: string;
    ticket_keys: string[];
    facilitator_name: string | null;
  }>(
    `SELECT s.primary_ticket_key, s.ticket_keys, u.display_name AS facilitator_name
       FROM planning_session s LEFT JOIN app_user u ON u.atlassian_account_id = s.facilitator_id
      WHERE s.id = $1`,
    [run.session_id],
  );
  const session = sessions[0];
  if (!session) throw new Error(`Session ${run.session_id} not found for publish run ${run.id}`);

  const publisherId = run.created_by ?? '';
  const publishers = await query<{ display_name: string }>(
    'SELECT display_name FROM app_user WHERE atlassian_account_id = $1',
    [publisherId],
  );
  const facilitator = { accountId: publisherId, displayName: publishers[0]?.display_name ?? publisherId };

  const revision = await getRevision(run.session_id, run.revision_number);
  if (!revision) throw new Error(`Revision ${run.revision_number} not found for publish run ${run.id}`);
  const readinessScore = revision.readinessScore ?? 0;

  const issues = new Map(
    (await loadCurrentSnapshots(run.session_id)).filter((s) => s.kind === 'jira_issue').map((s) => [s.ref, s]),
  );
  const primary = session.primary_ticket_key;
  const summary = issues.get(primary)?.title || primary;

  let siteUrl: string | null = null;
  const tickets: { key: string; url: string }[] = [];
  for (const key of session.ticket_keys) {
    const known = issues.get(key)?.detail.url;
    if (typeof known === 'string' && known !== '') {
      tickets.push({ key, url: known });
      continue;
    }
    siteUrl ??= await getSiteUrl(publisherId);
    tickets.push({ key, url: `${siteUrl}/browse/${key}` });
  }

  const markdown = renderPublishedMarkdown({
    sections: revision.sections,
    header: {
      title: `${primary}: ${summary} — Technical Specification`,
      tickets,
      facilitator: session.facilitator_name ?? facilitator.displayName,
      sessionId: run.session_id,
      revision: run.revision_number,
      readinessScore,
      overrideJustification: run.override_justification,
    },
  });

  return {
    runId: run.id,
    sessionId: run.session_id,
    ticketKeys: session.ticket_keys,
    primaryTicketKey: primary,
    facilitator,
    revisionNumber: run.revision_number,
    readinessScore,
    overrideJustification: run.override_justification,
    markdown,
    // The confluence step builds the page title from the primary ticket's summary.
    title: summary,
    options,
  };
}

async function persistSteps(runId: string, steps: StepState[]): Promise<void> {
  await query('UPDATE publish_run SET steps = $2, updated_at = now() WHERE id = $1', [runId, JSON.stringify(steps)]);
}

// Step errors never escape the worker: ReauthRequiredError (propagated by the Jira steps) and unexpected errors
// become a failed step so the run can be finalised and retried after the user signs in again.
async function invoke(step: PublishStep, ctx: PublishContext): Promise<StepResult> {
  try {
    return await step.run(ctx);
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      return { status: 'failed', error: { code: err.code, message: err.message } };
    }
    logger.error({ err, runId: ctx.runId, step: step.name }, 'publish step threw');
    return { status: 'failed', error: { code: 'internal_error', message: 'Unexpected error in publish step' } };
  }
}

function confluenceUrl(steps: StepState[]): string | null {
  const c = steps.find((s) => s.name === 'confluence');
  const url = c?.status === 'success' ? c.result?.url : null;
  return typeof url === 'string' && url !== '' ? url : null;
}

/** Worker entry point (JOB_NAMES.publishRun): runs every non-successful step in order, then finalises the run. */
export async function executeRun(
  runId: string,
  options: { confluenceAction?: ConfluenceAction } = {},
): Promise<PublishRun | null> {
  const run = await loadRunRow(runId);
  if (!run) return null;
  // Redelivered job for a run that has already been finalised.
  if (run.status !== 'running') return toRun(run);

  const steps = run.steps.map((s) => ({ ...s }));
  let base: BaseContext;
  try {
    base = await buildContext(run, options);
  } catch (err) {
    // Without a context no step can run; fail the run (steps untouched) so it is visible and retryable.
    logger.error({ err, runId }, 'failed to build publish context');
    return finalize(run, null, steps);
  }

  for (const step of STEPS) {
    const state = steps.find((s) => s.name === step.name);
    if (!state || state.status === 'success') continue;

    if (NEEDS_CONFLUENCE.has(step.name) && confluenceUrl(steps) === null) {
      state.status = 'waiting';
      await persistSteps(runId, steps);
      continue;
    }
    if (step.name === 'downstream' && steps.some((s) => s.name !== 'downstream' && s.status !== 'success')) {
      state.status = 'pending';
      await persistSteps(runId, steps);
      continue;
    }

    state.status = 'running';
    state.attempts += 1;
    await persistSteps(runId, steps);

    const outcome = await invoke(step, { ...base, confluencePageUrl: confluenceUrl(steps), previousResult: state.result });
    state.status = outcome.status;
    state.result = outcome.result ?? state.result;
    state.lastError =
      outcome.status === 'success' ? null : (outcome.error ?? { code: outcome.status, message: `Step ${outcome.status}` });
    if (outcome.status !== 'success') countPublishStepFailure(step.name);
    await persistSteps(runId, steps);
  }

  return finalize(run, base, steps);
}

async function finalize(run: RunRow, base: BaseContext | null, steps: StepState[]): Promise<PublishRun> {
  const completed = steps.every((s) => s.status === 'success');
  const failedSteps = steps.filter((s) => s.status !== 'success').map((s) => s.name);
  const row = await withTransaction(async (client) => {
    const { rows } = await client.query<RunRow>(
      'UPDATE publish_run SET status = $2, steps = $3, updated_at = now() WHERE id = $1 RETURNING *',
      [run.id, completed ? 'completed' : 'failed', JSON.stringify(steps)],
    );
    await client.query('UPDATE planning_session SET status = $2, updated_at = now() WHERE id = $1', [
      run.session_id,
      completed ? 'published' : 'partially_published',
    ]);
    await recordAudit(
      {
        action: completed ? 'publish.completed' : 'publish.failed',
        result: completed ? 'success' : 'failure',
        userId: base?.facilitator.accountId ?? run.created_by,
        userDisplayName: base?.facilitator.displayName ?? null,
        sessionId: run.session_id,
        ticketIds: base?.ticketKeys ?? [],
        correlationId: run.id,
        details: completed
          ? { runId: run.id, revision: run.revision_number }
          : { runId: run.id, revision: run.revision_number, failedSteps },
      },
      client,
    );
    return rows[0];
  });
  return toRun(row);
}
