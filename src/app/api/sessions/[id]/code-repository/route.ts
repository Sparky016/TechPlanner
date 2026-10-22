import { z } from 'zod';
import { query } from '@/server/db/pool';
import { withApiHandler } from '@/server/http/handler';
import { requireSessionAccess } from '@/server/sessions/access';
import { CODE_REPOSITORY_MAX, MAX_CODE_REPOSITORIES, resolveCodeRepositories } from '@/server/sessions/codeRepository';
import { readTabId, requireLock } from '@/server/sessions/lock';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

const body = z.object({
  repositories: z.array(z.string().trim().min(1).max(CODE_REPOSITORY_MAX)).max(MAX_CODE_REPOSITORIES),
});

// Replaces (or clears, with []) the Azure DevOps repositories the facilitator agent investigates (ADR-0016).
// No dedicated audit action exists (SR-12.1); the next ai.suggestion records the repositories in use.
export const PUT = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));
  const { repositories } = body.parse(await ctx.req.json().catch(() => null));
  const codeRepositories = await resolveCodeRepositories(repositories);
  await query('UPDATE planning_session SET code_repositories = $2, updated_at = now() WHERE id = $1', [
    session.id,
    codeRepositories,
  ]);
  return Response.json({ codeRepositories }, { headers: { 'Cache-Control': 'no-store' } });
});
