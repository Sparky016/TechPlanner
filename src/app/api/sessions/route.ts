import { z } from 'zod';
import { query } from '@/server/db/pool';
import { withApiHandler } from '@/server/http/handler';
import { MAX_TICKET_KEYS, createSession } from '@/server/sessions/createSession';
import { type PlanningSessionDbRow, type PlanningSessionRow, mapSessionRow } from '@/server/sessions/repo';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

const createBody = z.object({
  ticketKeys: z.array(z.string()).min(1).max(MAX_TICKET_KEYS),
  confirmDuplicate: z.boolean().optional(),
});

const listQuery = z.object({
  status: z.enum(['draft', 'published', 'partially_published']).optional(),
  ticket: z.string().trim().min(1).optional(),
});

function sessionSummary(s: PlanningSessionRow) {
  return {
    id: s.id,
    primaryTicketKey: s.primaryTicketKey,
    ticketKeys: s.ticketKeys,
    status: s.status,
    clarificationEnded: s.clarificationEnded,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

// Error envelope as withApiHandler renders it, plus a top-level field naming the offending keys/sessions.
function errorWith(status: number, code: string, message: string, correlationId: string, extra: object): Response {
  return Response.json({ error: { message, code, correlationId }, ...extra }, { status, headers: NO_STORE });
}

// Sessions the current user facilitates (D-12), newest activity first. ?status= and ?ticket= filter the list.
export const GET = withApiHandler({}, async (ctx) => {
  const params = listQuery.parse({
    status: ctx.req.nextUrl.searchParams.get('status') || undefined,
    ticket: ctx.req.nextUrl.searchParams.get('ticket') || undefined,
  });
  const rows = await query<PlanningSessionDbRow>(
    `SELECT * FROM planning_session
      WHERE facilitator_id = $1
        AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR $3 = ANY (ticket_keys))
      ORDER BY updated_at DESC, created_at DESC`,
    [ctx.user!.accountId, params.status ?? null, params.ticket?.toUpperCase() ?? null],
  );
  return Response.json({ sessions: rows.map((r) => sessionSummary(mapSessionRow(r))) }, { headers: NO_STORE });
});

// Creates a session. 400 invalid keys, 422 unreadable tickets, 409 existing session for the primary ticket.
export const POST = withApiHandler({}, async (ctx) => {
  const body = createBody.parse(await ctx.req.json().catch(() => null));
  const result = await createSession(ctx.user!, body.ticketKeys, {
    confirmDuplicate: body.confirmDuplicate,
    correlationId: ctx.correlationId,
  });
  switch (result.kind) {
    case 'invalid_keys':
      return errorWith(400, 'invalid_ticket_keys', 'Invalid Jira issue keys', ctx.correlationId, {
        invalidKeys: result.invalidKeys,
      });
    case 'unreadable':
      return errorWith(422, 'tickets_unreadable', 'Some Jira tickets cannot be read', ctx.correlationId, {
        unreadable: result.unreadable,
      });
    case 'duplicate':
      return errorWith(409, 'session_exists', 'A session already exists for the primary ticket', ctx.correlationId, {
        existingSessionIds: result.existingSessionIds,
      });
    case 'created':
      return Response.json({ session: sessionSummary(result.session) }, { status: 201, headers: NO_STORE });
  }
});
