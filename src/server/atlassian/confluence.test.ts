import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getValidAccessToken } from '@/server/auth/tokens';
import { AtlassianApiError } from './client';
import { discoverConfluencePageRefs, getPageMarkdown } from './confluence';
import type { JiraIssueSnapshot } from './jira';

// Atlassian is mocked by stubbing global fetch (undici is not a project dependency).

vi.mock('@/server/config', () => ({
  getConfig: () => ({ ATLASSIAN_CLOUD_ID: 'cloud-123' }),
}));

vi.mock('@/server/auth/tokens', () => ({ getValidAccessToken: vi.fn() }));

vi.mock('./jira', () => ({ getSiteUrl: vi.fn(async () => 'https://example.atlassian.net') }));

const SITE = 'https://example.atlassian.net';

function snapshot(overrides: Partial<JiraIssueSnapshot> = {}): JiraIssueSnapshot {
  return {
    key: 'ABC-1',
    url: `${SITE}/browse/ABC-1`,
    summary: 's',
    descriptionText: '',
    issueType: null,
    status: null,
    priority: null,
    assignee: null,
    reporter: null,
    labels: [],
    components: [],
    fixVersions: [],
    parent: null,
    issueLinks: [],
    comments: [],
    attachments: [],
    remoteLinks: [],
    ...overrides,
  };
}

describe('discoverConfluencePageRefs', () => {
  it('finds pages from remote links, description and comments, de-duplicated in first-seen order', () => {
    const refs = discoverConfluencePageRefs(
      snapshot({
        remoteLinks: [
          {
            url: `${SITE}/wiki/spaces/ENG/pages/111/Design`,
            title: 'Design',
            applicationType: 'com.atlassian.confluence',
          },
          { url: 'https://github.com/org/repo/pull/1', title: 'PR', applicationType: 'GitHub' },
        ],
        descriptionText:
          `See ${SITE}/wiki/spaces/ENG/pages/222/Spec. Also ${SITE}/wiki/spaces/ENG/pages/111/Design ` +
          `and (${SITE}/wiki/pages/viewpage.action?pageId=333).`,
        comments: [
          { id: '1', author: null, created: '', bodyText: `again ${SITE}/wiki/spaces/OPS/pages/333/Runbook` },
          {
            id: '2',
            author: null,
            created: '',
            bodyText: 'other site https://other.atlassian.net/wiki/spaces/X/pages/999/Nope',
          },
        ],
      }),
    );
    expect(refs.map((r) => r.pageId)).toEqual(['111', '222', '333']);
    expect(refs[1].url).toBe(`${SITE}/wiki/spaces/ENG/pages/222/Spec`);
  });

  it('returns tiny links with reason unsupported_link instead of dropping them', () => {
    const refs = discoverConfluencePageRefs(
      snapshot({
        remoteLinks: [{ url: `${SITE}/wiki/x/AbCd`, title: 't', applicationType: 'confluence' }],
        descriptionText: `tiny ${SITE}/wiki/x/EfGh and again ${SITE}/wiki/x/EfGh`,
      }),
    );
    expect(refs).toEqual([
      { url: `${SITE}/wiki/x/AbCd`, pageId: null, reason: 'unsupported_link' },
      { url: `${SITE}/wiki/x/EfGh`, pageId: null, reason: 'unsupported_link' },
    ]);
  });

  it('returns an empty list when nothing is linked', () => {
    expect(discoverConfluencePageRefs(snapshot())).toEqual([]);
  });
});

describe('getPageMarkdown', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.mocked(getValidAccessToken).mockResolvedValue('tok-alice');
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('calls the v2 pages endpoint with body-format=storage as the given user and returns markdown', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: '111',
          title: 'Design',
          version: { number: 7 },
          body: { storage: { value: '<h1>Design</h1><p>Hello</p>' } },
          _links: { webui: '/spaces/ENG/pages/111/Design' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const page = await getPageMarkdown('alice', '111');

    expect(getValidAccessToken).toHaveBeenCalledWith('alice');
    const [input, init] = fetchMock.mock.calls[0];
    expect(String(input)).toBe(
      'https://api.atlassian.com/ex/confluence/cloud-123/wiki/api/v2/pages/111?body-format=storage',
    );
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok-alice');
    expect(page).toEqual({
      pageId: '111',
      title: 'Design',
      url: `${SITE}/wiki/spaces/ENG/pages/111/Design`,
      version: 7,
      markdown: '# Design\n\nHello',
    });
  });

  it('rejects a non-numeric page id without calling Atlassian', async () => {
    await expect(getPageMarkdown('alice', '../1')).rejects.toBeInstanceOf(AtlassianApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates Atlassian errors', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'nope' }), { status: 404 }));
    await expect(getPageMarkdown('alice', '111')).rejects.toMatchObject({ status: 404, product: 'confluence' });
  });
});
