import pino, { type DestinationStream, type Logger } from 'pino';
import { getContext } from './context';

// Server-only: never import from src/lib or client components.
// Operational logs only; Audit Records are a separate store (task 03).

const SENSITIVE_KEYS = [
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'password',
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
];

// Top-level keys, one level of nesting, and common request header locations.
export const REDACT_PATHS: string[] = [
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((k) => `*.${k}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'ATLASSIAN_CLIENT_SECRET',
  'COPILOT_GITHUB_TOKEN',
  'TOKEN_ENCRYPTION_KEY',
  'DOWNSTREAM_WEBHOOK_SECRET',
  'METRICS_TOKEN',
];

export function createLogger(destination?: DestinationStream): Logger {
  return pino(
    {
      level: process.env.LOG_LEVEL || 'info',
      redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
      // Attach the active correlation id / user id to every line.
      mixin: () => {
        const ctx = getContext();
        return ctx ? { correlationId: ctx.correlationId, ...(ctx.userId ? { userId: ctx.userId } : {}) } : {};
      },
    },
    destination,
  );
}

export const logger: Logger = createLogger();
