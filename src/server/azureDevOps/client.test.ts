import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AzureDevOpsError,
  checkConnection,
  findRepository,
  fileWebUrl,
  getFileContent,
  listDirectory,
  listRepositories,
  MAX_FILE_CHARS,
  normalisePath,
  searchCode,
  searchUrlFor,
} from './client';

// Azure DevOps is mocked by stubbing global fetch.

const config: Record<string, unknown> = {};
vi.mock('@/server/config', () => ({ getConfig: () => config }));

const fetchMock = vi.fn<typeof fetch>();

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function call(i: number): { url: string; headers: Headers; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[i];
  return { url: String(url), headers: new Headers(init?.headers), init: init ?? {} };
}

beforeEach(() => {
  for (const k of Object.keys(config)) delete config[k];
  Object.assign(config, {
    AZURE_DEVOPS_ORG_URL: 'https://dev.azure.com/acme',
    AZURE_DEVOPS_PROJECT: 'Platform Team',
    AZURE_DEVOPS_PAT: 'pat-secret',
  });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('azure devops client', () => {
  it('lists repositories with basic auth, filtered by the allow-list', async () => {
    config.AZURE_DEVOPS_REPOSITORIES = ['API'];
    fetchMock.mockResolvedValueOnce(
      json(200, {
        value: [
          { id: '1', name: 'api', defaultBranch: 'refs/heads/main', webUrl: 'https://x/api' },
          { id: '2', name: 'web', defaultBranch: 'refs/heads/main' },
        ],
      }),
    );
    const repos = await listRepositories();
    expect(repos).toEqual([{ id: '1', name: 'api', defaultBranch: 'main', webUrl: 'https://x/api' }]);
    const { url, headers } = call(0);
    expect(url).toBe('https://dev.azure.com/acme/Platform%20Team/_apis/git/repositories?api-version=7.1');
    expect(headers.get('Authorization')).toBe(`Basic ${Buffer.from(':pat-secret').toString('base64')}`);
  });

  it('searches code on the almsearch host with project and repository filters', async () => {
    config.AZURE_DEVOPS_REPOSITORIES = ['api', 'web'];
    fetchMock.mockResolvedValueOnce(
      json(200, {
        count: 3,
        results: [
          { path: '/src/Refund.cs', repository: { name: 'api' }, versions: [{ branchName: 'main' }], matches: { content: [{}, {}] } },
          { path: '/x.cs', repository: { name: 'secret-repo' }, matches: {} },
        ],
      }),
    );
    const result = await searchCode('Refund');
    expect(result.hits).toEqual([{ repository: 'api', path: '/src/Refund.cs', branch: 'main', matchCount: 2 }]);
    const { url, init } = call(0);
    expect(url).toBe('https://almsearch.dev.azure.com/acme/Platform%20Team/_apis/search/codesearchresults?api-version=7.1');
    expect(JSON.parse(String(init.body))).toMatchObject({
      searchText: 'Refund',
      filters: { Project: ['Platform Team'], Repository: ['api', 'web'] },
    });
  });

  it('rejects a repository outside the allow-list without calling Azure DevOps', async () => {
    config.AZURE_DEVOPS_REPOSITORIES = ['api'];
    await expect(getFileContent('web', '/a.ts')).rejects.toMatchObject({ code: 'ado_repository_not_allowed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads a file on a branch and truncates oversize content', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { path: '/big.txt', content: 'x'.repeat(MAX_FILE_CHARS + 5) }));
    const file = await getFileContent('api', 'big.txt', 'feature/x');
    expect(file.truncated).toBe(true);
    expect(file.content).toHaveLength(MAX_FILE_CHARS);
    expect(call(0).url).toContain('/git/repositories/api/items?path=%2Fbig.txt&includeContent=true');
    expect(call(0).url).toContain('versionDescriptor.version=feature%2Fx&versionDescriptor.versionType=branch');
  });

  it('lists one directory level, excluding the folder itself', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { value: [{ path: '/src', isFolder: true }, { path: '/src/a.ts' }, { path: '/src/lib', isFolder: true }] }),
    );
    expect(await listDirectory('api', '/src')).toEqual([
      { path: '/src/a.ts', isFolder: false },
      { path: '/src/lib', isFolder: true },
    ]);
  });

  it('treats a 203 sign-in page as a rejected credential', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>sign in</html>', { status: 203 }));
    const err = await listRepositories().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AzureDevOpsError);
    expect(err).toMatchObject({ code: 'ado_unauthorized' });
    expect(String((err as Error).message)).not.toContain('pat-secret');
  });

  it('retries a 429 once Retry-After has passed', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(json(429, {}, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(json(200, { value: [] }));
    const pending = listRepositories();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces the Azure DevOps error message', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { message: 'TF401174: The item could not be found' }));
    await expect(getFileContent('api', '/missing.ts')).rejects.toMatchObject({
      status: 404,
      code: 'ado_404',
      message: 'TF401174: The item could not be found',
    });
  });

  it('reports a working connection with the available repositories', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { value: [{ id: '1', name: 'api', defaultBranch: 'refs/heads/main' }] }));
    expect(await checkConnection()).toEqual({
      configured: true,
      organization: 'https://dev.azure.com/acme',
      project: 'Platform Team',
      connected: true,
      repositories: [{ id: '1', name: 'api', defaultBranch: 'main', webUrl: null }],
    });
  });

  it('reports a failed connection without leaking the PAT', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>sign in</html>', { status: 203 }));
    const status = await checkConnection();
    expect(status).toMatchObject({
      configured: true,
      connected: false,
      error: { code: 'ado_unauthorized', message: 'Azure DevOps rejected the configured credential' },
    });
    expect(JSON.stringify(status)).not.toContain('pat-secret');
  });

  it('reports an unconfigured connection without calling Azure DevOps', async () => {
    delete config.AZURE_DEVOPS_PAT;
    expect(await checkConnection()).toEqual({ configured: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('finds a repository by name, case-insensitively', async () => {
    fetchMock.mockImplementation(async () => json(200, { value: [{ id: '1', name: 'Api' }] }));
    expect(await findRepository('api')).toMatchObject({ name: 'Api' });
    expect(await findRepository('web')).toBeNull();
  });

  it('refuses parent-directory paths', () => {
    expect(() => normalisePath('/src/../secrets')).toThrow(AzureDevOpsError);
    expect(normalisePath('src//a.ts')).toBe('/src/a.ts');
  });

  it('derives the search host and file links', () => {
    expect(searchUrlFor('https://dev.azure.com/acme')).toBe('https://almsearch.dev.azure.com/acme');
    expect(searchUrlFor('https://acme.visualstudio.com')).toBe('https://acme.visualstudio.com');
    expect(fileWebUrl('api', '/src/a.ts', 'main')).toBe(
      'https://dev.azure.com/acme/Platform%20Team/_git/api?path=%2Fsrc%2Fa.ts&version=GBmain',
    );
  });
});
