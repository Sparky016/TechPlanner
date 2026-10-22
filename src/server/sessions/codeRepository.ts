import { type AdoRepository, AzureDevOpsError, isAzureDevOpsEnabled, listRepositories } from '@/server/azureDevOps/client';
import { HttpError } from '@/server/http/errors';

// Server-only: never import from src/lib or client components.
// Validates a facilitator's repository picks for a session (ADR-0016) against Azure DevOps.

export const CODE_REPOSITORY_MAX = 256;
/** Repositories one session can reference. */
export const MAX_CODE_REPOSITORIES = 10;

/**
 * The repositories' canonical names, de-duplicated case-insensitively in pick order; an empty list clears the pick.
 * Unknown, disallowed or unreachable repositories are 4xx/5xx.
 */
export async function resolveCodeRepositories(names: readonly string[]): Promise<string[]> {
  if (names.length === 0) return [];
  if (!isAzureDevOpsEnabled()) {
    throw new HttpError(400, 'Azure DevOps is not configured', 'ado_not_configured');
  }
  let available: AdoRepository[];
  try {
    available = await listRepositories();
  } catch (err) {
    if (err instanceof AzureDevOpsError) {
      throw new HttpError(502, `Azure DevOps: ${err.message}`, err.code);
    }
    throw err;
  }
  const resolved: string[] = [];
  for (const name of names) {
    const repo = available.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (!repo) throw new HttpError(400, `Repository ${name} is not available to Tech Planner`, 'unknown_repository');
    if (!resolved.includes(repo.name)) resolved.push(repo.name);
  }
  return resolved;
}
