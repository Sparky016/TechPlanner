import { query } from '@/server/db/pool';
import { JOB_NAMES } from '@/server/jobs/names';
import { NonRetryableJobError, registerHandler } from '@/server/jobs/registry';
import { WorkingCopyNotFoundError } from '@/server/spec/workingCopyRepo';
import { evaluateSession } from './evaluate';

// Server-only: never import from src/lib or client components.
// Background evaluation job (task 26). Runs as the session's facilitator for audit attribution.

const SYSTEM_USER = 'system';

export async function handleReadinessEvaluate(data: unknown): Promise<void> {
  const sessionId = (data as { sessionId?: unknown } | null)?.sessionId;
  if (typeof sessionId !== 'string') throw new NonRetryableJobError('readiness.evaluate job has no sessionId');

  const rows = await query<{ facilitator_id: string | null; display_name: string | null }>(
    `SELECT s.facilitator_id, u.display_name FROM planning_session s
     LEFT JOIN app_user u ON u.atlassian_account_id = s.facilitator_id WHERE s.id = $1`,
    [sessionId],
  );
  if (rows.length === 0) throw new NonRetryableJobError(`Session ${sessionId} not found`);

  try {
    await evaluateSession(sessionId, {
      userId: rows[0].facilitator_id ?? SYSTEM_USER,
      userDisplayName: rows[0].display_name,
    });
  } catch (err) {
    if (err instanceof WorkingCopyNotFoundError) throw new NonRetryableJobError(err.message, { cause: err });
    throw err;
  }
}

registerHandler(JOB_NAMES.readinessEvaluate, handleReadinessEvaluate);
