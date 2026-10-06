import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getValidAccessToken } from '@/server/auth/tokens';
import { AtlassianApiError } from './client';
import fixture from './__fixtures__/issue.json';
import { getIssueSnapshot, isValidIssueKey, resetSiteUrlCache } from './jira';

// Atlassian is mocked by stubbing global fetch (undici is not a project dependency).

vi.mock('@/server/config', () => ({
  getConfig: () => ({ ATLASSIAN_CLOUD_ID: 'cloud-123', ATLASSIAN_API_BASE_URL: 'https://api.atlassian.com' }),
}));

vi.mock('@/server/auth/tokens', () => ({ getValidAccessToken: vi.fn() }));

const fetchMock = vi.fn<typeof fetch>();
const { remoteLinks, ...issue } = fixture;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function adfBody(t: string): unknown {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
  };
}

function makeComments(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    author: { displayName: 'Carol' },
    created: '2026-01-01T00:00:00.000+0000',
    body: adfBody(`comment ${i + 1}`),
  }));
}

function mockJira(commentCount: number): void {
  const all = makeComments(commentCount);
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.href.startsWith('https://api.atlassian.com/oauth/token/accessible-resources')) {
      return json([
        { id: 'other', url: 'https://other.atlassian.net' },
        { id: 'cloud-123', url: 'https://example.atlassian.net/' },
      ]);
    }
    if (url.pathname.endsWith('/comment')) {
      const startAt = Number(url.searchParams.get('startAt'));
      const max = Number(url.searchParams.get('maxResults'));
      return json({
        startAt,
        maxResults: max,
        total: all.length,
        comments: all.slice(startAt, startAt + max),
      });
    }
    if (url.pathname.endsWith('/remotelink')) return json(remoteLinks);
    return json(issue);
  });
}

beforeEach(() => {
  resetSiteUrlCache();
  fetchMock.mockReset();
  vi.mocked(getValidAccessToken).mockResolvedValue('token');
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isValidIssueKey', () => {
  it('accepts ABC-123 and rejects abc-1, ABC-0, ABC123 (AC4)', () => {
    expect(isValidIssueKey('ABC-123')).toBe(true);
    expect(isValidIssueKey('A1_B-7')).toBe(true);
    expect(isValidIssueKey('abc-1')).toBe(false);
    expect(isValidIssueKey('ABC-0')).toBe(false);
    expect(isValidIssueKey('ABC123')).toBe(false);
    expect(isValidIssueKey('ABC-1/../x')).toBe(false);
  });
});

describe('getIssueSnapshot', () => {
  it('maps every SR-2.2 field from the fixture (AC1)', async () => {
    mockJira(2);
    const snap = await getIssueSnapshot('user-1', 'ABC-123');

    expect(snap).toEqual({
      key: 'ABC-123',
      url: 'https://example.atlassian.net/browse/ABC-123',
      summary: 'Export report as CSV',
      descriptionText: '## Goal\n\nUsers can export the report.',
      issueType: 'Story',
      status: 'In Progress',
      priority: 'High',
      assignee: 'Alice Dev',
      reporter: 'Bob PM',
      labels: ['export', 'reporting'],
      components: ['Reports'],
      fixVersions: ['1.4.0'],
      parent: { key: 'ABC-100', summary: 'Reporting epic' },
      issueLinks: [
        {
          type: 'blocks',
          direction: 'outward',
          key: 'ABC-200',
          summary: 'Publish docs',
        },
        {
          type: 'is blocked by',
          direction: 'inward',
          key: 'ABC-50',
          summary: 'Build data layer',
        },
      ],
      comments: [
        {
          id: '1',
          author: 'Carol',
          created: '2026-01-01T00:00:00.000+0000',
          bodyText: 'comment 1',
        },
        {
          id: '2',
          author: 'Carol',
          created: '2026-01-01T00:00:00.000+0000',
          bodyText: 'comment 2',
        },
      ],
      attachments: [
        {
          id: '10001',
          filename: 'mock.png',
          mimeType: 'image/png',
          size: 2048,
          contentUrl: 'https://example.atlassian.net/rest/api/3/attachment/content/10001',
        },
      ],
      remoteLinks: [
        {
          url: 'https://example.com/design',
          title: 'Design doc',
          applicationType: 'com.figma',
        },
      ],
    });
  });

  it('requests the SR-2.2 fields through the cloud-scoped Jira API', async () => {
    mockJira(0);
    await getIssueSnapshot('user-1', 'ABC-123');
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    const issueUrl = urls.find((u) => u.includes('/issue/ABC-123?'));
    expect(issueUrl).toContain(
      'https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/issue/ABC-123?fields=summary,description,',
    );
    expect(urls.some((u) => u.endsWith('/rest/api/3/issue/ABC-123/remotelink'))).toBe(true);
  });

  it('pages through all comments (AC2)', async () => {
    mockJira(150);
    const snap = await getIssueSnapshot('user-1', 'ABC-123');
    expect(snap.comments).toHaveLength(150);
    expect(snap.comments[149].bodyText).toBe('comment 150');
    const commentCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/comment?'));
    expect(commentCalls).toHaveLength(2);
  });

  it('caches the site url per process', async () => {
    mockJira(0);
    await getIssueSnapshot('user-1', 'ABC-123');
    await getIssueSnapshot('user-1', 'ABC-123');
    const lookups = fetchMock.mock.calls.filter(([u]) => String(u).includes('accessible-resources'));
    expect(lookups).toHaveLength(1);
  });

  it('rejects an invalid key without calling Atlassian', async () => {
    await expect(getIssueSnapshot('user-1', 'abc-1')).rejects.toBeInstanceOf(AtlassianApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
