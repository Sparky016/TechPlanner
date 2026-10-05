import { getTabId } from '@/lib/api/tabId';

// Browser-only. Every client call to /api goes through apiFetch (CSRF, tab id, JSON, error shape; §8).

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly correlationId: string | undefined,
    // The full parsed error response body, for fields such as unreadable / existingSessionIds.
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);
let csrfToken: string | null = null;

async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON error body
  }
  const err = (body as { error?: { message?: string; code?: string; correlationId?: string } } | null)?.error;
  return new ApiError(
    err?.message ?? `Request failed (${res.status})`,
    res.status,
    err?.code,
    err?.correlationId ?? res.headers.get('x-correlation-id') ?? undefined,
    body,
  );
}

async function loadCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  const res = await fetch('/api/csrf', { credentials: 'same-origin' });
  if (!res.ok) throw await toApiError(res);
  csrfToken = ((await res.json()) as { token: string }).token;
  return csrfToken;
}

export function resetCsrfTokenForTests(): void {
  csrfToken = null;
}

async function send(path: string, init: RequestInit, method: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-tab-id', getTabId());
  if (!SAFE_METHODS.has(method)) headers.set('x-csrf-token', await loadCsrfToken());
  if (init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(path, { ...init, method, headers, credentials: 'same-origin' });
}

export type ApiInit = Omit<RequestInit, 'body'> & { json?: unknown };

// JSON in/out. `json` is serialised as the body. Throws ApiError on any non-2xx response; a 401 reauth_required
// also sends the browser to /login.
export async function apiFetch<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
  const res = await apiFetchResponse(path, init);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// Same headers, retry and error handling as apiFetch, but returns the successful Response unread (e.g. an SSE
// stream).
export async function apiFetchResponse(path: string, init: ApiInit = {}): Promise<Response> {
  const { json, ...rest } = init;
  const method = (rest.method ?? 'GET').toUpperCase();
  const withBody: RequestInit = json === undefined ? rest : { ...rest, body: JSON.stringify(json) };

  let res = await send(path, withBody, method);
  if (res.status === 403 && !SAFE_METHODS.has(method)) {
    // Possibly a stale CSRF token: fetch a new one and retry once.
    csrfToken = null;
    res = await send(path, withBody, method);
  }

  if (!res.ok) {
    const err = await toApiError(res);
    if (res.status === 401 && err.code === 'reauth_required' && typeof window !== 'undefined') {
      window.location.assign('/login');
    }
    throw err;
  }
  return res;
}
