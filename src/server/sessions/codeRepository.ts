import { AzureDevOpsError, findRepository, isAzureDevOpsEnabled } from '@/server/azureDevOps/client';
import { HttpError } from '@/server/http/errors';

// Server-only: never import from src/lib or client components.
// Validates a facilitator's repository pick for a session (ADR-0016) against Azure DevOps.

export const CODE_REPOSITORY_MAX = 256;

/** The repository's canonical name; null clears the pick. Unknown, disallowed or unreachable repositories are 4xx/5xx. */
export async function resolveCodeRepository(name: string | null): Promise<string | null> {
  if (name === null) return null;
  if (!isAzureDevOpsEnabled()) {
    throw new HttpError(400, 'Azure DevOps is not configured', 'ado_not_configured');
  }
  let repo;
  try {
    repo = await findRepository(name);
  } catch (err) {
    if (err instanceof AzureDevOpsError) {
      throw new HttpError(502, `Azure DevOps: ${err.message}`, err.code);
    }
    throw err;
  }
  if (!repo) throw new HttpError(400, `Repository ${name} is not available to Tech Planner`, 'unknown_repository');
  return repo.name;
}
