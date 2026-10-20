import { z } from 'zod';
import { query } from '@/server/db/pool';
import { withApiHandler } from '@/server/http/handler';
import { requireSessionAccess } from '@/server/sessions/access';
import { CODE_REPOSITORY_MAX, resolveCodeRepository } from '@/server/sessions/codeRepository';
import { readTabId, requireLock } from '@/server/sessions/lock';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

const body = z.object({ repository: z.string().trim().min(1).max(CODE_REPOSITORY_MAX).nullable() });

// Sets (or clears, with null) the Azure DevOps repository the facilitator agent investigates (ADR-0016).
// No dedicated audit action exists (SR-12.1); the next ai.suggestion records the repository in use.
export const PUT = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));
  const { repository } = body.parse(await ctx.req.json().catch(() => null));
  const codeRepository = await resolveCodeRepository(repository);
  await query('UPDATE planning_session SET code_repository = $2, updated_at = now() WHERE id = $1', [
    session.id,
    codeRepository,
  ]);
  return Response.json({ codeRepository }, { headers: { 'Cache-Control': 'no-store' } });
});
