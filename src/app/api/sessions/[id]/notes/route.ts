import { z } from 'zod';
import { withTransaction } from '@/server/db/pool';
import { HttpError } from '@/server/http/errors';
import { withApiHandler } from '@/server/http/handler';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, requireLock } from '@/server/sessions/lock';

// Server-only route; never cache.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_NOTE_CHARS = 10_000;

const NoteBody = z.object({ text: z.string().refine((s) => s.trim() !== '', 'Note must not be empty') });

// Adds a facilitator note to the conversation as context for later turns. Never starts an AI turn.
export const POST = withApiHandler<{ id: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));

  const raw: unknown = await ctx.req.json().catch(() => {
    throw new HttpError(400, 'Request body must be JSON', 'invalid_json');
  });
  const { text } = NoteBody.parse(raw);
  if (text.length > MAX_NOTE_CHARS) {
    throw new HttpError(413, `Note exceeds ${MAX_NOTE_CHARS} characters`, 'body_too_large');
  }

  const row = await withTransaction(async (client) => {
    // Serialises concurrent writers for this session while seq is computed (same pattern as the facilitator turn).
    await client.query('SELECT 1 FROM planning_session WHERE id = ? FOR UPDATE', [session.id]);
    const next = await client.query<{ seq: string }>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM conversation_message WHERE session_id = ?',
      [session.id],
    );
    // INT + 1 is a BIGINT in MySQL, which the driver returns as a string.
    const seq = Number(next.rows[0].seq);
    await client.query("INSERT INTO conversation_message (session_id, seq, role, content) VALUES (?, ?, 'note', ?)", [
      session.id,
      seq,
      text,
    ]);
    const { rows } = await client.query<{ seq: number; created_at: Date }>(
      'SELECT seq, created_at FROM conversation_message WHERE session_id = ? AND seq = ?',
      [session.id, seq],
    );
    return rows[0];
  });

  return Response.json(
    { seq: row.seq, role: 'note', content: text, createdAt: row.created_at },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
});
