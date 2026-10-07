import { z } from 'zod';
import { withApiHandler } from '@/server/http/handler';
import { HttpError } from '@/server/http/errors';
import { startPublish } from '@/server/publish/orchestrator';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, requireLock } from '@/server/sessions/lock';
import { WorkingCopyNotFoundError } from '@/server/spec/workingCopyRepo';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

const publishBody = z.object({
  overrideJustification: z.string().max(5000).optional(),
  confirmOverride: z.boolean().optional(),
});

// Publish (SR-13.1): mandatory evaluation, gate/Override, published revision, then the steps run in the worker.
// 202 { runId }; 409 gate_failed with the open Critical Issues when the gate fails without a valid Override.
export const POST = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));
  const body = publishBody.parse((await ctx.req.json().catch(() => null)) ?? {});

  let result;
  try {
    result = await startPublish({
      sessionId: session.id,
      primaryTicketKey: session.primaryTicketKey,
      ticketKeys: session.ticketKeys,
      user: ctx.user!,
      correlationId: ctx.correlationId,
      overrideJustification: body.overrideJustification,
      confirmOverride: body.confirmOverride,
    });
  } catch (err) {
    if (err instanceof WorkingCopyNotFoundError) throw new HttpError(404, 'Working copy not found', 'not_found');
    throw err;
  }

  if (result.kind === 'gate_failed') {
    return Response.json(
      {
        error: {
          message: 'The readiness gate failed; an override with justification is required',
          code: 'gate_failed',
          correlationId: ctx.correlationId,
        },
        openCriticalIssues: result.openCriticalIssues,
      },
      { status: 409, headers: NO_STORE },
    );
  }
  return Response.json({ runId: result.runId }, { status: 202, headers: NO_STORE });
});
