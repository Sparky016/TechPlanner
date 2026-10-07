import { query } from '@/server/db/pool';
import { withApiHandler } from '@/server/http/handler';
import { isEvaluationPending } from '@/server/readiness/schedule';
import { requireSessionAccess } from '@/server/sessions/access';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// evaluation.section_statuses holds { name: { status, reason } }; the panels take name -> status.
function statusesOf(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  return Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [
      name,
      typeof value === 'object' && value !== null ? (value as { status?: unknown }).status : value,
    ]),
  );
}

// The readiness state for the right panel: latest evaluation, current issues and open AI questions.
export const GET = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);

  const [evaluation] = await query<{ score: number; section_statuses: unknown; created_at: Date }>(
    'SELECT score, section_statuses, created_at FROM evaluation WHERE session_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
    [session.id],
  );
  const issues = await query<{ id: string; severity: string; section: string; description: string; status: string }>(
    `SELECT id, severity, section, description, status FROM issue
     WHERE session_id = $1 AND status <> 'resolved' ORDER BY created_at, id`,
    [session.id],
  );
  const openQuestions = await query<{ id: string; issue_id: string | null; section: string | null; text: string }>(
    "SELECT id, issue_id, section, text FROM ai_question WHERE session_id = $1 AND status = 'open' ORDER BY created_at, id",
    [session.id],
  );
  const gatePasses = !issues.some((i) => i.severity === 'critical' && i.status === 'open');

  return Response.json(
    {
      score: evaluation?.score ?? null,
      statuses: statusesOf(evaluation?.section_statuses),
      issues,
      openQuestions: openQuestions.map((q) => ({ id: q.id, issueId: q.issue_id, section: q.section, text: q.text })),
      gatePasses,
      clarificationEnded: session.clarificationEnded,
      evaluatedAt: evaluation?.created_at.toISOString() ?? null,
      evaluationPending: await isEvaluationPending(session.id),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
