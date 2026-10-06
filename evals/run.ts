import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { emptySections } from '../src/lib/spec/document';
import { SECTION_NAMES, type SectionName } from '../src/lib/spec/sections';
import { findMatch, judgeMatch, rate, type Candidate, type CheckTally, type SeededGap } from './matchers';

// LLM behaviour eval harness (task 40, SPEC_DOC §8 / §10 AC3). `npm run eval:llm [-- --validate-only]`.
// Only builtins, yaml, zod and src/lib are imported statically: --validate-only needs no token, config or DB, and
// DATABASE_URL must point at the dedicated eval database before anything that reads the config is loaded.

const FIXTURES_DIR = join(process.cwd(), 'evals', 'fixtures');
const REPORT_PATH = join(process.cwd(), 'evals', 'report.json');
const DEFAULT_EVAL_DATABASE_URL = 'postgres://techplanner:techplanner@localhost:5432/techplanner_eval';

const MIN_FIXTURES = 20;
const HELD_OUT_COUNT = 5;
const MAX_GAPS_PER_FIXTURE = 3; // MAX_QUESTIONS_PER_TURN: three turns can always cover every gap.
const FACILITATOR_TURNS = 3;
const AC3_TURNS = 2;
const AC3_SECTION: SectionName = 'Acceptance Criteria';
const KICKOFF_MESSAGE =
  'Please review the ticket and the current draft, and ask me what you need to make this specification complete.';

// Pass-rate thresholds (knowledge gap: §8 lists criteria only; pending stakeholder confirmation).
export const THRESHOLDS = {
  facilitatorAsksGap: 0.9,
  evaluatorRaisesGap: 0.9,
  vagueNeverComplete: 1,
  releaseAc3: 1,
} as const;
type CheckId = keyof typeof THRESHOLDS;

// ---------------------------------------------------------------------------------------------------------------
// Fixture schema

const sectionName = z.enum(SECTION_NAMES);
const nonEmpty = z.string().trim().min(1);

const fixtureSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and dashes'),
    domain: nonEmpty,
    heldOut: z.boolean().default(false),
    releaseAc3: z.boolean().default(false),
    ticket: z.object({
      key: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/, 'Jira issue key'),
      summary: nonEmpty,
      description: nonEmpty,
      comments: z.array(z.object({ author: nonEmpty, body: nonEmpty })).default([]),
    }),
    draft: z.partialRecord(sectionName, z.string()).default({}),
    seededCriticalGaps: z
      .array(z.object({ id: nonEmpty, section: sectionName, keywords: z.array(nonEmpty).min(1) }))
      .min(1)
      .max(MAX_GAPS_PER_FIXTURE),
    vagueStatements: z.array(z.object({ section: sectionName, text: nonEmpty })).min(1),
    replies: z.array(nonEmpty).min(FACILITATOR_TURNS - 1),
  })
  .strict()
  .superRefine((f, ctx) => {
    const draft = f.draft as Partial<Record<SectionName, string>>;
    f.vagueStatements.forEach((v, i) => {
      if (!(draft[v.section] ?? '').includes(v.text)) {
        ctx.addIssue({ code: 'custom', path: ['vagueStatements', i], message: `text not found in draft "${v.section}"` });
      }
    });
    const gapIds = f.seededCriticalGaps.map((g) => g.id);
    if (new Set(gapIds).size !== gapIds.length) {
      ctx.addIssue({ code: 'custom', path: ['seededCriticalGaps'], message: 'gap ids must be unique' });
    }
    if (f.releaseAc3) {
      if (!f.seededCriticalGaps.some((g) => g.section === AC3_SECTION)) {
        ctx.addIssue({ code: 'custom', path: ['releaseAc3'], message: `needs a seeded gap on "${AC3_SECTION}"` });
      }
      if ((draft[AC3_SECTION] ?? '').trim() !== '') {
        ctx.addIssue({ code: 'custom', path: ['draft', AC3_SECTION], message: 'must be empty for a releaseAc3 fixture' });
      }
    }
  });

export type Fixture = z.infer<typeof fixtureSchema>;

export async function loadFixtures(dir: string = FIXTURES_DIR): Promise<{ fixtures: Fixture[]; errors: string[] }> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.yaml')).sort();
  const fixtures: Fixture[] = [];
  const errors: string[] = [];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = parseYaml(await readFile(join(dir, file), 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid YAML (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const result = fixtureSchema.safeParse(raw);
    if (result.success) fixtures.push(result.data);
    else for (const issue of result.error.issues) errors.push(`${file}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  const ids = fixtures.map((f) => f.id);
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) errors.push(`duplicate fixture id "${id}"`);
  if (files.length < MIN_FIXTURES) errors.push(`expected at least ${MIN_FIXTURES} fixtures, found ${files.length}`);
  if (!fixtures.some((f) => f.releaseAc3)) errors.push('expected at least one releaseAc3 fixture');
  const heldOut = fixtures.filter((f) => f.heldOut).length;
  if (heldOut !== HELD_OUT_COUNT) errors.push(`expected exactly ${HELD_OUT_COUNT} heldOut fixtures, found ${heldOut}`);
  return { fixtures, errors };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

interface Options {
  validateOnly: boolean;
  repeat: number;
  judge: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { validateOnly: false, repeat: 1, judge: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--validate-only') opts.validateOnly = true;
    else if (arg === '--judge') opts.judge = true;
    else if (arg === '--repeat' || arg.startsWith('--repeat=')) {
      const value = arg.includes('=') ? arg.split('=')[1] : argv[++i];
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error('--repeat needs a positive integer');
      opts.repeat = n;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

// ---------------------------------------------------------------------------------------------------------------
// Results

interface QuestionRecord extends Candidate {
  turn: number;
}

interface GapResult {
  id: string;
  section: SectionName;
  askedInTurn: number | null;
  askedBy: string | null;
  raisedBy: string | null;
}

interface FixtureResult {
  fixtureId: string;
  heldOut: boolean;
  run: number;
  questions: QuestionRecord[];
  turnErrors: string[];
  evaluation: {
    score: number;
    criticalIssues: Candidate[];
    statuses: Partial<Record<SectionName, { status: string; reason: string }>>;
  } | null;
  evaluationError: string | null;
  gaps: GapResult[];
  /** A section the evaluator never reported is 'missing' with reason "Not evaluated": not complete, so it passes. */
  vague: { section: SectionName; status: string | null; reason: string | null; pass: boolean }[];
  releaseAc3: { askedWithin2Turns: boolean; criticalRaised: boolean; pass: boolean } | null;
}

interface CheckSummary extends CheckTally {
  rate: number | null;
  threshold: number;
  pass: boolean;
}

function summarise(results: FixtureResult[]): Record<CheckId, CheckTally> {
  const t: Record<CheckId, CheckTally> = {
    facilitatorAsksGap: { passed: 0, total: 0 },
    evaluatorRaisesGap: { passed: 0, total: 0 },
    vagueNeverComplete: { passed: 0, total: 0 },
    releaseAc3: { passed: 0, total: 0 },
  };
  for (const r of results) {
    for (const g of r.gaps) {
      t.facilitatorAsksGap.total++;
      if (g.askedInTurn !== null) t.facilitatorAsksGap.passed++;
      t.evaluatorRaisesGap.total++;
      if (g.raisedBy !== null) t.evaluatorRaisesGap.passed++;
    }
    for (const v of r.vague) {
      t.vagueNeverComplete.total++;
      if (v.pass) t.vagueNeverComplete.passed++;
    }
    if (r.releaseAc3) {
      t.releaseAc3.total++;
      if (r.releaseAc3.pass) t.releaseAc3.passed++;
    }
  }
  return t;
}

function withThresholds(tallies: Record<CheckId, CheckTally>): Record<CheckId, CheckSummary> {
  const out = {} as Record<CheckId, CheckSummary>;
  for (const id of Object.keys(THRESHOLDS) as CheckId[]) {
    const r = rate(tallies[id]);
    out[id] = { ...tallies[id], rate: r, threshold: THRESHOLDS[id], pass: r !== null && r >= THRESHOLDS[id] };
  }
  return out;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------------------------------------------
// Real run (server modules are imported lazily, after the environment is prepared)

async function ensureDatabase(url: string): Promise<void> {
  const { Client } = await import('pg');
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rowCount === 0) await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  } finally {
    await client.end();
  }
}

function ticketText(f: Fixture): string {
  const t = f.ticket;
  const comments = t.comments.map((c) => `${c.author}: ${c.body}`);
  return [`${t.key}: ${t.summary}`, '', 'Description:', t.description, ...(comments.length ? ['', 'Comments:', ...comments] : [])].join(
    '\n',
  );
}

async function run(fixtures: Fixture[], opts: Options): Promise<number> {
  const fake = process.env.LLM_FAKE === '1';
  if (!fake) {
    const missing = ['COPILOT_GITHUB_TOKEN', 'FACILITATOR_MODEL', 'EVALUATOR_MODEL'].filter((n) => !process.env[n]);
    if (missing.length > 0) {
      console.error(`eval:llm needs ${missing.join(', ')} (a Copilot-entitled token and the real model names).`);
      return 2;
    }
  }
  // Never the application database: resetDatabase() drops the whole public schema.
  const evalDbUrl = process.env.EVAL_DATABASE_URL || DEFAULT_EVAL_DATABASE_URL;
  process.env.DATABASE_URL = evalDbUrl;
  await ensureDatabase(evalDbUrl);

  const { resetDatabase } = await import('../tests/integration/setup');
  const { getConfig } = await import('@/server/config');
  const { db, withTransaction } = await import('@/server/db/pool');
  const { runFacilitatorTurn } = await import('@/server/facilitator/runTurn');
  const { evaluateSession } = await import('@/server/readiness/evaluate');
  const { stopQueue } = await import('@/server/jobs/queue');
  const { getLlmClient } = await import('@/server/llm');
  const { insertSnapshots } = await import('@/server/sessions/sources');
  const { initWorkingCopy } = await import('@/server/spec/workingCopyRepo');

  const cfg = getConfig();
  const user = { accountId: 'eval-harness', displayName: 'Eval harness' };
  const judge = opts.judge ? { client: getLlmClient(), model: cfg.EVALUATOR_MODEL } : null;

  async function createSession(f: Fixture, run: number, purpose: string): Promise<string> {
    return withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO planning_session (primary_ticket_key, ticket_keys) VALUES ($1, ARRAY[$1]) RETURNING id',
        [f.ticket.key],
      );
      const sessionId = rows[0].id;
      const initial = { ...emptySections(), ...f.draft };
      await initWorkingCopy(sessionId, initial, client);
      await insertSnapshots(
        client,
        sessionId,
        [
          {
            kind: 'jira_issue',
            ref: f.ticket.key,
            title: f.ticket.summary,
            contentText: ticketText(f),
            ingestStatus: 'ingested',
            detail: { eval: { fixture: f.id, run, purpose } },
          },
        ],
        new Date(),
      );
      return sessionId;
    });
  }

  async function match(candidates: Candidate[], gap: SeededGap): Promise<Candidate | undefined> {
    const direct = findMatch(candidates, gap);
    if (direct || !judge) return direct;
    try {
      const index = await judgeMatch(candidates, gap, judge);
      return index === null ? undefined : candidates[index];
    } catch {
      return undefined;
    }
  }

  async function runFixture(f: Fixture, run: number): Promise<FixtureResult> {
    const result: FixtureResult = {
      fixtureId: f.id,
      heldOut: f.heldOut,
      run,
      questions: [],
      turnErrors: [],
      evaluation: null,
      evaluationError: null,
      gaps: [],
      vague: [],
      releaseAc3: null,
    };

    // Facilitator: kickoff plus scripted replies; questions are read from the turn events.
    const facSession = await createSession(f, run, 'facilitator');
    const messages = [KICKOFF_MESSAGE, ...f.replies.slice(0, FACILITATOR_TURNS - 1)];
    for (const [i, text] of messages.entries()) {
      const turn = i + 1;
      try {
        for await (const event of runFacilitatorTurn({ sessionId: facSession, user, text })) {
          if (event.type === 'question') result.questions.push({ turn, text: event.text, section: event.section });
          else if (event.type === 'error') result.turnErrors.push(`turn ${turn}: ${event.code}: ${event.message}`);
        }
      } catch (err) {
        result.turnErrors.push(`turn ${turn}: ${errorMessage(err)}`);
      }
      if (result.turnErrors.length > 0) break;
    }

    // Evaluator: a separate session holding the same seeded draft, so the facilitator's edits and the evaluator's
    // issues never leak into each other's input.
    const evalSession = await createSession(f, run, 'evaluator');
    try {
      const evaluation = await evaluateSession(evalSession, { userId: user.accountId, userDisplayName: user.displayName });
      const relevant = new Set<SectionName>([...f.seededCriticalGaps.map((g) => g.section), ...f.vagueStatements.map((v) => v.section)]);
      const statuses: Partial<Record<SectionName, { status: string; reason: string }>> = {};
      for (const s of relevant) statuses[s] = evaluation.statuses[s];
      result.evaluation = {
        score: evaluation.score,
        criticalIssues: evaluation.issues
          .filter((i) => i.severity === 'critical' && i.status === 'open')
          .map((i) => ({ text: i.description, section: i.section })),
        statuses,
      };
    } catch (err) {
      result.evaluationError = errorMessage(err);
    }

    for (const gap of f.seededCriticalGaps) {
      const asked = (await match(result.questions, gap)) as QuestionRecord | undefined;
      const raised = result.evaluation ? await match(result.evaluation.criticalIssues, gap) : undefined;
      result.gaps.push({
        id: gap.id,
        section: gap.section,
        askedInTurn: asked?.turn ?? null,
        askedBy: asked?.text ?? null,
        raisedBy: raised?.text ?? null,
      });
    }
    for (const v of f.vagueStatements) {
      const reported = result.evaluation?.statuses[v.section];
      const status = reported?.status ?? null;
      result.vague.push({ section: v.section, status, reason: reported?.reason ?? null, pass: status !== null && status !== 'complete' });
    }
    if (f.releaseAc3) {
      const acGap = f.seededCriticalGaps.find((g) => g.section === AC3_SECTION) as SeededGap;
      const early = result.questions.filter((q) => q.turn <= AC3_TURNS);
      const askedWithin2Turns = (await match(early, acGap)) !== undefined;
      const criticalRaised = result.evaluation?.criticalIssues.some((i) => i.section === AC3_SECTION) ?? false;
      result.releaseAc3 = { askedWithin2Turns, criticalRaised, pass: askedWithin2Turns && criticalRaised };
    }
    return result;
  }

  const results: FixtureResult[] = [];
  try {
    await resetDatabase();
    for (let r = 1; r <= opts.repeat; r++) {
      for (const f of fixtures) {
        const res = await runFixture(f, r);
        results.push(res);
        const asked = res.gaps.filter((g) => g.askedInTurn !== null).length;
        const raised = res.gaps.filter((g) => g.raisedBy !== null).length;
        const vague = res.vague.filter((v) => v.pass).length;
        const errors = [...res.turnErrors, ...(res.evaluationError ? [`evaluation: ${res.evaluationError}`] : [])];
        console.log(
          `[${r}/${opts.repeat}] ${f.id.padEnd(32)} asked ${asked}/${res.gaps.length}  raised ${raised}/${res.gaps.length}` +
            `  vague ${vague}/${res.vague.length}${res.releaseAc3 ? `  AC3 ${res.releaseAc3.pass ? 'pass' : 'FAIL'}` : ''}` +
            (errors.length ? `  errors: ${errors.join('; ')}` : ''),
        );
      }
    }
  } finally {
    await stopQueue().catch(() => undefined);
    const client = getLlmClient() as { stop?: () => Promise<void> };
    await client.stop?.().catch(() => undefined);
    await db.end().catch(() => undefined);
  }

  const checks = withThresholds(summarise(results));
  const heldOut = summarise(results.filter((r) => r.heldOut));
  const pass = Object.values(checks).every((c) => c.pass);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: fake ? 'fake' : 'real',
    models: { facilitator: cfg.FACILITATOR_MODEL, evaluator: cfg.EVALUATOR_MODEL },
    repeat: opts.repeat,
    judge: opts.judge,
    fixtures: fixtures.length,
    checks,
    heldOut: Object.fromEntries(Object.entries(heldOut).map(([id, t]) => [id, { ...t, rate: rate(t) }])),
    pass,
    results,
  };
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`\nLLM behaviour evals (${report.mode} model${fake ? ' — plumbing only, not a real result' : ''})`);
  const labels: Record<CheckId, string> = {
    facilitatorAsksGap: '(a) facilitator asks each seeded gap within 3 turns',
    evaluatorRaisesGap: '(b) evaluator raises a critical issue per seeded gap',
    vagueNeverComplete: '(c) vague section never marked complete',
    releaseAc3: '(d) release AC3: missing acceptance criteria',
  };
  for (const id of Object.keys(THRESHOLDS) as CheckId[]) {
    const c = checks[id];
    const pct = c.rate === null ? 'n/a' : `${(c.rate * 100).toFixed(1)}%`;
    console.log(
      `${c.pass ? 'PASS' : 'FAIL'}  ${labels[id].padEnd(54)} ${c.passed}/${c.total} = ${pct} (threshold ${THRESHOLDS[id] * 100}%)`,
    );
  }
  console.log(`Report: ${REPORT_PATH}`);
  return pass ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(errorMessage(err));
    return 2;
  }
  const { fixtures, errors } = await loadFixtures();
  if (errors.length > 0) {
    console.error(`Fixture validation failed (${errors.length}):`);
    for (const e of errors) console.error(`  - ${e}`);
    return 2;
  }
  const gaps = fixtures.reduce((n, f) => n + f.seededCriticalGaps.length, 0);
  const vague = fixtures.reduce((n, f) => n + f.vagueStatements.length, 0);
  console.log(
    `${fixtures.length} fixtures valid (${gaps} seeded gaps, ${vague} vague statements, ` +
      `${fixtures.filter((f) => f.heldOut).length} held out, ${fixtures.filter((f) => f.releaseAc3).length} release-AC3)`,
  );
  if (opts.validateOnly) return 0;
  return run(fixtures, opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(errorMessage(err));
      process.exit(2);
    },
  );
}
