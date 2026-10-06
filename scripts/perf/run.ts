import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { AUTOSAVE_MAX_WAIT_MS } from '../../src/components/workspace/center/useAutosave';
import { APP_ENV } from '../../tests/e2e/support/env';

// Performance verification against NFR-1..NFR-5 (task 41). Drives the app over HTTP, the way the browser does:
// OAuth login against the Atlassian mock from task 39, then the session, working-copy, message (SSE), lock and
// evaluate endpoints. By default it starts its own isolated stack (mock, production build served by `next start`,
// worker, own database) so it cannot collide with the E2E suite; --attach drives an already running stack instead.
//
//   npm run perf                                  latency scenario, p50/p95 per metric
//   npm run perf -- --scenario concurrency        N concurrent sessions (messages + autosaves) for --duration-s
//   npm run perf -- --real-llm                    real Copilot SDK (needs COPILOT_GITHUB_TOKEN and model ids)

const ROOT = process.cwd();
const { values: args } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'latency' }, // latency | concurrency | all
    iterations: { type: 'string', default: '20' },
    sessions: { type: 'string', default: '50' },
    'duration-s': { type: 'string', default: '300' },
    'think-ms': { type: 'string', default: '10000' }, // pause between one session's messages
    'autosave-ms': { type: 'string', default: '3000' }, // autosave cadence per session (client max wait is 5 s)
    'fake-latency-ms': { type: 'string', default: '0' }, // added before every scripted LLM run (fake mode)
    'request-timeout-s': { type: 'string', default: '60' }, // a request (incl. a whole SSE turn) slower than this is an error
    'real-llm': { type: 'boolean', default: false },
    attach: { type: 'boolean', default: false },
    dev: { type: 'boolean', default: false }, // next dev instead of build + next start
    'skip-build': { type: 'boolean', default: false },
    'app-port': { type: 'string', default: '3200' },
    'mock-port': { type: 'string', default: '4110' },
    'base-url': { type: 'string' },
    'database-url': { type: 'string', default: 'postgres://techplanner:techplanner@localhost:5432/techplanner_perf' },
    json: { type: 'string' },
  },
});

const num = (v: string | undefined, name: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
  return n;
};
const scenario = args.scenario as string;
if (!['latency', 'concurrency', 'all'].includes(scenario)) throw new Error('--scenario must be latency|concurrency|all');
const iterations = num(args.iterations, 'iterations');
const sessionCount = num(args.sessions, 'sessions');
const durationMs = num(args['duration-s'], 'duration-s') * 1000;
const thinkMs = num(args['think-ms'], 'think-ms');
const autosaveMs = num(args['autosave-ms'], 'autosave-ms');
const fakeLatencyMs = num(args['fake-latency-ms'], 'fake-latency-ms');
const requestTimeoutMs = num(args['request-timeout-s'], 'request-timeout-s') * 1000;
const realLlm = args['real-llm'] === true;
const appPort = num(args['app-port'], 'app-port');
const mockPort = num(args['mock-port'], 'mock-port');
const BASE_URL = args['base-url'] ?? `http://localhost:${appPort}`;
const MOCK_URL = `http://localhost:${mockPort}`;
const DATABASE_URL = args['database-url'] as string;
const METRICS_TOKEN = 'perf-metrics-token';

// ---- statistics ----------------------------------------------------------------------------------------------

class Samples {
  readonly values: number[] = [];
  add(ms: number): void {
    this.values.push(ms);
  }
  /** Nearest-rank percentile in ms, or null without samples. */
  pct(p: number): number | null {
    if (this.values.length === 0) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  }
  summary() {
    return {
      n: this.values.length,
      p50: this.pct(50),
      p95: this.pct(95),
      max: this.pct(100),
    };
  }
}

const fmt = (ms: number | null): string => (ms === null ? 'n/a' : `${Math.round(ms)} ms`);

function printTable(title: string, rows: [string, Samples][]): void {
  console.log(`\n${title}`);
  console.log(`${'metric'.padEnd(34)}${'n'.padStart(6)}${'p50'.padStart(12)}${'p95'.padStart(12)}${'max'.padStart(12)}`);
  for (const [name, s] of rows) {
    const x = s.summary();
    console.log(
      `${name.padEnd(34)}${String(x.n).padStart(6)}${fmt(x.p50).padStart(12)}${fmt(x.p95).padStart(12)}${fmt(x.max).padStart(12)}`,
    );
  }
}

// ---- HTTP client (cookie jar, CSRF, origin) ------------------------------------------------------------------

class Client_ {
  private cookies = new Map<string, string>();
  private csrf = '';

  private absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/Max-Age=0/i.test(line) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async raw(url: string, init: RequestInit & { tabId?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('cookie', this.cookieHeader());
    headers.set('origin', BASE_URL);
    if (this.csrf) headers.set('x-csrf-token', this.csrf);
    if (init.tabId) headers.set('x-tab-id', init.tabId);
    const res = await fetch(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(requestTimeoutMs) });
    this.absorb(res);
    return res;
  }

  async api(method: string, path: string, opts: { body?: unknown; tabId?: string } = {}): Promise<Response> {
    return this.raw(`${BASE_URL}${path}`, {
      method,
      tabId: opts.tabId,
      headers: opts.body === undefined ? {} : { 'content-type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  /** OAuth 3LO login against the mock, then the data-notice acknowledgement and a CSRF token. */
  async login(): Promise<void> {
    const start = await this.raw(`${BASE_URL}/auth/login`);
    const authorizeUrl = start.headers.get('location');
    if (!authorizeUrl) throw new Error(`login did not redirect (HTTP ${start.status})`);
    const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
    const callbackUrl = authorize.headers.get('location');
    if (!callbackUrl) throw new Error(`authorize did not redirect (HTTP ${authorize.status})`);
    const callback = await this.raw(callbackUrl);
    if (!this.cookies.has('tp_session') && ![...this.cookies.keys()].some((k) => k.includes('session'))) {
      throw new Error(`login failed: callback redirected to ${callback.headers.get('location')}`);
    }
    const csrf = (await (await this.api('GET', '/api/csrf')).json()) as { token: string };
    this.csrf = csrf.token;
    await this.api('POST', '/api/me/ack-data-notice');
  }
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- SSE turn ------------------------------------------------------------------------------------------------

interface TurnResult {
  ok: boolean;
  error?: string;
  firstTokenMs: number | null;
  patchMs: number | null;
  totalMs: number;
}

/** Sends one facilitator message and consumes the SSE stream, timing the first token and the first patch event. */
async function sendTurn(c: Client_, sessionId: string, tabId: string, text: string): Promise<TurnResult> {
  const t0 = performance.now();
  try {
    return await readTurn(c, sessionId, tabId, text, t0);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), firstTokenMs: null, patchMs: null, totalMs: performance.now() - t0 };
  }
}

async function readTurn(c: Client_, sessionId: string, tabId: string, text: string, t0: number): Promise<TurnResult> {
  const res = await c.api('POST', `/api/sessions/${sessionId}/messages`, { body: { text }, tabId });
  if (!res.ok || !res.body) {
    return { ok: false, error: `HTTP ${res.status}`, firstTokenMs: null, patchMs: null, totalMs: performance.now() - t0 };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstTokenMs: number | null = null;
  let patchMs: number | null = null;
  let error: string | undefined;
  let done = false;
  for (;;) {
    const { done: eof, value } = await reader.read();
    if (eof) break;
    const now = performance.now() - t0;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (frame.includes('event: token') && firstTokenMs === null) firstTokenMs = now;
      if (frame.includes('event: patch') && patchMs === null) patchMs = now;
      if (frame.includes('event: error')) error = frame.replace(/\s+/g, ' ').slice(0, 200);
      if (frame.includes('event: done')) done = true;
      end = buffer.indexOf('\n\n');
    }
  }
  if (!error && !done) error = 'stream ended without a done event';
  return { ok: !error, error, firstTokenMs, patchMs, totalMs: performance.now() - t0 };
}

// The facilitator scenario of the E2E fixture: streams text, patches the Executive Summary, then finishes.
const FACILITATOR_TEXT = realLlm
  ? 'Summarise the goal of this ticket in two sentences and update the Executive Summary.'
  : 'Please summarise the goal. #stream';
const PATCH_MARKER = 'E2E live patch: users export the report as CSV.';

// ---- scenarios -----------------------------------------------------------------------------------------------

interface WorkingCopy {
  version: number;
  sections: Record<string, { body: string }>;
}

async function createPerfSession(c: Client_, samples?: Samples): Promise<string> {
  const t0 = performance.now();
  const res = await c.api('POST', '/api/sessions', { body: { ticketKeys: ['ABC-123'], confirmDuplicate: true } });
  const body = await json<{ session: { id: string } }>(res, 'create session');
  samples?.add(performance.now() - t0);
  return body.session.id;
}

async function latencyScenario(c: Client_) {
  const m = {
    create: new Samples(),
    open: new Samples(),
    firstToken: new Samples(),
    patchVisible: new Samples(),
    turn: new Samples(),
    evaluate: new Samples(),
  };
  let errors = 0;
  for (let i = 0; i < iterations; i++) {
    const tabId = randomUUID();
    try {
      const id = await createPerfSession(c, m.create);

      // Session open: the page plus the data calls the workspace makes on load, in parallel.
      const o0 = performance.now();
      const open = await Promise.all([
        c.raw(`${BASE_URL}/sessions/${id}`),
        c.api('GET', `/api/sessions/${id}`),
        c.api('GET', `/api/sessions/${id}/working-copy`),
        c.api('GET', `/api/sessions/${id}/messages`),
        c.api('POST', `/api/sessions/${id}/lock`, { tabId }),
      ]);
      if (open.some((r) => !r.ok)) throw new Error(`open: HTTP ${open.map((r) => r.status).join(',')}`);
      await Promise.all(open.map((r) => r.arrayBuffer()));
      m.open.add(performance.now() - o0);

      const turn = await sendTurn(c, id, tabId, FACILITATOR_TEXT);
      if (!turn.ok) throw new Error(`turn: ${turn.error}`);
      if (turn.firstTokenMs !== null) m.firstToken.add(turn.firstTokenMs);
      m.turn.add(turn.totalMs);
      if (turn.patchMs !== null && !realLlm) {
        // Patch visible: the patch frame arrived; time until the working copy endpoint serves the patched text.
        const p0 = performance.now();
        for (;;) {
          const wc = await json<WorkingCopy>(await c.api('GET', `/api/sessions/${id}/working-copy`), 'working copy');
          if (wc.sections['Executive Summary']?.body.includes(PATCH_MARKER)) break;
          if (performance.now() - p0 > 10_000) throw new Error('patch never became readable');
        }
        m.patchVisible.add(performance.now() - p0);
      }

      // Evaluation: with the fake LLM the evaluator keys on a marker in the Executive Summary.
      if (!realLlm) {
        const wc = await json<WorkingCopy>(await c.api('GET', `/api/sessions/${id}/working-copy`), 'working copy');
        await json(
          await c.api('PATCH', `/api/sessions/${id}/working-copy/sections/executive-summary`, {
            body: { body: 'Perf run summary #ready', expectedVersion: wc.version },
            tabId,
          }),
          'prepare evaluation',
        );
      }
      const e0 = performance.now();
      await json(await c.api('POST', `/api/sessions/${id}/evaluate`, { body: {} }), 'evaluate');
      m.evaluate.add(performance.now() - e0);
    } catch (err) {
      errors += 1;
      console.error(`[perf] iteration ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  printTable(`Latency (${iterations} iterations, ${errors} failed)`, [
    ['session creation (NFR-3)', m.create],
    ['session open (NFR-3)', m.open],
    ['first streamed token (NFR-1)', m.firstToken],
    ['patch visible after patch event', m.patchVisible],
    ['facilitator turn, total', m.turn],
    ['evaluation duration (NFR-2)', m.evaluate],
  ]);
  return { iterations, errors, metrics: Object.fromEntries(Object.entries(m).map(([k, s]) => [k, s.summary()])) };
}

async function concurrencyScenario(c: Client_) {
  const create = new Samples();
  const firstToken = new Samples();
  const turn = new Samples();
  const autosave = new Samples();
  const lockRenew = new Samples();
  let requests = 0;
  let errors = 0;
  let conflicts = 0;
  const errorSamples = new Map<string, number>();
  const fail = (what: string): void => {
    errors += 1;
    errorSamples.set(what, (errorSamples.get(what) ?? 0) + 1);
  };

  console.log(`[perf] creating ${sessionCount} sessions...`);
  const sessions: { id: string; tabId: string }[] = [];
  const BATCH = 10;
  for (let i = 0; i < sessionCount; i += BATCH) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(BATCH, sessionCount - i) }, async () => {
        requests += 1;
        try {
          return { id: await createPerfSession(c, create), tabId: randomUUID() };
        } catch (err) {
          fail(`create: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }),
    );
    for (const s of batch) if (s) sessions.push(s);
  }

  const startedAt = performance.now();
  const deadline = startedAt + durationMs;
  console.log(`[perf] ${sessions.length} sessions active for ${Math.round(durationMs / 1000)} s...`);

  async function runSession(s: { id: string; tabId: string }, index: number): Promise<void> {
    let version = -1;
    const refresh = async (): Promise<void> => {
      requests += 1;
      try {
        const res = await c.api('GET', `/api/sessions/${s.id}/working-copy`);
        if (!res.ok) return fail(`working-copy GET: HTTP ${res.status}`);
        version = ((await res.json()) as WorkingCopy).version;
      } catch (err) {
        fail(`working-copy GET: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    try {
      requests += 1;
      const lock = await c.api('POST', `/api/sessions/${s.id}/lock`, { tabId: s.tabId });
      if (!lock.ok) fail(`lock: HTTP ${lock.status}`);
      await lock.arrayBuffer();
      await refresh();
    } catch (err) {
      fail(`setup: ${err instanceof Error ? err.message : String(err)}`);
    }

    const autosaveLoop = async (): Promise<void> => {
      let n = 0;
      await sleep((index * autosaveMs) / Math.max(1, sessions.length));
      while (performance.now() < deadline) {
        n += 1;
        for (let attempt = 0; attempt < 2; attempt++) {
          requests += 1;
          const t0 = performance.now();
          let res: Response;
          try {
            res = await c.api('PATCH', `/api/sessions/${s.id}/working-copy/sections/problem-statement`, {
              body: { body: `Autosave ${n} from session ${index}`, expectedVersion: version },
              tabId: s.tabId,
            });
          } catch (err) {
            fail(`autosave: ${err instanceof Error ? err.message : String(err)}`);
            break;
          }
          if (res.ok) {
            version = ((await res.json()) as { version: number }).version;
            autosave.add(performance.now() - t0);
            break;
          }
          await res.arrayBuffer();
          // 409 is optimistic concurrency working (an AI patch landed first): refresh the version and retry once.
          if (res.status === 409) {
            conflicts += 1;
            await refresh();
          } else {
            fail(`autosave: HTTP ${res.status}`);
            break;
          }
        }
        await sleep(autosaveMs);
      }
    };

    const messageLoop = async (): Promise<void> => {
      await sleep((index * thinkMs) / Math.max(1, sessions.length));
      while (performance.now() < deadline) {
        requests += 1;
        const r = await sendTurn(c, s.id, s.tabId, FACILITATOR_TEXT);
        if (r.ok) {
          turn.add(r.totalMs);
          if (r.firstTokenMs !== null) firstToken.add(r.firstTokenMs);
        } else fail(`message: ${r.error}`);
        await sleep(thinkMs);
      }
    };

    const heartbeatLoop = async (): Promise<void> => {
      while (performance.now() < deadline) {
        await sleep(20_000);
        requests += 1;
        const t0 = performance.now();
        try {
          const res = await c.api('POST', `/api/sessions/${s.id}/lock`, { tabId: s.tabId });
          if (res.ok) lockRenew.add(performance.now() - t0);
          else fail(`lock renew: HTTP ${res.status}`);
          await res.arrayBuffer();
        } catch (err) {
          fail(`lock renew: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };

    const guarded = (f: () => Promise<void>) =>
      f().catch((err: unknown) => fail(`loop: ${err instanceof Error ? err.message : String(err)}`));
    await Promise.all([guarded(autosaveLoop), guarded(messageLoop), guarded(heartbeatLoop)]);
  }

  await Promise.all(sessions.map((s, i) => runSession(s, i)));

  const rate = requests === 0 ? 0 : errors / requests;
  printTable(`Concurrency (${sessions.length}/${sessionCount} sessions, ${Math.round(durationMs / 1000)} s)`, [
    ['session creation (setup)', create],
    ['first streamed token', firstToken],
    ['facilitator turn, total', turn],
    ['autosave (PATCH section)', autosave],
    ['lock renew', lockRenew],
  ]);
  console.log(
    `requests: ${requests}  errors: ${errors}  error rate: ${(rate * 100).toFixed(3)}%  autosave 409 conflicts (retried, not errors): ${conflicts}`,
  );
  for (const [what, n] of errorSamples) console.log(`  error x${n}: ${what}`);
  return {
    sessions: sessions.length,
    requestedSessions: sessionCount,
    durationS: Math.round(durationMs / 1000),
    requests,
    errors,
    errorRate: rate,
    autosaveConflicts: conflicts,
    errorSamples: Object.fromEntries(errorSamples),
    metrics: {
      create: create.summary(),
      firstToken: firstToken.summary(),
      turn: turn.summary(),
      autosave: autosave.summary(),
      lockRenew: lockRenew.summary(),
    },
  };
}

// ---- local stack -----------------------------------------------------------------------------------------------

const children: ChildProcess[] = [];

function stopStack(): void {
  for (const child of children) {
    if (child.pid === undefined || child.exitCode !== null) continue;
    if (platform() === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
}

function startProcess(name: string, command: string, env: Record<string, string>, logDir: string): ChildProcess {
  const log = createWriteStream(join(logDir, `${name}.log`));
  const child = spawn(command, { cwd: ROOT, env: { ...process.env, ...env }, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  children.push(child);
  return child;
}

function runStep(name: string, command: string, env: Record<string, string>): void {
  console.log(`[perf] ${name}...`);
  const r = spawnSync(command, { cwd: ROOT, env: { ...process.env, ...env }, shell: true, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${name} failed (exit ${r.status})`);
}

async function waitFor(url: string, what: string, timeoutMs = 240_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(url, { redirect: 'manual' })).status < 500) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`${what} did not become ready at ${url}`);
}

/** Fake LLM scenario file: the E2E fixture with a delay prepended to every run (the simulated model latency). */
function writeFakeScript(dir: string): string {
  const source = JSON.parse(readFileSync(join(ROOT, 'tests', 'e2e', 'fixtures', 'llm-script.json'), 'utf8')) as {
    rules: { steps: unknown[] }[];
  };
  if (fakeLatencyMs > 0) {
    for (const rule of source.rules) rule.steps.unshift({ type: 'delay', ms: fakeLatencyMs });
  }
  const path = join(dir, 'llm-script.json');
  writeFileSync(path, JSON.stringify(source));
  return path;
}

async function resetDatabase(): Promise<void> {
  const target = new URL(DATABASE_URL);
  const name = decodeURIComponent(target.pathname.slice(1));
  const admin = new URL(DATABASE_URL);
  admin.pathname = '/postgres';
  const root = new Client({ connectionString: admin.toString() });
  await root.connect();
  try {
    if ((await root.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 0) {
      await root.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    }
  } finally {
    await root.end();
  }
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    await db.query('DROP SCHEMA IF EXISTS pgboss CASCADE'); // job queue state from an earlier run
    await db.query('DROP SCHEMA public CASCADE');
    await db.query('CREATE SCHEMA public');
  } finally {
    await db.end();
  }
}

async function startStack(): Promise<void> {
  const logDir = join(tmpdir(), `techplanner-perf-${Date.now()}`);
  mkdirSync(logDir, { recursive: true });
  console.log(`[perf] stack logs: ${logDir}`);
  const env: Record<string, string> = {
    ...APP_ENV,
    ATLASSIAN_AUTH_BASE_URL: MOCK_URL,
    ATLASSIAN_API_BASE_URL: MOCK_URL,
    OAUTH_REDIRECT_URI: `${BASE_URL}/auth/callback`,
    APP_BASE_URL: BASE_URL,
    DATABASE_URL,
    METRICS_TOKEN,
    ATLASSIAN_MOCK_PORT: String(mockPort),
    E2E_DATABASE_URL: DATABASE_URL,
    NODE_ENV: args.dev ? 'development' : 'production',
    PORT: String(appPort),
  };
  if (realLlm) {
    const token = process.env.COPILOT_GITHUB_TOKEN;
    if (!token || !process.env.FACILITATOR_MODEL || !process.env.EVALUATOR_MODEL) {
      throw new Error('--real-llm needs COPILOT_GITHUB_TOKEN, FACILITATOR_MODEL and EVALUATOR_MODEL in the environment');
    }
    env.COPILOT_GITHUB_TOKEN = token;
    env.FACILITATOR_MODEL = process.env.FACILITATOR_MODEL;
    env.EVALUATOR_MODEL = process.env.EVALUATOR_MODEL;
    env.LLM_FAKE = '';
    env.LLM_FAKE_SCRIPT = '';
  } else {
    env.LLM_FAKE = '1';
    env.LLM_FAKE_SCRIPT = writeFakeScript(logDir);
  }

  await resetDatabase();
  runStep('migrate', 'npm run --silent migrate', env);
  if (!args.dev && !args['skip-build']) runStep('next build', 'npx next build', { ...env, NODE_ENV: 'production' });

  startProcess('atlassian-mock', 'npx tsx tests/e2e/mocks/atlassianMock.ts', env, logDir);
  await waitFor(`${MOCK_URL}/__mock/health`, 'Atlassian mock');
  startProcess('web', args.dev ? `npx next dev --port ${appPort}` : `npx next start --port ${appPort}`, env, logDir);
  await waitFor(`${BASE_URL}/login`, 'web app');
  const worker = startProcess('worker', 'npm run worker', env, logDir);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker did not start')), 60_000);
    worker.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('[worker] started')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

// ---- main ------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const environment = {
    os: `${platform()} ${release()}`,
    cpu: `${cpus()[0]?.model.trim() ?? 'unknown'} x${cpus().length}`,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    node: process.version,
    app: args.attach ? 'attached' : args.dev ? 'next dev' : 'next build + next start',
    llm: realLlm ? 'real Copilot SDK' : `fake (scripted), added latency ${fakeLatencyMs} ms`,
  };
  console.log(`[perf] environment: ${JSON.stringify(environment)}`);
  if (!args.attach) await startStack();

  const c = new Client_();
  await c.login();
  const result: Record<string, unknown> = { environment, autosaveMaxWaitMs: AUTOSAVE_MAX_WAIT_MS };
  if (scenario === 'latency' || scenario === 'all') result.latency = await latencyScenario(c);
  if (scenario === 'concurrency' || scenario === 'all') result.concurrency = await concurrencyScenario(c);
  console.log(
    `\nNFR-4: the editor autosaves after at most ${AUTOSAVE_MAX_WAIT_MS} ms of unsaved edits (AUTOSAVE_MAX_WAIT_MS), target <= 5000 ms.`,
  );
  if (args.json) writeFileSync(args.json, JSON.stringify(result, null, 2));
}

main()
  .then(() => {
    stopStack();
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error('[perf] failed:', err instanceof Error ? err.message : err);
    stopStack();
    process.exit(1);
  });
