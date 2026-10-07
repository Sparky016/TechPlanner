import { AtlassianApiError, atlassianJson } from './client';
import { getSiteUrl, type JiraIssueSnapshot } from './jira';
import { storageToMarkdown } from './storageToMarkdown';

// Server-only: never import from src/lib or client components.
// Finds Confluence pages linked from a Jira ticket and reads them as the acting user (SR-2.3). One level only:
// links inside a fetched page are never followed.

const PAGE_ID_PATTERN = /^\d+$/;
const URL_PATTERN = /https?:\/\/[^\s<>"'\])]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const PAGE_PATH_PATTERN = /\/wiki\/spaces\/[^/\s]+\/pages\/(\d+)(?:[/?#]|$)/;
const PAGE_ID_PARAM_PATTERN = /[?&]pageId=(\d+)(?:[&#]|$)/;

export type ConfluencePageRef =
  { url: string; pageId: string } | { url: string; pageId: null; reason: 'unsupported_link' };

export interface ConfluencePage {
  pageId: string;
  title: string;
  url: string;
  version: number;
  markdown: string;
}

interface RawPage {
  id: string;
  title?: string;
  version?: { number?: number };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string };
}

function extractPageId(url: string): string | null {
  return PAGE_PATH_PATTERN.exec(url)?.[1] ?? PAGE_ID_PARAM_PATTERN.exec(url)?.[1] ?? null;
}

// The snapshot url is `${siteUrl}/browse/${key}`.
function siteUrlOf(snapshot: JiraIssueSnapshot): string {
  return snapshot.url.replace(/\/browse\/[^/]*$/, '').replace(/\/+$/, '');
}

function confluenceUrlsIn(text: string, siteUrl: string): string[] {
  return (text.match(URL_PATTERN) ?? [])
    .map((u) => u.replace(TRAILING_PUNCTUATION, ''))
    .filter((u) => u.startsWith(`${siteUrl}/wiki/`));
}

// Pages linked from remote links, the description and comments, de-duplicated by page id in first-seen order.
// Confluence URLs that cannot be resolved to a page id are returned with reason 'unsupported_link'.
export function discoverConfluencePageRefs(snapshot: JiraIssueSnapshot): ConfluencePageRef[] {
  const siteUrl = siteUrlOf(snapshot);
  const refs: ConfluencePageRef[] = [];
  const seen = new Set<string>();

  const add = (url: string): void => {
    const pageId = extractPageId(url);
    if (pageId !== null) {
      if (seen.has(`id:${pageId}`)) return;
      seen.add(`id:${pageId}`);
      refs.push({ url, pageId });
    } else {
      if (seen.has(`url:${url}`)) return;
      seen.add(`url:${url}`);
      refs.push({ url, pageId: null, reason: 'unsupported_link' });
    }
  };

  for (const link of snapshot.remoteLinks) {
    if (link.url !== '' && link.applicationType?.toLowerCase().includes('confluence')) add(link.url);
  }
  const texts = [snapshot.descriptionText, ...snapshot.comments.map((c) => c.bodyText)];
  for (const text of texts) {
    for (const url of confluenceUrlsIn(text, siteUrl)) add(url);
  }
  return refs;
}

// Fetches one page as `userId` and converts its storage body to Markdown. Throws AtlassianApiError on failure.
export async function getPageMarkdown(userId: string, pageId: string): Promise<ConfluencePage> {
  if (!PAGE_ID_PATTERN.test(pageId)) {
    throw new AtlassianApiError(400, 'confluence', 'invalid_page_id', 'Invalid Confluence page id');
  }
  const [siteUrl, page] = await Promise.all([
    getSiteUrl(userId),
    atlassianJson<RawPage>(userId, 'confluence', `/wiki/api/v2/pages/${pageId}?body-format=storage`),
  ]);
  return {
    pageId: page.id,
    title: page.title ?? '',
    url: `${siteUrl}/wiki${page._links?.webui ?? `/pages/viewpage.action?pageId=${page.id}`}`,
    version: page.version?.number ?? 0,
    markdown: storageToMarkdown(page.body?.storage?.value ?? ''),
  };
}
