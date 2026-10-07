import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    ATLASSIAN_CLIENT_ID: 'client-id',
    ATLASSIAN_CLIENT_SECRET: 'client-secret',
    ATLASSIAN_CLOUD_ID: 'cloud-id',
    OAUTH_REDIRECT_URI: 'http://localhost:3000/auth/callback',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    DATABASE_URL: 'postgres://techplanner:techplanner@localhost:5432/techplanner_t31',
    COPILOT_GITHUB_TOKEN: 'ghp_x',
    FACILITATOR_MODEL: 'model-a',
    EVALUATOR_MODEL: 'model-b',
    CONFLUENCE_SPACE_KEY: 'ENG',
    CONFLUENCE_PARENT_PAGE_ID: '12345',
    APP_BASE_URL: 'http://localhost:3000',
    LLM_FAKE: '1',
  });
});

vi.mock('@/server/db/pool', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/server/audit/audit', () => ({ recordAudit: vi.fn() }));

import { recordAudit } from '@/server/audit/audit';
import { resetConfigForTests } from '@/server/config';
import type { PublishContext } from '../types';
import { verifySignature } from '../webhookSignature';
import { downstreamStep } from './downstreamStep';

const URL_ = 'https://hooks.example.test/spec';
const SECRET = 'shh-secret';

const ctx: PublishContext = {
  runId: 'run-1',
  sessionId: 'sess-1',
  ticketKeys: ['PROJ-1', 'PROJ-2'],
  primaryTicketKey: 'PROJ-1',
  facilitator: { accountId: 'acc-1', displayName: 'Fac' },
  revisionNumber: 3,
  readinessScore: 88,
  overrideJustification: null,
  markdown: '# Spec',
  title: 'Spec',
  confluencePageUrl: 'https://c.example.test/page',
  previousResult: null,
  options: {},
};

function res(status: number): Response {
  return new Response(null, { status });
}

describe('downstreamStep', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(recordAudit).mockReset();
    process.env.DOWNSTREAM_WEBHOOK_URL = URL_;
    process.env.DOWNSTREAM_WEBHOOK_SECRET = SECRET;
    resetConfigForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.DOWNSTREAM_WEBHOOK_URL;
    delete process.env.DOWNSTREAM_WEBHOOK_SECRET;
    resetConfigForTests();
  });

  it('AC1: sends every 7.4 field with a verifiable signature', async () => {
    fetchMock.mockResolvedValue(res(200));
    const out = await downstreamStep.run(ctx);
    expect(out.status).toBe('success');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(URL_);
    expect(init.redirect).toBe('manual');
    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(payload).toMatchObject({
      event: 'spec.published',
      sessionId: 'sess-1',
      primaryTicket: 'PROJ-1',
      tickets: ['PROJ-1', 'PROJ-2'],
      revision: 3,
      readinessScore: 88,
      override: false,
      confluencePageUrl: 'https://c.example.test/page',
      attachmentName: 'PROJ-1-spec-r3.md',
      specMarkdown: '# Spec',
      publishedBy: 'acc-1',
    });
    expect(new Date(payload.publishedAt as string).toISOString()).toBe(payload.publishedAt);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-Delivery-Id']).toBe('run-1');
    expect(verifySignature(init.body as string, SECRET, init.headers['X-Signature'])).toBe(true);
    expect(verifySignature(init.body + 'x', SECRET, init.headers['X-Signature'])).toBe(false);
  });

  it('AC2: retries after 1s and 5s then succeeds', async () => {
    fetchMock.mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(200));
    const p = downstreamStep.run(ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await p).status).toBe('success');
  });

  it('AC3: four failures yield webhook_failed', async () => {
    fetchMock.mockResolvedValueOnce(res(500));
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    fetchMock.mockResolvedValueOnce(res(502));
    fetchMock.mockResolvedValueOnce(res(503));
    const p = downstreamStep.run(ctx);
    await vi.advanceTimersByTimeAsync(31_000);
    const out = await p;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(out).toEqual({ status: 'failed', error: { code: 'webhook_failed', message: 'HTTP 503' } });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'downstream.triggered', result: 'failure' }));
    expect(JSON.stringify(vi.mocked(recordAudit).mock.calls)).not.toContain(SECRET);
  });

  it('AC4: no URL configured is label-only with no HTTP call', async () => {
    delete process.env.DOWNSTREAM_WEBHOOK_URL;
    delete process.env.DOWNSTREAM_WEBHOOK_SECRET;
    resetConfigForTests();
    const out = await downstreamStep.run(ctx);
    expect(out).toEqual({ status: 'success', result: { mode: 'label-only' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
