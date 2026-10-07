# LLM behaviour evals

Checks that the facilitator (task 23) and the readiness evaluator (task 24) behave as specified
(SPEC_DOC §8, §10 Acceptance Criterion 3, SR-3.3) against the **real** GitHub Copilot model.
Not part of `npm test` or CI: every run needs a Copilot-entitled token and costs model requests.

## Running

```bash
# Schema check of every fixture. No token, no database.
npm run eval:llm -- --validate-only

# Real run. Needs Postgres (docker compose -f docker-compose.dev.yml up -d).
COPILOT_GITHUB_TOKEN=... FACILITATOR_MODEL=... EVALUATOR_MODEL=... npm run eval:llm

# Options
npm run eval:llm -- --repeat 3   # run every fixture 3 times to see variance (all runs count in the pass rates)
npm run eval:llm -- --judge      # if keyword/section matching finds nothing, ask the evaluator model as a judge
```

`.env` is loaded if present. The harness always uses a dedicated database, never `DATABASE_URL`:
`EVAL_DATABASE_URL`, default `postgres://techplanner:techplanner@localhost:5432/techplanner_eval`.
The database is created if it is missing, then **reset** (schema `public` dropped and migrated) at the start of every run.

Output: a per-fixture line plus a summary on the console, and `evals/report.json`. That file holds per-check pass
rates, held-out pass rates and the raw per-fixture results (questions asked, critical issues, section statuses).

Exit codes:

- `0`: every check met its threshold.
- `1`: at least one check was below its threshold.
- `2`: invalid fixtures, bad arguments, missing token or model names, or a crash.

With `LLM_FAKE=1`, the harness runs against `FakeLlmClient`. This only checks the plumbing (database, report, exit
code). The report then says `"mode": "fake"`, and its results mean nothing about model behaviour.

## What is measured

Each fixture is a synthetic ticket (`ticket`), a seeded Working Copy draft (`draft`), 1–3 `seededCriticalGaps`,
at least one `vagueStatements` entry, and scripted facilitator `replies`. The harness inserts sessions and snapshots
directly, so no Atlassian access is needed. For each fixture it uses two sessions, both seeded with the same ticket
snapshot and draft:

1. **Facilitator session**: three `runFacilitatorTurn` turns, a fixed kickoff message then `replies[0]` and `replies[1]`.
   The questions are read from the turn's `question` events.
2. **Evaluator session**: one `evaluateSession` on the untouched draft. It is a separate session so the
   facilitator's edits and the evaluator's issues do not leak into each other's input.

A question or issue **matches a gap** when its section equals the gap's section, or its text contains any of the
gap's keywords (case-insensitive). With `--judge`, the evaluator model is asked as well, but only when that
deterministic match finds nothing.

| Check | Unit | Passes when | Threshold |
|---|---|---|---|
| (a) facilitator asks about each gap | seeded gap | a matching question within 3 turns | ≥ 90 % |
| (b) evaluator raises each gap | seeded gap | a matching open **critical** issue | ≥ 90 % |
| (c) vague statement never complete | vague statement | its section's status is not `complete` | 100 % |
| (d) release AC3 (`releaseAc3: true` fixtures) | fixture | an Acceptance Criteria question within 2 turns **and** a critical issue on Acceptance Criteria | must pass (100 %) |

The thresholds are a fallback. SPEC_DOC §8 lists the criteria but not pass rates, so these need **stakeholder
confirmation**.

Caveats:

- `evaluateSession` adds deterministic critical issues for missing core sections (`mandatoryCriticalIssues`:
  Problem Statement, Scope, Functional Requirements, Technical Design, Acceptance Criteria). A gap in one of those
  sections can therefore pass (b) and (d) without the model raising it. Check (d) still tests the facilitator.
- A section the evaluator never reports becomes `missing` ("Not evaluated"). That counts as "not complete" for (c).
- A gap fails (a) if a facilitator turn errors, because the remaining turns are skipped. Errors are listed per
  fixture in the report.

## Fixtures

The fixtures are `evals/fixtures/*.yaml`, validated by the zod schema in `run.ts`. The validator enforces:

- at least 20 fixtures with unique ids
- at least one `releaseAc3` fixture, whose draft has an empty Acceptance Criteria section and a gap on it
- exactly 5 `heldOut` fixtures
- at most 3 gaps per fixture (the facilitator asks at most 3 questions per turn)
- every vague statement appears verbatim in its draft section

**Held-out subset**: 5 fixtures (`heldOut: true`) still run, but the report also shows their pass rates on their
own. Do not tune prompts against them. If the held-out rates drop while the others rise, the prompts are
overfitting the fixtures.

Keep keywords specific. A short keyword such as `sign` also matches "Technical De*sign* is missing" and produces
false passes.

## Baseline

After a real run, commit the report as the baseline:

```bash
cp evals/report.json evals/baseline-report.json
```

## Cost

One run of the 20 fixtures makes about 3 to 6 facilitator model runs per fixture (3 turns, plus a corrective
follow-up when a turn neither patches nor asks) and 1 to 2 evaluator runs. That is roughly 100–160 model requests.
`--judge` adds up to one evaluator request per unmatched gap, and `--repeat N` multiplies the total by N. Requests
count against the Copilot entitlement of the token's account.
