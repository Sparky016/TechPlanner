import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Atlassian is mocked by stubbing global fetch (repo convention; undici is not a project dependency).

const config = vi.hoisted(() => ({
  ATLASSIAN_CLOUD_ID: 'cloud-123',
  ATLASSIAN_API_BASE_URL: 'https://api.atlassian.com',
  CONFLUENCE_SPACE_KEY: 'ENG',
  CONFLUENCE_PARENT_PAGE_ID: '100',
  CONFLUENCE_PROJECT_OVERRIDES: undefined as Record<string, { spaceKey: string; parentPageId: string }> | undefined,
}));

vi.mock('@/server/config', () => ({ getConfig: () => config }));
vi.mock('@/server/auth/tokens', () => ({
  getValidAccessToken: vi.fn(async () => 'token-abc'),
  ReauthRequiredError: class ReauthRequiredError extends Error {
    readonly code = 'reauth_required';
  },
}));
vi.mock('@/server/atlassian/jira', () => ({ getSiteUrl: vi.fn(async () => 'https://example.atlassian.net') }));
vi.mock('@/server/db/pool', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/server/audit/audit', () => ({ recordAudit: vi.fn() }));

import { recordAudit } from '@/server/audit/audit';
import { query, withTransaction } from '@/server/db/pool';
import { confluenceExternalEditTotal } from '@/server/observability/metrics';
import type { PublishContext } from '../types';
import { confluenceStep, resetSpaceIdCacheForTests } from './confluenceStep';

const API = 'https://api.atlassian.com/ex/confluence/cloud-123';
const SESSION = 'abcdef12-0000-4000-8000-000000000001';

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
  auth: string | null;
}

type Route = (call: Call) => Response | undefined;

let calls: Call[];
let routes: Route[];
let stored: { confluence_page_id: string | null; confluence_page_version: number | null };
let sql: { text: string; params?: unknown[] }[];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function page(id: string, version: number, title = 'ENG-1: Login — Technical Specification'): Record<string, unknown> {
  return { id, title, version: { number: version }, _links: { webui: `/spaces/ENG/pages/${id}/x` } };
}

function on(method: string, path: string, respond: (call: Call) => Response): void {
  routes.push((call) => (call.method === method && call.url === `${API}${path}` ? respond(call) : undefined));
}

function ctx(overrides: Partial<PublishContext> = {}): PublishContext {
  return {
    runId: 'run-1',
    sessionId: SESSION,
    ticketKeys: ['ENG-1', 'ENG-2'],
    primaryTicketKey: 'ENG-1',
    facilitator: { accountId: 'acc-1', displayName: 'Ada' },
    revisionNumber: 3,
    readinessScore: 90,
    overrideJustification: null,
    markdown: '# Spec\n\nHello',
    title: 'Login',
    confluencePageUrl: null,
    previousResult: null,
    options: {},
    ...overrides,
  };
}

async function externalEdits(project: string): Promise<number> {
  const metric = await confluenceExternalEditTotal.get();
  return metric.values.find((v) => v.labels.project === project)?.value ?? 0;
}

function auditCalls() {
  return vi.mocked(recordAudit).mock.calls.map((c) => c[0]);
}

function puts(): Call[] {
  return calls.filter((c) => c.method === 'PUT');
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSpaceIdCacheForTests();
  config.CONFLUENCE_PROJECT_OVERRIDES = undefined;
  calls = [];
  routes = [];
  sql = [];
  stored = { confluence_page_id: null, confluence_page_version: null };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      const call: Call = {
        method: init.method ?? 'GET',
        url,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
        auth: headers.get('Authorization'),
      };
      calls.push(call);
      for (const route of routes) {
        const res = route(call);
        if (res) return res;
      }
      return json(404, { message: `unmocked ${call.method} ${url}` });
    }),
  );

  vi.mocked(query).mockImplementation(async () => [stored] as never);
  const client = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      sql.push({ text, params });
      return { rows: [] };
    }),
  };
  vi.mocked(withTransaction).mockImplementation(async (fn) => fn(client as never));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function expectPersisted(pageId: string, version: number): void {
  const update = sql.find((q) => /UPDATE planning_session/.test(q.text));
  expect(update?.params).toEqual([SESSION, pageId, version]);
}

describe('confluenceStep', () => {
  it('is the confluence step', () => {
    expect(confluenceStep.name).toBe('confluence');
  });

  it('AC1: first publish creates the page under the configured parent and stores id and version', async () => {
    on('GET', '/wiki/api/v2/spaces?keys=ENG', () => json(200, { results: [{ id: 'space-9', key: 'ENG' }] }));
    on('POST', '/wiki/api/v2/pages', () => json(200, page('555', 1)));

    const r = await confluenceStep.run(ctx());

    expect(r).toEqual({
      status: 'success',
      result: { pageId: '555', version: 1, url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/555/x' },
    });
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({
      spaceId: 'space-9',
      parentId: '100',
      status: 'current',
      title: 'ENG-1: Login — Technical Specification',
      body: { representation: 'storage' },
    });
    expect((post?.body?.body as { value: string }).value).toContain('<h1>Spec</h1>');
    expect(calls.every((c) => c.auth === 'Bearer token-abc')).toBe(true);
    expectPersisted('555', 1);
  });

  it('AC1: retries once with the session id suffix when the title already exists', async () => {
    on('GET', '/wiki/api/v2/spaces?keys=ENG', () => json(200, { results: [{ id: 'space-9', key: 'ENG' }] }));
    let posts = 0;
    on('POST', '/wiki/api/v2/pages', () =>
      ++posts === 1
        ? json(400, { message: 'A page with this title already exists: A page already exists with the same TITLE in this space' })
        : json(200, page('556', 1)),
    );

    const r = await confluenceStep.run(ctx());

    expect(r.status).toBe('success');
    const titles = calls.filter((c) => c.method === 'POST').map((c) => c.body?.title);
    expect(titles).toEqual([
      'ENG-1: Login — Technical Specification',
      'ENG-1: Login — Technical Specification (abcdef12)',
    ]);
  });

  it('caches the space id per process', async () => {
    on('GET', '/wiki/api/v2/spaces?keys=ENG', () => json(200, { results: [{ id: 'space-9', key: 'ENG' }] }));
    on('POST', '/wiki/api/v2/pages', () => json(200, page('555', 1)));

    await confluenceStep.run(ctx());
    await confluenceStep.run(ctx());

    expect(calls.filter((c) => c.url.includes('/spaces?')).length).toBe(1);
  });

  it('AC2: republish updates the same page with version+1', async () => {
    stored = { confluence_page_id: '555', confluence_page_version: 4 };
    on('GET', '/wiki/api/v2/pages/555', () => json(200, page('555', 4)));
    on('PUT', '/wiki/api/v2/pages/555', () => json(200, page('555', 5)));

    const r = await confluenceStep.run(ctx());

    expect(r).toMatchObject({ status: 'success', result: { pageId: '555', version: 5 } });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body).toMatchObject({
      id: '555',
      status: 'current',
      title: 'ENG-1: Login — Technical Specification',
      body: { representation: 'storage' },
      version: { number: 5, message: 'Tech Planner revision 3' },
    });
    expectPersisted('555', 5);
  });

  it('treats a retry whose previous result matches the current page version as success without re-PUT', async () => {
    stored = { confluence_page_id: '555', confluence_page_version: 4 };
    on('GET', '/wiki/api/v2/pages/555', () => json(200, page('555', 5)));

    const r = await confluenceStep.run(ctx({ previousResult: { pageId: '555', version: 5 } }));

    expect(r).toMatchObject({ status: 'success', result: { pageId: '555', version: 5 } });
    expect(puts()).toHaveLength(0);
    expectPersisted('555', 5);
  });

  describe('AC3: external edit since the last publish', () => {
    beforeEach(() => {
      stored = { confluence_page_id: '555', confluence_page_version: 4 };
      on('GET', '/wiki/api/v2/pages/555', () => json(200, page('555', 6)));
      on('PUT', '/wiki/api/v2/pages/555', () => json(200, page('555', 7)));
    });

    it('returns failed page_changed_externally without writing, and counts the external edit', async () => {
      const before = await externalEdits('ENG');

      const r = await confluenceStep.run(ctx());

      expect(r.status).toBe('failed');
      expect(r.error?.code).toBe('page_changed_externally');
      expect(puts()).toHaveLength(0);
      expect(sql).toHaveLength(0);
      expect(await externalEdits('ENG')).toBe(before + 1);
    });

    it('updates with version current+1 when confluenceAction is overwrite', async () => {
      const r = await confluenceStep.run(ctx({ options: { confluenceAction: 'overwrite' } }));

      expect(r).toMatchObject({ status: 'success', result: { pageId: '555', version: 7 } });
      expect(puts()[0].body).toMatchObject({ version: { number: 7 } });
      expectPersisted('555', 7);
    });

    it('returns cancelled when confluenceAction is cancel', async () => {
      const r = await confluenceStep.run(ctx({ options: { confluenceAction: 'cancel' } }));

      expect(r.status).toBe('cancelled');
      expect(puts()).toHaveLength(0);
      expect(sql).toHaveLength(0);
    });
  });

  it('AC4: a per-project override selects the override space and parent', async () => {
    config.CONFLUENCE_PROJECT_OVERRIDES = { OPS: { spaceKey: 'OPSDOC', parentPageId: '777' } };
    on('GET', '/wiki/api/v2/spaces?keys=OPSDOC', () => json(200, { results: [{ id: 'space-ops', key: 'OPSDOC' }] }));
    on('POST', '/wiki/api/v2/pages', () => json(200, page('900', 1)));

    const r = await confluenceStep.run(ctx({ primaryTicketKey: 'OPS-12', ticketKeys: ['OPS-12'] }));

    expect(r.status).toBe('success');
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      spaceId: 'space-ops',
      parentId: '777',
      title: 'OPS-12: Login — Technical Specification',
    });
  });

  it('AC4: projects without an override use the default space and parent', async () => {
    config.CONFLUENCE_PROJECT_OVERRIDES = { OPS: { spaceKey: 'OPSDOC', parentPageId: '777' } };
    on('GET', '/wiki/api/v2/spaces?keys=ENG', () => json(200, { results: [{ id: 'space-9', key: 'ENG' }] }));
    on('POST', '/wiki/api/v2/pages', () => json(200, page('555', 1)));

    await confluenceStep.run(ctx());

    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ spaceId: 'space-9', parentId: '100' });
  });

  describe('AC5: audit', () => {
    it('writes a success confluence.updated record in the persisting transaction', async () => {
      on('GET', '/wiki/api/v2/spaces?keys=ENG', () => json(200, { results: [{ id: 'space-9', key: 'ENG' }] }));
      on('POST', '/wiki/api/v2/pages', () => json(200, page('555', 1)));

      await confluenceStep.run(ctx());

      expect(auditCalls()).toEqual([
        expect.objectContaining({
          action: 'confluence.updated',
          result: 'success',
          userId: 'acc-1',
          userDisplayName: 'Ada',
          sessionId: SESSION,
          ticketIds: ['ENG-1', 'ENG-2'],
          details: expect.objectContaining({ pageId: '555', version: 1, operation: 'created' }),
        }),
      ]);
      expect(vi.mocked(recordAudit).mock.calls[0][1]).toBeDefined();
    });

    it('writes a failure record when Confluence rejects the call', async () => {
      on('GET', '/wiki/api/v2/spaces?keys=ENG', () => json(200, { results: [{ id: 'space-9', key: 'ENG' }] }));
      on('POST', '/wiki/api/v2/pages', () => json(403, { message: 'Forbidden' }));

      const r = await confluenceStep.run(ctx());

      expect(r).toEqual({ status: 'failed', error: { code: 'atlassian_403', message: 'Forbidden' } });
      expect(auditCalls()).toEqual([
        expect.objectContaining({ action: 'confluence.updated', result: 'failure', details: expect.objectContaining({ code: 'atlassian_403' }) }),
      ]);
      expect(sql).toHaveLength(0);
    });

    it('writes a failure record on an external-edit conflict and on cancel', async () => {
      stored = { confluence_page_id: '555', confluence_page_version: 4 };
      on('GET', '/wiki/api/v2/pages/555', () => json(200, page('555', 6)));

      await confluenceStep.run(ctx());
      await confluenceStep.run(ctx({ options: { confluenceAction: 'cancel' } }));

      expect(auditCalls().map((a) => [a.action, a.result, a.details?.code])).toEqual([
        ['confluence.updated', 'failure', 'page_changed_externally'],
        ['confluence.updated', 'failure', 'cancelled_by_user'],
      ]);
    });
  });
});
