import { getValidAccessToken } from '@/server/auth/tokens';
import { getConfig } from '@/server/config';
import { logger } from '@/server/observability/logger';
import { countAtlassianApiError } from '@/server/observability/metrics';

// Server-only: never import from src/lib or client components.
// The only way code calls Jira or Confluence. Every call uses the acting user's own token (SR-1.2);
// rate limits are honoured with bounded retries (NFR-8). Tokens and headers never appear in logs or errors.

export type AtlassianProduct = 'jira' | 'confluence';

const MAX_BACKOFF_RETRIES = 3;
const MAX_WAIT_MS = 30_000;
const DEFAULT_WAITS_MS = [1_000, 2_000, 4_000];
const REQUEST_TIMEOUT_MS = 30_000;

// An Atlassian call failed. status 0 means Atlassian could not be reached (network error or timeout).
// Deliberately not an HttpError: an upstream 401/404 must not be echoed as this app's own status.
export class AtlassianApiError extends Error {
  readonly status: number;
  readonly product: AtlassianProduct;
  readonly code: string;

  constructor(status: number, product: AtlassianProduct, code: string, message: string) {
    super(message);
    this.name = 'AtlassianApiError';
    this.status = status;
    this.product = product;
    this.code = code;
  }
}

function buildUrl(product: AtlassianProduct, path: string): string {
  const config = getConfig();
  return `${config.ATLASSIAN_API_BASE_URL}/ex/${product}/${config.ATLASSIAN_CLOUD_ID}${path}`;
}

function buildHeaders(init: RequestInit, token: string): Headers {
  const headers = new Headers(init.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  // FormData sets its own multipart boundary; only plain string bodies default to JSON.
  if (typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

// Retry-After is either delay-seconds or an HTTP-date; fall back to 1 s, 2 s, 4 s. Each wait is capped at 30 s.
function backoffMs(res: Response, retry: number): number {
  const header = res.headers.get('Retry-After');
  let ms = DEFAULT_WAITS_MS[retry] ?? DEFAULT_WAITS_MS[DEFAULT_WAITS_MS.length - 1];
  if (header !== null && header.trim() !== '') {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      ms = seconds * 1000;
    } else {
      const date = Date.parse(header);
      if (!Number.isNaN(date)) ms = Math.max(0, date - Date.now());
    }
  }
  return Math.min(ms, MAX_WAIT_MS);
}

// Global setTimeout so tests can drive the wait with fake timers.
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Jira returns { errorMessages: [] }, Confluence { message }; 5xx bodies are often HTML.
async function errorMessage(res: Response): Promise<string> {
  const fallback = res.statusText || `HTTP ${res.status}`;
  let text: string;
  try {
    text = await res.text();
  } catch {
    return fallback;
  }
  try {
    const body = JSON.parse(text) as { errorMessages?: unknown; message?: unknown };
    if (Array.isArray(body.errorMessages)) {
      const messages = body.errorMessages.filter((m): m is string => typeof m === 'string' && m !== '');
      if (messages.length > 0) return messages.join('; ');
    }
    if (typeof body.message === 'string' && body.message !== '') return body.message;
  } catch {
    // Not JSON.
  }
  return fallback;
}

function logPath(path: string): string {
  // Query strings may carry user content (JQL, CQL); log the route only.
  return path.split('?')[0];
}

async function fail(product: AtlassianProduct, path: string, res: Response, attempt: number): Promise<never> {
  const message = await errorMessage(res);
  countAtlassianApiError(product, res.status);
  logger.warn({ product, status: res.status, path: logPath(path), attempt }, 'Atlassian API call failed');
  throw new AtlassianApiError(res.status, product, `atlassian_${res.status}`, message);
}

async function send(
  product: AtlassianProduct,
  path: string,
  init: RequestInit,
  token: string,
  attempt: number,
): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    return await fetch(buildUrl(product, path), { ...init, headers: buildHeaders(init, token), signal });
  } catch (err) {
    // The caller's own cancellation is not an Atlassian failure.
    if (init.signal?.aborted) throw err;
    const timedOut = timeout.aborted;
    countAtlassianApiError(product, 'network');
    logger.warn({ product, path: logPath(path), attempt, timedOut }, 'Atlassian API unreachable');
    throw new AtlassianApiError(
      0,
      product,
      timedOut ? 'atlassian_timeout' : 'atlassian_unreachable',
      timedOut ? 'Atlassian request timed out' : 'Atlassian could not be reached',
    );
  }
}

// Calls Atlassian as `userId`. A 401 forces one token refresh and retry; 429/503 back off up to 3 times.
// Non-2xx responses throw AtlassianApiError; ReauthRequiredError from the token store propagates unchanged.
export async function atlassianFetch(
  userId: string,
  product: AtlassianProduct,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  let token = await getValidAccessToken(userId);
  let refreshed = false;
  let backoffRetries = 0;

  for (let attempt = 1; ; attempt++) {
    const res = await send(product, path, init, token, attempt);
    if (res.ok) return res;

    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await res.body?.cancel();
      token = await getValidAccessToken(userId, { force: true });
      continue;
    }

    if ((res.status === 429 || res.status === 503) && backoffRetries < MAX_BACKOFF_RETRIES) {
      const ms = backoffMs(res, backoffRetries);
      backoffRetries++;
      await res.body?.cancel();
      logger.info({ product, status: res.status, path: logPath(path), attempt, waitMs: ms }, 'Atlassian backoff');
      await wait(ms);
      continue;
    }

    return fail(product, path, res, attempt);
  }
}

// atlassianFetch, parsed as JSON. 204 No Content yields undefined.
export async function atlassianJson<T>(
  userId: string,
  product: AtlassianProduct,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await atlassianFetch(userId, product, path, init);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
