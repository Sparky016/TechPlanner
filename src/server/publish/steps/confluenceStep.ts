import { AtlassianApiError, atlassianJson } from '@/server/atlassian/client';
import { getSiteUrl } from '@/server/atlassian/jira';
import { recordAudit } from '@/server/audit/audit';
import { ReauthRequiredError } from '@/server/auth/tokens';
import { getConfig } from '@/server/config';
import { query, withTransaction } from '@/server/db/pool';
import { countConfluenceExternalEdit } from '@/server/observability/metrics';
import { markdownToConfluenceStorage } from '../toConfluenceStorage';
import type { PublishContext, PublishStep, StepResult } from '../types';

// Server-only: never import from src/lib or client components.
// Publish step 'confluence' (SR-13.2 step 1, SR-13.5): creates the specification page under the configured
// space/parent on first publish and updates the same page on republish, as the facilitator (SR-1.2).
// A page edited in Confluence since the last publish is never silently overwritten.

interface RawSpace {
  id: string;
  key?: string;
}

interface RawPage {
  id: string;
  title?: string;
  version?: { number?: number };
  _links?: { webui?: string };
}

interface SessionPageRow {
  confluence_page_id: string | null;
  confluence_page_version: number | null;
}

interface Target {
  spaceKey: string;
  parentPageId: string;
}

// Space key -> space id, cached per process.
const spaceIdCache = new Map<string, string>();

export function resetSpaceIdCacheForTests(): void {
  spaceIdCache.clear();
}

function projectOf(ticketKey: string): string {
  return ticketKey.split('-')[0] ?? ticketKey;
}

function resolveTarget(primaryTicketKey: string): Target {
  const config = getConfig();
  const override = config.CONFLUENCE_PROJECT_OVERRIDES?.[projectOf(primaryTicketKey)];
  if (override) return { spaceKey: override.spaceKey, parentPageId: override.parentPageId };
  return { spaceKey: config.CONFLUENCE_SPACE_KEY, parentPageId: config.CONFLUENCE_PARENT_PAGE_ID };
}

// ctx.title is the primary ticket's summary.
function pageTitle(ctx: PublishContext): string {
  return `${ctx.primaryTicketKey}: ${ctx.title} — Technical Specification`;
}

async function getSpaceId(userId: string, spaceKey: string): Promise<string> {
  const cached = spaceIdCache.get(spaceKey);
  if (cached) return cached;
  const res = await atlassianJson<{ results?: RawSpace[] }>(
    userId,
    'confluence',
    `/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`,
  );
  const space = (res.results ?? []).find((s) => s.key === undefined || s.key === spaceKey);
  if (!space) {
    throw new AtlassianApiError(404, 'confluence', 'confluence_space_not_found', 'Confluence space not found');
  }
  spaceIdCache.set(spaceKey, space.id);
  return space.id;
}

function isDuplicateTitle(err: unknown): boolean {
  return (
    err instanceof AtlassianApiError &&
    (err.status === 400 || err.status === 409) &&
    /already exists/i.test(err.message) &&
    /title/i.test(err.message)
  );
}

async function createPage(userId: string, ctx: PublishContext, body: string): Promise<RawPage> {
  const target = resolveTarget(ctx.primaryTicketKey);
  const spaceId = await getSpaceId(userId, target.spaceKey);
  const post = (title: string) =>
    atlassianJson<RawPage>(userId, 'confluence', '/wiki/api/v2/pages', {
      method: 'POST',
      body: JSON.stringify({
        spaceId,
        parentId: target.parentPageId,
        status: 'current',
        title,
        body: { representation: 'storage', value: body },
      }),
    });
  const title = pageTitle(ctx);
  try {
    return await post(title);
  } catch (err) {
    if (!isDuplicateTitle(err)) throw err;
    return post(`${title} (${ctx.sessionId.slice(0, 8)})`);
  }
}

function pageVersion(page: RawPage): number {
  return page.version?.number ?? 0;
}

async function pageUrl(userId: string, page: RawPage): Promise<string> {
  const siteUrl = await getSiteUrl(userId);
  return `${siteUrl}/wiki${page._links?.webui ?? `/pages/viewpage.action?pageId=${page.id}`}`;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

async function loadStoredPage(sessionId: string): Promise<SessionPageRow> {
  const rows = await query<SessionPageRow>(
    'SELECT confluence_page_id, confluence_page_version FROM planning_session WHERE id = $1',
    [sessionId],
  );
  return rows[0] ?? { confluence_page_id: null, confluence_page_version: null };
}

type Outcome =
  | { kind: 'done'; operation: 'created' | 'updated' | 'unchanged'; page: RawPage }
  | { kind: 'conflict'; pageId: string; storedVersion: number | null; currentVersion: number };

async function publish(ctx: PublishContext): Promise<Outcome> {
  const userId = ctx.facilitator.accountId;
  const stored = await loadStoredPage(ctx.sessionId);
  const previousPageId = stringOf(ctx.previousResult?.pageId);
  const pageId = stored.confluence_page_id ?? previousPageId;
  const body = markdownToConfluenceStorage(ctx.markdown);

  if (pageId === null) {
    return { kind: 'done', operation: 'created', page: await createPage(userId, ctx, body) };
  }

  const current = await atlassianJson<RawPage>(userId, 'confluence', `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`);
  const currentVersion = pageVersion(current);

  // Idempotent retry: this step already wrote the page's current version.
  if (previousPageId === pageId && ctx.previousResult?.version === currentVersion) {
    return { kind: 'done', operation: 'unchanged', page: current };
  }

  if (currentVersion !== stored.confluence_page_version) {
    countConfluenceExternalEdit(projectOf(ctx.primaryTicketKey));
    if (ctx.options.confluenceAction !== 'overwrite') {
      return { kind: 'conflict', pageId, storedVersion: stored.confluence_page_version, currentVersion };
    }
  }

  const updated = await atlassianJson<RawPage>(userId, 'confluence', `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`, {
    method: 'PUT',
    body: JSON.stringify({
      id: pageId,
      status: 'current',
      title: current.title ?? pageTitle(ctx),
      body: { representation: 'storage', value: body },
      version: { number: currentVersion + 1, message: `Tech Planner revision ${ctx.revisionNumber}` },
    }),
  });
  return { kind: 'done', operation: 'updated', page: updated };
}

function auditBase(ctx: PublishContext) {
  return {
    action: 'confluence.updated' as const,
    userId: ctx.facilitator.accountId,
    userDisplayName: ctx.facilitator.displayName,
    sessionId: ctx.sessionId,
    ticketIds: ctx.ticketKeys,
    correlationId: ctx.runId,
  };
}

async function fail(ctx: PublishContext, status: 'failed' | 'cancelled', code: string, message: string, details: Record<string, unknown> = {}): Promise<StepResult> {
  await recordAudit({
    ...auditBase(ctx),
    result: 'failure',
    details: { runId: ctx.runId, revision: ctx.revisionNumber, status, code, ...details },
  });
  return status === 'cancelled' ? { status } : { status, error: { code, message } };
}

async function persist(ctx: PublishContext, operation: string, page: RawPage, version: number): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE planning_session
          SET confluence_page_id = $2, confluence_page_version = $3, updated_at = now()
        WHERE id = $1`,
      [ctx.sessionId, page.id, version],
    );
    await recordAudit(
      {
        ...auditBase(ctx),
        result: 'success',
        details: { runId: ctx.runId, revision: ctx.revisionNumber, operation, pageId: page.id, version },
      },
      client,
    );
  });
}

export const confluenceStep: PublishStep = {
  name: 'confluence',

  async run(ctx: PublishContext): Promise<StepResult> {
    try {
      const outcome = await publish(ctx);

      if (outcome.kind === 'conflict') {
        const details = {
          pageId: outcome.pageId,
          storedVersion: outcome.storedVersion,
          currentVersion: outcome.currentVersion,
        };
        if (ctx.options.confluenceAction === 'cancel') {
          return await fail(ctx, 'cancelled', 'cancelled_by_user', 'Confluence update cancelled by the user', details);
        }
        return await fail(
          ctx,
          'failed',
          'page_changed_externally',
          'The Confluence page was edited since the last publish',
          details,
        );
      }

      const { page, operation } = outcome;
      const version = pageVersion(page);
      const url = await pageUrl(ctx.facilitator.accountId, page);
      await persist(ctx, operation, page, version);
      return { status: 'success', result: { pageId: page.id, version, url } };
    } catch (err) {
      if (err instanceof AtlassianApiError || err instanceof ReauthRequiredError) {
        return fail(ctx, 'failed', err.code, err.message);
      }
      await recordAudit({
        ...auditBase(ctx),
        result: 'failure',
        details: { runId: ctx.runId, revision: ctx.revisionNumber, status: 'failed', code: 'internal_error' },
      });
      throw err;
    }
  },
};
