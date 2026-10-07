import { JOB_NAMES } from '@/server/jobs/names';
import { NonRetryableJobError, registerHandler } from '@/server/jobs/registry';
import { executeRun, type ConfluenceAction } from './orchestrator';

// Server-only: never import from src/lib or client components.
// Background publish job (task 27): executes a publish_run's external steps. Data: { runId, options? }.

function confluenceActionOf(data: unknown): ConfluenceAction | undefined {
  const action = (data as { options?: { confluenceAction?: unknown } } | null)?.options?.confluenceAction;
  return action === 'overwrite' || action === 'cancel' ? action : undefined;
}

export async function handlePublishRun(data: unknown): Promise<void> {
  const runId = (data as { runId?: unknown } | null)?.runId;
  if (typeof runId !== 'string') throw new NonRetryableJobError('publish.run job has no runId');

  const confluenceAction = confluenceActionOf(data);
  const run = await executeRun(runId, confluenceAction ? { confluenceAction } : {});
  if (!run) throw new NonRetryableJobError(`Publish run ${runId} not found`);
}

registerHandler(JOB_NAMES.publishRun, handlePublishRun);
