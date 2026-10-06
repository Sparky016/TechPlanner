import { accessibleResourcesUrl } from '@/server/auth/atlassianOAuth';
import { getValidAccessToken } from '@/server/auth/tokens';
import { getConfig } from '@/server/config';
import { AtlassianApiError, atlassianJson } from './client';
import { adfToText } from './adfToText';

// Server-only: never import from src/lib or client components.
// Reads a Jira ticket as the acting user (SR-2.1, SR-2.2) and normalises it for session creation and the AI context.

const ISSUE_FIELDS =
  'summary,description,issuetype,status,priority,assignee,reporter,labels,components,fixVersions,parent,issuelinks,attachment,comment';
const COMMENT_PAGE_SIZE = 100;
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]+-[1-9]\d*$/;

export interface JiraIssueSnapshot {
  key: string;
  url: string;
  summary: string;
  descriptionText: string;
  issueType: string | null;
  status: string | null;
  priority: string | null;
  assignee: string | null;
  reporter: string | null;
  labels: string[];
  components: string[];
  fixVersions: string[];
  parent: { key: string; summary: string } | null;
  issueLinks: {
    type: string;
    direction: 'inward' | 'outward';
    key: string;
    summary: string;
  }[];
  comments: {
    id: string;
    author: string | null;
    created: string;
    bodyText: string;
  }[];
  attachments: {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    contentUrl: string;
  }[];
  remoteLinks: { url: string; title: string; applicationType: string | null }[];
}

interface NamedRef {
  name?: string;
  displayName?: string;
}

interface RawLinkedIssue {
  key: string;
  fields?: { summary?: string };
}

interface RawIssueLink {
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: RawLinkedIssue;
  outwardIssue?: RawLinkedIssue;
}

interface RawIssue {
  fields: {
    summary?: string;
    description?: unknown;
    issuetype?: NamedRef | null;
    status?: NamedRef | null;
    priority?: NamedRef | null;
    assignee?: NamedRef | null;
    reporter?: NamedRef | null;
    labels?: string[];
    components?: NamedRef[];
    fixVersions?: NamedRef[];
    parent?: RawLinkedIssue | null;
    issuelinks?: RawIssueLink[];
    attachment?: {
      id: string;
      filename: string;
      mimeType?: string;
      size?: number;
      content?: string;
    }[];
  };
}

interface RawComment {
  id: string;
  author?: NamedRef | null;
  created: string;
  body?: unknown;
}

interface RawCommentPage {
  total?: number;
  comments?: RawComment[];
}

interface RawRemoteLink {
  object?: { url?: string; title?: string };
  application?: { type?: string; name?: string };
}

export function isValidIssueKey(key: string): boolean {
  return typeof key === 'string' && ISSUE_KEY_PATTERN.test(key);
}

let siteUrlPromise: Promise<string> | undefined;

// Site URL of the configured cloud id, cached per process. A failed lookup is not cached.
export function getSiteUrl(userId: string): Promise<string> {
  siteUrlPromise ??= lookupSiteUrl(userId).catch((err: unknown) => {
    siteUrlPromise = undefined;
    throw err;
  });
  return siteUrlPromise;
}

export function resetSiteUrlCache(): void {
  siteUrlPromise = undefined;
}

async function lookupSiteUrl(userId: string): Promise<string> {
  const cloudId = getConfig().ATLASSIAN_CLOUD_ID;
  const token = await getValidAccessToken(userId);
  let res: Response;
  try {
    res = await fetch(accessibleResourcesUrl(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new AtlassianApiError(0, 'jira', 'atlassian_unreachable', 'Atlassian could not be reached');
  }
  if (!res.ok) {
    throw new AtlassianApiError(res.status, 'jira', `atlassian_${res.status}`, 'Could not resolve the Atlassian site');
  }
  const resources = (await res.json()) as { id: string; url: string }[];
  const site = resources.find((r) => r.id === cloudId);
  if (!site) {
    throw new AtlassianApiError(404, 'jira', 'atlassian_site_not_found', 'Configured Atlassian site is not accessible');
  }
  return site.url.replace(/\/+$/, '');
}

function name(ref: NamedRef | null | undefined): string | null {
  return ref?.displayName ?? ref?.name ?? null;
}

function names(refs: NamedRef[] | undefined): string[] {
  return (refs ?? []).map((r) => name(r)).filter((n): n is string => n !== null);
}

async function fetchAllComments(userId: string, key: string): Promise<RawComment[]> {
  const all: RawComment[] = [];
  for (;;) {
    const page = await atlassianJson<RawCommentPage>(
      userId,
      'jira',
      `/rest/api/3/issue/${key}/comment?startAt=${all.length}&maxResults=${COMMENT_PAGE_SIZE}`,
    );
    const batch = page.comments ?? [];
    all.push(...batch);
    if (batch.length === 0 || all.length >= (page.total ?? 0)) return all;
  }
}

function mapIssueLinks(links: RawIssueLink[]): JiraIssueSnapshot['issueLinks'] {
  const result: JiraIssueSnapshot['issueLinks'] = [];
  for (const link of links) {
    if (link.outwardIssue) {
      result.push({
        type: link.type?.outward ?? link.type?.name ?? '',
        direction: 'outward',
        key: link.outwardIssue.key,
        summary: link.outwardIssue.fields?.summary ?? '',
      });
    }
    if (link.inwardIssue) {
      result.push({
        type: link.type?.inward ?? link.type?.name ?? '',
        direction: 'inward',
        key: link.inwardIssue.key,
        summary: link.inwardIssue.fields?.summary ?? '',
      });
    }
  }
  return result;
}

// Fetches the ticket, all its comments and remote links as `userId`. Throws AtlassianApiError on failure.
export async function getIssueSnapshot(userId: string, key: string): Promise<JiraIssueSnapshot> {
  if (!isValidIssueKey(key)) {
    throw new AtlassianApiError(400, 'jira', 'invalid_issue_key', 'Invalid Jira issue key');
  }
  const [siteUrl, issue, comments, remoteLinks] = await Promise.all([
    getSiteUrl(userId),
    atlassianJson<RawIssue>(userId, 'jira', `/rest/api/3/issue/${key}?fields=${ISSUE_FIELDS}`),
    fetchAllComments(userId, key),
    atlassianJson<RawRemoteLink[]>(userId, 'jira', `/rest/api/3/issue/${key}/remotelink`),
  ]);
  const f = issue.fields;

  return {
    key,
    url: `${siteUrl}/browse/${key}`,
    summary: f.summary ?? '',
    descriptionText: adfToText(f.description),
    issueType: name(f.issuetype),
    status: name(f.status),
    priority: name(f.priority),
    assignee: name(f.assignee),
    reporter: name(f.reporter),
    labels: f.labels ?? [],
    components: names(f.components),
    fixVersions: names(f.fixVersions),
    parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary ?? '' } : null,
    issueLinks: mapIssueLinks(f.issuelinks ?? []),
    comments: comments.map((c) => ({
      id: c.id,
      author: name(c.author),
      created: c.created,
      bodyText: adfToText(c.body),
    })),
    attachments: (f.attachment ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType ?? '',
      size: a.size ?? 0,
      contentUrl: a.content ?? '',
    })),
    remoteLinks: (remoteLinks ?? []).map((r) => ({
      url: r.object?.url ?? '',
      title: r.object?.title ?? '',
      applicationType: r.application?.type ?? r.application?.name ?? null,
    })),
  };
}
