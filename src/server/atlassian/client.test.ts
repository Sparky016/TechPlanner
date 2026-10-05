import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReauthRequiredError, getValidAccessToken } from '@/server/auth/tokens';
import { logger } from '@/server/observability/logger';
import { atlassianApiErrors } from '@/server/observability/metrics';
import { AtlassianApiError, atlassianFetch, atlassianJson } from './client';

// Atlassian is mocked by stubbing global fetch (undici is not a project dependency).

vi.mock('@/server/config', () => ({
  getConfig: () => ({ ATLASSIAN_CLOUD_ID: 'cloud-123' }),
}));

vi.mock('@/server/auth/tokens', () => {
  class ReauthRequiredError extends Error {
    readonly code = 'reauth_required';
  }
  return { ReauthRequiredError, getValidAccessToken: vi.fn() };
});

const tokenMock = vi.mocked(getValidAccessToken);
const fetchMock = vi.fn<typeof fetch>();

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function call(i: number): { url: string; headers: Headers; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[i];
  return { url: String(url), headers: new Headers(init?.headers), init: init ?? {} };
}

async function errorCount(product: string, status: string): Promise<number> {
  const metric = await atlassianApiErrors.get();
  return metric.values.find((v) => v.labels.product === product && v.labels.status === status)?.value ?? 0;
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  atlassianApiErrors.reset();
  fetchMock.mockReset();
  tokenMock.mockReset();
  tokenMock.mockImplementation(async (_userId, opts) => (opts?.force ? 'token-refreshed' : 'token-initial'));
  vi.stubGlobal('fetch', fetchMock);
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('atlassianFetch request shape', () => {
  it('sends the user bearer token to the configured cloud id (AC3)', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));

    await atlassianFetch('user-1', 'jira', '/rest/api/3/myself');

    expect(tokenMock).toHaveBeenCalledWith('user-1');
    const { url, headers } = call(0);
    expect(url).toBe('https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/myself');
    expect(headers.get('Authorization')).toBe('Bearer token-initial');
    expect(headers.get('Accept')).toBe('application/json');
  });

  it('builds Confluence URLs under the confluence product', async () => {
    fetchMock.mockResolvedValueOnce(json(200, {}));

    await atlassianFetch('user-1', 'confluence', '/wiki/api/v2/pages/1');

    expect(call(0).url).toBe('https://api.atlassian.com/ex/confluence/cloud-123/wiki/api/v2/pages/1');
  });

  it('keeps an overridden Accept and never lets the caller replace Authorization', async () => {
    fetchMock.mockResolvedValueOnce(json(200, {}));

    await atlassianFetch('user-1', 'jira', '/rest/api/3/x', {
      headers: { Accept: 'text/html', Authorization: 'Bearer someone-else' },
    });

    const { headers } = call(0);
    expect(headers.get('Accept')).toBe('text/html');
    expect(headers.get('Authorization')).toBe('Bearer token-initial');
  });

  it('defaults Content-Type to JSON for string bodies but not for FormData', async () => {
    fetchMock.mockImplementation(async () => json(200, {}));

    await atlassianFetch('user-1', 'jira', '/rest/api/3/issue', { method: 'POST', body: '{}' });
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.txt');
    await atlassianFetch('user-1', 'confluence', '/wiki/rest/api/content/1/child/attachment', {
      method: 'POST',
      body: form,
    });

    expect(call(0).headers.get('Content-Type')).toBe('application/json');
    expect(call(1).headers.has('Content-Type')).toBe(false);
  });
});

describe('atlassianFetch 401 handling (AC1)', () => {
  it('forces exactly one refresh and retries with the new token', async () => {
    fetchMock.mockResolvedValueOnce(json(401, {})).mockResolvedValueOnce(json(200, { ok: true }));

    const res = await atlassianFetch('user-1', 'jira', '/rest/api/3/myself');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tokenMock).toHaveBeenCalledTimes(2);
    expect(tokenMock).toHaveBeenNthCalledWith(2, 'user-1', { force: true });
    expect(call(1).headers.get('Authorization')).toBe('Bearer token-refreshed');
  });

  it('throws AtlassianApiError on a second 401 without refreshing again', async () => {
    fetchMock.mockImplementation(async () => json(401, { message: 'Unauthorized' }));

    const err = await atlassianFetch('user-1', 'jira', '/rest/api/3/myself').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AtlassianApiError);
    expect(err).toMatchObject({ status: 401, product: 'jira', code: 'atlassian_401', message: 'Unauthorized' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tokenMock.mock.calls.filter(([, opts]) => opts?.force)).toHaveLength(1);
  });

  it('propagates ReauthRequiredError when the forced refresh fails', async () => {
    fetchMock.mockResolvedValueOnce(json(401, {}));
    tokenMock.mockResolvedValueOnce('token-initial').mockRejectedValueOnce(new ReauthRequiredError());

    await expect(atlassianFetch('user-1', 'jira', '/rest/api/3/myself')).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('atlassianFetch rate limiting (AC2)', () => {
  it('waits Retry-After seconds then retries', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(json(429, {}, { 'Retry-After': '2' })).mockResolvedValueOnce(json(200, {}));

    const p = atlassianFetch('user-1', 'jira', '/rest/api/3/search');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const res = await p;

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws AtlassianApiError 429 after 3 retries', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => json(429, { errorMessages: ['Rate limited'] }, { 'Retry-After': '2' }));

    const p = atlassianFetch('user-1', 'jira', '/rest/api/3/search');
    const assertion = expect(p).rejects.toMatchObject({ status: 429, code: 'atlassian_429', message: 'Rate limited' });
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('uses 1 s, 2 s, 4 s when Retry-After is absent and caps waits at 30 s', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(json(503, {}))
      .mockResolvedValueOnce(json(503, {}))
      .mockResolvedValueOnce(json(429, {}, { 'Retry-After': '120' }))
      .mockResolvedValueOnce(json(200, {}));

    const p = atlassianFetch('user-1', 'confluence', '/wiki/api/v2/spaces');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).status).toBe(200);
  });
});

describe('atlassianFetch error paths (AC4)', () => {
  it('maps non-2xx to AtlassianApiError with joined errorMessages and counts the metric', async () => {
    fetchMock.mockResolvedValueOnce(json(400, { errorMessages: ['Field a is bad', 'Field b is bad'] }));

    const err = await atlassianFetch('user-1', 'jira', '/rest/api/3/issue').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AtlassianApiError);
    expect(err).toMatchObject({ status: 400, product: 'jira', message: 'Field a is bad; Field b is bad' });
    expect(await errorCount('jira', '400')).toBe(1);
  });

  it('falls back to statusText for non-JSON bodies', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>down</html>', { status: 502, statusText: 'Bad Gateway' }));

    await expect(atlassianFetch('user-1', 'confluence', '/wiki/x')).rejects.toMatchObject({
      status: 502,
      message: 'Bad Gateway',
    });
    expect(await errorCount('confluence', '502')).toBe(1);
  });

  it('does not count recovered 401/429 responses as errors', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(429, {}, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(json(200, {}));

    const p = atlassianFetch('user-1', 'jira', '/rest/api/3/x');
    await vi.runAllTimersAsync();
    expect((await p).status).toBe(200);
    expect((await atlassianApiErrors.get()).values.filter((v) => v.value > 0)).toHaveLength(0);
  });

  it('logs no token, Authorization header or query string', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => json(429, {}, { 'Retry-After': '1' }));

    const p = atlassianFetch('user-1', 'jira', '/rest/api/3/search?jql=secret-jql', {
      headers: { 'X-Custom': 'y' },
    });
    const assertion = expect(p).rejects.toBeInstanceOf(AtlassianApiError);
    await vi.runAllTimersAsync();
    await assertion;

    expect(warnSpy).toHaveBeenCalled();
    const logged = JSON.stringify([...warnSpy.mock.calls, ...infoSpy.mock.calls]);
    expect(logged).not.toMatch(/authorization/i);
    expect(logged).not.toContain('token-initial');
    expect(logged).not.toContain('Bearer');
    expect(logged).not.toContain('secret-jql');
    expect(await errorCount('jira', '429')).toBe(1);
  });

  it('maps network failures to AtlassianApiError status 0 and counts them', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(atlassianFetch('user-1', 'jira', '/rest/api/3/x')).rejects.toMatchObject({
      status: 0,
      code: 'atlassian_unreachable',
    });
    expect(await errorCount('jira', 'network')).toBe(1);
  });

  it('rethrows the caller abort unchanged', async () => {
    const controller = new AbortController();
    const abortErr = new DOMException('aborted', 'AbortError');
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      throw abortErr;
    });

    await expect(
      atlassianFetch('user-1', 'jira', '/rest/api/3/x', { signal: controller.signal }),
    ).rejects.toBe(abortErr);
  });
});

describe('atlassianJson', () => {
  it('parses JSON bodies', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { key: 'ABC-1' }));
    await expect(atlassianJson<{ key: string }>('user-1', 'jira', '/rest/api/3/issue/ABC-1')).resolves.toEqual({
      key: 'ABC-1',
    });
  });

  it('returns undefined for 204', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(atlassianJson('user-1', 'jira', '/rest/api/3/issue/ABC-1')).resolves.toBeUndefined();
  });
});
