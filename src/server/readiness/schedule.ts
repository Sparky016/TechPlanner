import { query } from '@/server/db/pool';
import { enqueue } from '@/server/jobs/queue';
import { JOB_NAMES } from '@/server/jobs/names';

// Server-only: never import from src/lib or client components.
// Debounce (SR-6.2): at most one queued evaluation per session, started 20 s after the first request.

export const EVALUATION_DEBOUNCE_SECONDS = 20;

/** Queues a debounced readiness evaluation. Returns false when one is already queued for the session. */
export async function scheduleEvaluation(sessionId: string): Promise<boolean> {
  const id = await enqueue(
    JOB_NAMES.readinessEvaluate,
    { sessionId },
    { singletonKey: sessionId, startAfter: EVALUATION_DEBOUNCE_SECONDS },
  );
  return id !== null;
}

/** True while a queued, retrying or active evaluation job exists for the session. */
export async function isEvaluationPending(sessionId: string): Promise<boolean> {
  // The pg-boss schema is created lazily by the first queue start.
  const [exists] = await query<{ present: boolean }>("SELECT to_regclass('pgboss.job') IS NOT NULL AS present");
  if (!exists?.present) return false;
  const rows = await query(
    `SELECT 1 FROM pgboss.job
     WHERE name = $1 AND singleton_key = $2 AND state IN ('created', 'retry', 'active') LIMIT 1`,
    [JOB_NAMES.readinessEvaluate, sessionId],
  );
  return rows.length > 0;
}
