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
  created_at: Date;
}

// Every AI question of the session (open, answered and dismissed), oldest first.
export const GET = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  const rows = await query<QuestionRow>(
    `SELECT id, issue_id, section, text, status, dismiss_reason, created_at FROM ai_question
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
    createdAt: q.created_at,
  }));
  return Response.json({ questions }, { headers: { 'Cache-Control': 'no-store' } });
});
