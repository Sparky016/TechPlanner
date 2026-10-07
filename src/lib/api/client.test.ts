// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, resetCsrfTokenForTests } from '@/lib/api/client';

const TOKEN = 'a'.repeat(43);
const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  resetCsrfTokenForTests();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('sends x-csrf-token and x-tab-id on POST', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/csrf' ? json({ token: TOKEN }) : json({ ok: true }),
    );
    await apiFetch('/api/x', { method: 'POST', json: { a: 1 } });
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('x-csrf-token')).toBe(TOKEN);
    expect(headers.get('x-tab-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.body).toBe('{"a":1}');
  });

  it('does not fetch a CSRF token for GET', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    await apiFetch('/api/x');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers((fetchMock.mock.calls[0] as [string, RequestInit])[1].headers).get('x-tab-id')).toBeTruthy();
  });

  it('surfaces the correlation id on errors', async () => {
    fetchMock.mockResolvedValue(
      json({ error: { message: 'Nope', code: 'bad', correlationId: 'corr-9' } }, 400),
    );
    const err = await apiFetch('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ message: 'Nope', status: 400, code: 'bad', correlationId: 'corr-9' });
  });

  it('redirects to /login on 401 reauth_required', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    fetchMock.mockResolvedValue(
      json({ error: { message: 'Sign in again', code: 'reauth_required', correlationId: 'c' } }, 401),
    );
    await expect(apiFetch('/api/x')).rejects.toBeInstanceOf(ApiError);
    expect(assign).toHaveBeenCalledWith('/login');
  });
});
