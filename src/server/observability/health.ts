// Server-only: never import from src/lib or client components.

export interface HealthCheckResult {
  ok: boolean;
  detail?: string;
}

export type HealthCheckFn = () => Promise<HealthCheckResult> | HealthCheckResult;

export interface HealthReport {
  ok: boolean;
  checks: Record<string, HealthCheckResult>;
}

export const HEALTH_CHECK_TIMEOUT_MS = 2000;

const checks = new Map<string, HealthCheckFn>();

export function registerHealthCheck(name: string, fn: HealthCheckFn): void {
  checks.set(name, fn);
}

export function unregisterHealthCheck(name: string): void {
  checks.delete(name);
}

async function runOne(fn: HealthCheckFn, timeoutMs: number): Promise<HealthCheckResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<HealthCheckResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, detail: `timed out after ${timeoutMs} ms` }), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(fn), timeout]);
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : 'check failed' };
  } finally {
    clearTimeout(timer);
  }
}

export async function runHealthChecks(timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS): Promise<HealthReport> {
  const entries = await Promise.all(
    [...checks].map(async ([name, fn]) => [name, await runOne(fn, timeoutMs)] as const),
  );
  const results = Object.fromEntries(entries);
  return { ok: entries.every(([, r]) => r.ok), checks: results };
}

// Built-in check. The pool is imported lazily so that importing this module never requires full configuration.
registerHealthCheck('database', async () => {
  const { query } = await import('@/server/db/pool');
  await query('SELECT 1');
  return { ok: true };
});
