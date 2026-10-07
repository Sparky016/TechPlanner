// Server-only: never import from src/lib or client components.

export type JobHandler = (data: unknown) => Promise<void>;

// Throw from a handler to fail the job terminally without pg-boss retries.
export class NonRetryableJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NonRetryableJobError';
  }
}

const handlers = new Map<string, JobHandler>();

export function registerHandler(name: string, fn: JobHandler): void {
  if (handlers.has(name)) throw new Error(`Handler already registered for job: ${name}`);
  handlers.set(name, fn);
}

export function getHandlers(): ReadonlyMap<string, JobHandler> {
  return handlers;
}

export function clearHandlersForTests(): void {
  handlers.clear();
}
