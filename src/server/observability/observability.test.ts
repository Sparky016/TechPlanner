import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../config';
import { getCorrelationId, newCorrelationId, runWithContext } from './context';
import { registerHealthCheck, runHealthChecks, unregisterHealthCheck } from './health';
import { createLogger } from './logger';
import { registry } from './metrics';
import { GET as healthz } from '@/app/healthz/route';
import { GET as metrics } from '@/app/metrics/route';

const validEnv: Record<string, string> = {
  ATLASSIAN_CLIENT_ID: 'client-id',
  ATLASSIAN_CLIENT_SECRET: 'client-secret',
  ATLASSIAN_CLOUD_ID: 'cloud-id',
  OAUTH_REDIRECT_URI: 'http://localhost:3000/api/auth/callback',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  DATABASE_URL: 'postgres://techplanner:techplanner@localhost:5432/techplanner',
  COPILOT_GITHUB_TOKEN: 'ghp_x',
  FACILITATOR_MODEL: 'model-a',
  EVALUATOR_MODEL: 'model-b',
  CONFLUENCE_SPACE_KEY: 'ENG',
  CONFLUENCE_PARENT_PAGE_ID: '12345',
  APP_BASE_URL: 'http://localhost:3000',
};

const original = process.env;

beforeEach(() => {
  process.env = { ...validEnv } as unknown as NodeJS.ProcessEnv;
  resetConfigForTests();
  // Replace the built-in database check so tests need no database.
  unregisterHealthCheck('database');
});

afterEach(() => {
  process.env = original;
  resetConfigForTests();
  unregisterHealthCheck('a');
  unregisterHealthCheck('b');
});

describe('logger', () => {
  it('redacts secret fields and includes the correlation id', () => {
    const lines: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = createLogger(dest);
    runWithContext({ correlationId: 'cid-1' }, () => {
      log.info(
        { accessToken: 'tok-secret', Authorization: 'Bearer abc', nested: { password: 'pw' }, ok: 'visible' },
        'hi',
      );
    });
    const out = lines.join('');
    const parsed = JSON.parse(out);
    expect(parsed.accessToken).toBe('[Redacted]');
    expect(parsed.nested.password).toBe('[Redacted]');
    expect(parsed.ok).toBe('visible');
    expect(parsed.correlationId).toBe('cid-1');
    expect(out).not.toContain('tok-secret');
    expect(out).not.toContain('Bearer abc');
  });
});

describe('correlation context', () => {
  it('keeps the id across awaits', async () => {
    const id = newCorrelationId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const seen = await runWithContext({ correlationId: id }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      await Promise.resolve();
      return getCorrelationId();
    });
    expect(seen).toBe(id);
    expect(getCorrelationId()).toBeUndefined();
  });
});

describe('/healthz', () => {
  it('returns 200 when all checks pass', async () => {
    registerHealthCheck('a', () => ({ ok: true }));
    const res = await healthz();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', checks: { a: { ok: true } } });
  });

  it('returns 503 when a check fails or throws', async () => {
    registerHealthCheck('a', () => ({ ok: false, detail: 'down' }));
    registerHealthCheck('b', () => {
      throw new Error('boom');
    });
    const res = await healthz();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('unhealthy');
    expect(body.checks.a.ok).toBe(false);
    expect(body.checks.b).toEqual({ ok: false, detail: 'boom' });
  });

  it('treats a check that exceeds its timeout as failed', async () => {
    registerHealthCheck('a', () => new Promise(() => {}));
    const report = await runHealthChecks(20);
    expect(report.ok).toBe(false);
    expect(report.checks.a.detail).toMatch(/timed out/);
  });
});

describe('/metrics', () => {
  const req = (auth?: string) =>
    new Request('http://localhost/metrics', { headers: auth ? { authorization: auth } : {} });

  it('returns 404 when METRICS_TOKEN is unset', async () => {
    expect((await metrics(req('Bearer anything'))).status).toBe(404);
  });

  it('returns 401 for a missing or wrong bearer and text for the right one', async () => {
    process.env.METRICS_TOKEN = 'm-token';
    expect((await metrics(req())).status).toBe(401);
    expect((await metrics(req('Bearer wrong'))).status).toBe(401);
    const ok = await metrics(req('Bearer m-token'));
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text).toContain('# TYPE http_request_duration_seconds histogram');
  });
});

describe('metric registration', () => {
  it('registers every required metric name', async () => {
    const names = (await registry.getMetricsAsJSON()).map((m) => m.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'http_request_duration_seconds',
        'llm_request_duration_seconds',
        'llm_tokens_total',
        'llm_errors_total',
        'atlassian_api_errors_total',
        'publish_step_failures_total',
        'readiness_score',
        'publish_total',
        'readiness_score_at_publish',
        'confluence_external_edit_total',
      ]),
    );
  });
});
