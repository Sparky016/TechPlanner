import { z } from 'zod';
import { HttpError } from '@/server/http/errors';
import { withApiHandler } from '@/server/http/handler';
import { requireSessionAccess } from '@/server/sessions/access';
import { readTabId, requireLock } from '@/server/sessions/lock';
import { recordDraftUpdated, recordSectionEdit } from '@/server/spec/editAudit';
import {
  VersionConflictError,
  WorkingCopyNotFoundError,
  getWorkingCopy,
  updateSectionByUser,
} from '@/server/spec/workingCopyRepo';
import { sectionFromSlug } from '@/lib/spec/sections';

// Server-only route; never cache.
export const dynamic = 'force-dynamic';

// Fallback maximum section size (knowledge gap in task 19): larger bodies are rejected with 413.
const MAX_SECTION_CHARS = 100_000;

const PatchBody = z.object({
  body: z.string(),
  expectedVersion: z.number().int().min(0),
});

function versionConflict(): HttpError {
  return new HttpError(409, 'The working copy has changed; reload and retry', 'version_conflict');
}

// Facilitator section save (autosave target) with optimistic concurrency: 409 version_conflict on a stale version.
export const PATCH = withApiHandler<{ id: string; section: string }>({}, async (ctx) => {
  const session = await requireSessionAccess(ctx, ctx.params.id);
  await requireLock(session.id, readTabId(ctx.req));
  const section = sectionFromSlug(ctx.params.section);
  if (!section) throw new HttpError(404, 'Unknown section', 'unknown_section');

  const raw: unknown = await ctx.req.json().catch(() => {
    throw new HttpError(400, 'Request body must be JSON', 'invalid_json');
  });
  const input = PatchBody.parse(raw);
  if (input.body.length > MAX_SECTION_CHARS) {
    throw new HttpError(413, `Section body exceeds ${MAX_SECTION_CHARS} characters`, 'body_too_large');
  }

  // The body read here is the pre-edit body whenever the versioned update below succeeds.
  const current = await getWorkingCopy(session.id);
  if (!current) throw new HttpError(404, 'Working copy not found', 'not_found');
  if (current.version !== input.expectedVersion) throw versionConflict();

  let version: number;
  try {
    version = await updateSectionByUser(session.id, section, input.body, input.expectedVersion);
  } catch (err) {
    if (err instanceof VersionConflictError) throw versionConflict();
    if (err instanceof WorkingCopyNotFoundError) throw new HttpError(404, 'Working copy not found', 'not_found');
    throw err;
  }

  const actor = { user: ctx.user!, ticketIds: session.ticketKeys, correlationId: ctx.correlationId };
  await recordSectionEdit(session.id, section, current.sections[section].body, input.body, actor);
  await recordDraftUpdated(session.id, version, actor);
  return Response.json({ version }, { headers: { 'Cache-Control': 'no-store' } });
});
