import type { NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { recordAudit } from '@/server/audit/audit';
import { type CurrentUser, getCurrentUser } from '@/server/auth/session';
import { ReauthRequiredError } from '@/server/auth/tokens';
import { verifyCsrf } from '@/server/http/csrf';
import { HttpError } from '@/server/http/errors';
import { newCorrelationId, type RequestContext, runWithContext } from '@/server/observability/context';
import { logger } from '@/server/observability/logger';
import { observeHttpRequest } from '@/server/observability/metrics';

// Server-only: never import from src/lib or client components.
// The single wrapper every API route uses (§7.3, §8 Error handling, NFR-6).

export interface ApiContext<P> {
  req: NextRequest;
  params: P;
  user: CurrentUser | null;
  correlationId: string;
}

export interface ApiHandlerOptions {
  // Require an authenticated app session. Default true.
  auth?: boolean;
  // Validate CSRF. Default true for every method except GET/HEAD.
  csrf?: boolean;
}

type RouteArg<P> = { params: Promise<P> };

const SAFE_METHODS = new Set(['GET', 'HEAD']);

interface ErrorBody {
  error: {
    message: string;
    code?: string;
    correlationId: string;
    fields?: { path: string; message: string }[];
  };
}

function errorResponse(status: number, body: ErrorBody): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

// Path with each dynamic segment replaced by its param name, to keep the metrics label low-cardinality.
function routeLabel(pathname: string, params: unknown): string {
  if (!params || typeof params !== 'object') return pathname;
  const byValue = new Map<string, string>();
  for (const [name, value] of Object.entries(params as Record<string, unknown>)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v === 'string' && v !== '') byValue.set(v, name);
    }
  }
  return pathname
    .split('/')
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // keep the raw segment
      }
      const name = byValue.get(decoded);
      return name ? `[${name}]` : segment;
    })
    .join('/');
}

function withCorrelationHeader(res: Response, correlationId: string): Response {
  try {
    res.headers.set('x-correlation-id', correlationId);
    return res;
  } catch {
    // Immutable headers (e.g. Response.redirect): copy into a mutable response.
    const copy = new Response(res.body, res);
    copy.headers.set('x-correlation-id', correlationId);
    return copy;
  }
}

async function toErrorResponse(
  err: unknown,
  route: string,
  correlationId: string,
  user: CurrentUser | null,
): Promise<Response> {
  if (err instanceof ReauthRequiredError) {
    return errorResponse(401, {
      error: { message: err.message, code: err.code, correlationId },
    });
  }
  if (err instanceof HttpError) {
    return errorResponse(err.status, {
      error: {
        message: err.message,
        ...(err.code ? { code: err.code } : {}),
        correlationId,
      },
    });
  }
  if (err instanceof ZodError) {
    return errorResponse(400, {
      error: {
        message: 'Invalid request',
        code: 'validation_failed',
        correlationId,
        fields: err.issues.map((i) => ({
          path: i.path.map(String).join('.'),
          message: i.message,
        })),
      },
    });
  }

  const status = 500;
  const code = 'internal_error';
  logger.error({ err, route }, 'Unhandled error in API handler');
  try {
    await recordAudit({
      action: 'error',
      result: 'failure',
      userId: user?.accountId ?? null,
      userDisplayName: user?.displayName ?? null,
      details: { route, status, code, correlationId },
      correlationId,
    });
  } catch (auditErr) {
    logger.error({ err: auditErr, route }, 'Failed to record error audit');
  }
  // Generic message only; details stay in the logs.
  return errorResponse(status, {
    error: { message: 'Unexpected error', code, correlationId },
  });
}

export function withApiHandler<P = Record<string, never>>(
  opts: ApiHandlerOptions,
  handler: (ctx: ApiContext<P>) => Promise<Response>,
): (req: NextRequest, route: RouteArg<P>) => Promise<Response> {
  const auth = opts.auth ?? true;

  return (req, routeArg) => {
    const correlationId = newCorrelationId();
    const context: RequestContext = { correlationId };

    return runWithContext(context, async () => {
      const started = performance.now();
      let route = req.nextUrl.pathname;
      let user: CurrentUser | null = null;
      let res: Response;
      try {
        const params = await routeArg.params;
        route = routeLabel(req.nextUrl.pathname, params);
        if (opts.csrf ?? !SAFE_METHODS.has(req.method)) verifyCsrf(req);
        user = await getCurrentUser(req);
        if (user) context.userId = user.accountId;
        if (auth && !user) throw new HttpError(401, 'Not authenticated', 'unauthenticated');
        res = await handler({ req, params, user, correlationId });
      } catch (err) {
        res = await toErrorResponse(err, route, correlationId, user);
      }
      res = withCorrelationHeader(res, correlationId);
      observeHttpRequest(route, req.method, res.status, (performance.now() - started) / 1000);
      return res;
    });
  };
}
