import { getConfig } from '@/server/config';
import { logger } from '@/server/observability/logger';

// Server-only: never import from src/lib or client components.
// Read-only Azure DevOps Repos access for the facilitator's code investigation tools. Uses one deployment-level PAT
// with the Code (Read) scope (ADR-0016). The PAT never appears in logs or errors.

const API_VERSION = '7.1';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_RETRIES = 2;
const MAX_WAIT_MS = 10_000;
/** Longest file body returned to the model; the rest is cut with a visible notice. */
export const MAX_FILE_CHARS = 40_000;
export const MAX_SEARCH_RESULTS = 25;
export const MAX_DIRECTORY_ENTRIES = 200;

export class AzureDevOpsError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AzureDevOpsError';
    this.status = status;
    this.code = code;
  }
}

export interface AdoRepository {
  id: string;
  name: string;
  defaultBranch: string | null;
  webUrl: string | null;
}

export interface AdoSearchHit {
  repository: string;
  path: string;
  branch: string | null;
  matchCount: number;
}

export interface AdoSearchResult {
  total: number;
  hits: AdoSearchHit[];
}

export interface AdoFile {
  repository: string;
  path: string;
  branch: string | null;
  content: string;
  truncated: boolean;
  binary: boolean;
}

export interface AdoDirectoryEntry {
  path: string;
  isFolder: boolean;
}

export function isAzureDevOpsEnabled(): boolean {
  const c = getConfig();
  return c.AZURE_DEVOPS_ORG_URL !== undefined && c.AZURE_DEVOPS_PROJECT !== undefined && c.AZURE_DEVOPS_PAT !== undefined;
}

function settings(): { orgUrl: string; project: string; pat: string; searchUrl: string; allowList: string[] | null } {
  const c = getConfig();
  if (!c.AZURE_DEVOPS_ORG_URL || !c.AZURE_DEVOPS_PROJECT || !c.AZURE_DEVOPS_PAT) {
    throw new AzureDevOpsError(0, 'ado_not_configured', 'Azure DevOps is not configured');
  }
  return {
    orgUrl: c.AZURE_DEVOPS_ORG_URL,
    project: c.AZURE_DEVOPS_PROJECT,
    pat: c.AZURE_DEVOPS_PAT,
    searchUrl: c.AZURE_DEVOPS_SEARCH_URL ?? searchUrlFor(c.AZURE_DEVOPS_ORG_URL),
    allowList: c.AZURE_DEVOPS_REPOSITORIES && c.AZURE_DEVOPS_REPOSITORIES.length > 0 ? c.AZURE_DEVOPS_REPOSITORIES : null,
  };
}

/** Code Search lives on almsearch.dev.azure.com for dev.azure.com orgs, and on the org host otherwise. */
export function searchUrlFor(orgUrl: string): string {
  const url = new URL(orgUrl);
  if (url.hostname === 'dev.azure.com') url.hostname = 'almsearch.dev.azure.com';
  return url.toString().replace(/\/+$/, '');
}

function isAllowed(name: string, allowList: string[] | null): boolean {
  return allowList === null || allowList.some((r) => r.toLowerCase() === name.toLowerCase());
}

function assertAllowed(name: string): void {
  if (!isAllowed(name, settings().allowList)) {
    throw new AzureDevOpsError(403, 'ado_repository_not_allowed', `Repository ${name} is not available to Tech Planner`);
  }
}

/** Repository-relative path: leading slash, no parent segments. */
export function normalisePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, '/');
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (withSlash.split('/').some((seg) => seg === '..')) {
    throw new AzureDevOpsError(400, 'ado_invalid_path', 'Path must not contain ".." segments');
  }
  return withSlash.replace(/\/{2,}/g, '/');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(res: Response, retry: number): number {
  const seconds = Number(res.headers.get('Retry-After'));
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * 2 ** retry;
  return Math.min(ms, MAX_WAIT_MS);
}

async function errorMessage(res: Response): Promise<string> {
  const fallback = res.statusText || `HTTP ${res.status}`;
  try {
    const body = JSON.parse(await res.text()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message !== '') return body.message;
  } catch {
    // Not JSON.
  }
  return fallback;
}

async function adoJson<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
  const { pat } = settings();
  const url = `${base}${path}${path.includes('?') ? '&' : '?'}api-version=${API_VERSION}`;
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  headers.set('Authorization', `Basic ${Buffer.from(`:${pat}`).toString('base64')}`);
  const route = path.split('?')[0];

  for (let retry = 0; ; retry++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      logger.warn({ route }, 'Azure DevOps unreachable');
      throw new AzureDevOpsError(0, 'ado_unreachable', 'Azure DevOps could not be reached');
    }
    // A rejected PAT is answered with 203 and an HTML sign-in page rather than 401.
    if (res.status === 203 || res.status === 401) {
      await res.body?.cancel();
      logger.warn({ route, status: res.status }, 'Azure DevOps rejected the credential');
      throw new AzureDevOpsError(401, 'ado_unauthorized', 'Azure DevOps rejected the configured credential');
    }
    if (res.ok) return (await res.json()) as T;
    if ((res.status === 429 || res.status === 503) && retry < MAX_BACKOFF_RETRIES) {
      const ms = backoffMs(res, retry);
      await res.body?.cancel();
      await wait(ms);
      continue;
    }
    const message = await errorMessage(res);
    logger.warn({ route, status: res.status }, 'Azure DevOps API call failed');
    throw new AzureDevOpsError(res.status, `ado_${res.status}`, message);
  }
}

function projectBase(): string {
  const { orgUrl, project } = settings();
  return `${orgUrl}/${encodeURIComponent(project)}/_apis`;
}

function repoPath(repository: string): string {
  return `/git/repositories/${encodeURIComponent(repository)}`;
}

function versionQuery(branch: string | undefined): string {
  return branch
    ? `&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch`
    : '';
}

function stripRefs(branch: string | null | undefined): string | null {
  return branch ? branch.replace(/^refs\/heads\//, '') : null;
}

interface RawRepository {
  id: string;
  name: string;
  defaultBranch?: string;
  webUrl?: string;
  isDisabled?: boolean;
}

export async function listRepositories(): Promise<AdoRepository[]> {
  const { allowList } = settings();
  const body = await adoJson<{ value?: RawRepository[] }>(projectBase(), '/git/repositories');
  return (body.value ?? [])
    .filter((r) => r.isDisabled !== true && isAllowed(r.name, allowList))
    .map((r) => ({ id: r.id, name: r.name, defaultBranch: stripRefs(r.defaultBranch), webUrl: r.webUrl ?? null }));
}

interface RawSearchResult {
  count?: number;
  results?: {
    path?: string;
    repository?: { name?: string };
    versions?: { branchName?: string }[];
    matches?: Record<string, unknown[] | undefined>;
  }[];
}

/** Azure DevOps Code Search across the allowed repositories, or one of them. */
export async function searchCode(text: string, opts: { repository?: string; top?: number } = {}): Promise<AdoSearchResult> {
  const { searchUrl, project, allowList } = settings();
  if (opts.repository !== undefined) assertAllowed(opts.repository);
  const repositories = opts.repository !== undefined ? [opts.repository] : allowList;
  const top = Math.min(opts.top ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
  const body = await adoJson<RawSearchResult>(
    `${searchUrl}/${encodeURIComponent(project)}/_apis`,
    '/search/codesearchresults',
    {
      method: 'POST',
      body: JSON.stringify({
        searchText: text,
        $skip: 0,
        $top: top,
        includeFacets: false,
        filters: { Project: [project], ...(repositories ? { Repository: repositories } : {}) },
      }),
    },
  );
  const hits = (body.results ?? [])
    .filter((r) => r.repository?.name !== undefined && isAllowed(r.repository.name, allowList))
    .map((r) => ({
      repository: r.repository?.name ?? '',
      path: r.path ?? '',
      branch: stripRefs(r.versions?.[0]?.branchName),
      matchCount: Object.values(r.matches ?? {}).reduce((n, m) => n + (m?.length ?? 0), 0),
    }));
  return { total: body.count ?? hits.length, hits };
}

interface RawItem {
  path?: string;
  isFolder?: boolean;
  content?: string;
  contentMetadata?: { isBinary?: boolean };
}

export async function getFileContent(repository: string, path: string, branch?: string): Promise<AdoFile> {
  assertAllowed(repository);
  const p = normalisePath(path);
  const item = await adoJson<RawItem>(
    projectBase(),
    `${repoPath(repository)}/items?path=${encodeURIComponent(p)}&includeContent=true${versionQuery(branch)}`,
  );
  if (item.isFolder) throw new AzureDevOpsError(400, 'ado_path_is_folder', `${p} is a folder; list it instead`);
  const binary = item.contentMetadata?.isBinary === true;
  const raw = binary ? '' : (item.content ?? '');
  return {
    repository,
    path: item.path ?? p,
    branch: branch ?? null,
    content: raw.slice(0, MAX_FILE_CHARS),
    truncated: raw.length > MAX_FILE_CHARS,
    binary,
  };
}

export async function listDirectory(repository: string, path: string, branch?: string): Promise<AdoDirectoryEntry[]> {
  assertAllowed(repository);
  const p = normalisePath(path);
  const body = await adoJson<{ value?: RawItem[] }>(
    projectBase(),
    `${repoPath(repository)}/items?scopePath=${encodeURIComponent(p)}&recursionLevel=OneLevel${versionQuery(branch)}`,
  );
  return (body.value ?? [])
    .filter((i) => i.path !== undefined && i.path !== p)
    .slice(0, MAX_DIRECTORY_ENTRIES)
    .map((i) => ({ path: i.path as string, isFolder: i.isFolder === true }));
}

/** Browser link to a file in Azure DevOps Repos. */
export function fileWebUrl(repository: string, path: string, branch?: string | null): string {
  const { orgUrl, project } = settings();
  const version = branch ? `&version=GB${encodeURIComponent(branch)}` : '';
  return `${orgUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}?path=${encodeURIComponent(normalisePath(path))}${version}`;
}
