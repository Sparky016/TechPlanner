import { query } from '@/server/db/pool';
import { withApiHandler } from '@/server/http/handler';
import { requireSessionAccess } from '@/server/sessions/access';

// Server-only route; never cache.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface QuestionRow {
  id: string;
  issue_id: string | null;
  section: string | null;
  text: string;
  status: string;
  dismiss_reason: string | null;
  answer_text: string | null;
  answered_at: Date | null;
  answered_via: string | null;
  resolution: string | null;
  resolved_at: Date | null;
  created_at: Date;
}

// Every AI question of the session (open, answered and resolved; legacy 'dismissed' until the contract step), oldest first.
export const GET = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  const rows = await query<QuestionRow>(
    `SELECT id, issue_id, section, text, status, dismiss_reason, answer_text, answered_at, answered_via, resolution,
            resolved_at, created_at
       FROM ai_question
     WHERE session_id = $1 ORDER BY created_at, id`,
    [session.id],
  );
  const questions = rows.map((q) => ({
    id: q.id,
    issueId: q.issue_id,
    section: q.section,
    text: q.text,
    status: q.status,
    dismissReason: q.dismiss_reason,
    answerText: q.answer_text,
    answeredAt: q.answered_at,
    answeredVia: q.answered_via,
    resolution: q.resolution,
    resolvedAt: q.resolved_at,
    createdAt: q.created_at,
  }));
  return Response.json({ questions }, { headers: { 'Cache-Control': 'no-store' } });
});
