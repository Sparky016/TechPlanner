# Performance report (NFR-1 to NFR-5)

Source: SPEC_DOC.md NFR-1 to NFR-5, D-7. Task 41. Produced by `scripts/perf/run.ts` (`npm run perf`).

## Verdict

| NFR | Target | Measured | Result |
|---|---|---|---|
| NFR-1 first streamed token | <= 3 s p95 | App overhead only: p95 23 ms (fake LLM, 0 ms added latency). Real model: not measured, knowledge gap | App overhead pass; target unverified |
| NFR-1 patch visible | <= 1 s | p95 12 ms from the patch event until the working copy endpoint serves the patched text (HTTP level) | Pass (HTTP level) |
| NFR-2 evaluation duration | <= 20 s p95 | App overhead only: p95 27 ms (fake LLM). Real model: not measured, knowledge gap | App overhead pass; target unverified |
| NFR-3 session open | <= 2 s p95 | p95 38 ms (page render plus session, working copy, messages, lock calls in parallel) | Pass |
| NFR-3 session creation | <= 30 s p95 | p95 68 ms against the Atlassian mock (zero upstream latency) | Pass for app work; real Jira/Confluence latency not included |
| NFR-4 edit loss | <= 5 s | Autosave fires at most `AUTOSAVE_MAX_WAIT_MS` = 5000 ms after the first unsaved change (read from `useAutosave.ts` by the script); 4941 saves under load had p95 38 ms | Pass (by cadence plus save latency) |
| NFR-5 50 concurrent sessions, no errors | >= 50 sessions, 0 errors | 0 errors at one message per session every 40 s; **deadlock at one message per 10 s** (79.5% errors, whole app unresponsive) | **Fail** (see below) |

Real-LLM numbers for NFR-1 (first token) and NFR-2 (evaluation) are **not measured: knowledge gap** (no `COPILOT_GITHUB_TOKEN`). `npm run perf -- --real-llm` is implemented but has never been run. Production hardware is also unknown (knowledge gap), so every figure below is for the machine in "Environment".

## Environment

| | |
|---|---|
| OS | Windows 11 Home 10.0.26200 |
| CPU | AMD Ryzen 7 7800X3D, 8 cores / 16 threads |
| Memory | 31 GB |
| Node | v22.12.0 |
| App | production build (`next build`), `next start`, worker via tsx, all on one host |
| Database | Postgres 16 in Docker (`docker-compose.dev.yml`), same host, database `techplanner_perf` |
| Upstream | Atlassian mock from task 39 (no network latency) |
| LLM | `FakeLlmClient` with the E2E scenario file; a delay step was prepended to each run to simulate model latency (0 ms for the latency scenario, 1000 ms for the concurrency scenario) |
| Date | 2026-10-06 |

The app, mock, database and load generator share one machine, so absolute numbers are indicative only. They separate app overhead from model latency; they do not predict production latency.

## Method

- `npm run perf` starts an isolated stack on ports 3200 (app) and 4110 (mock), resets and migrates `techplanner_perf`, logs in through the mocked OAuth flow, then drives the HTTP API (CSRF token, `x-tab-id` lock header) like the browser.
- Session open: `GET /sessions/:id` plus the session, working copy, messages and lock calls in parallel.
- First token: time from sending `POST /messages` to the first `event: token` SSE frame. With the fake LLM this is the added fake latency plus app overhead.
- Patch visible: time from the `event: patch` SSE frame until `GET /working-copy` returns the patched text. This is the server and HTTP part only; the DOM render is asserted by `tests/e2e/streaming.spec.ts` (patch in the center panel within 1 s of the patch event), which this task did not rerun.
- Evaluation: `POST /evaluate`, fake evaluator keyed on a marker in the Executive Summary.
- Percentiles are nearest-rank. "Error" is any non-2xx response, SSE `error` event, stream without `done`, or a request slower than 60 s. A 409 `version_conflict` on autosave is optimistic concurrency working (an AI patch landed first): it is retried once and counted separately.

## Latency scenario (`npm run perf`, 30 iterations, 0 failed)

| Metric | n | p50 | p95 | max |
|---|---|---|---|---|
| Session creation | 30 | 33 ms | 68 ms | 102 ms |
| Session open | 30 | 27 ms | 38 ms | 146 ms |
| First streamed token (fake LLM, 0 ms added) | 30 | 17 ms | 23 ms | 29 ms |
| Patch visible after patch event | 30 | 10 ms | 12 ms | 13 ms |
| Facilitator turn, total (scripted ~1.2 s of delay steps) | 30 | 1258 ms | 1286 ms | 1331 ms |
| Evaluation duration (fake LLM, 0 ms added) | 30 | 18 ms | 27 ms | 35 ms |

For the real model: first token = model time to first token + about 20 ms; evaluation = model time + about 20 ms. Check those against the 3 s and 20 s targets once a token is available.

## Concurrency scenario (`npm run perf -- --scenario concurrency`)

50 sessions on one user, each with its own tab id and session lock. Per session for 300 s: a facilitator message (fake LLM, 1000 ms added latency, then the scripted ~1.2 s turn) every `--think-ms`, an autosave every 3 s, a lock renewal every 20 s.

### Run A: `--think-ms 10000` (about 9 turns in flight on average, bursts above 10)

| Result | Value |
|---|---|
| Sessions created | 50 / 50 (p95 170 ms) |
| Requests / errors | 880 / 700 (**79.5%**) |
| Completed turns | 0 |
| Failure | every message, autosave and lock renewal timed out after 60 s |

The app wedged and did not recover. Postgres showed 10 idle connections each holding a `turn:<sessionId>` advisory lock (`pg_locks` advisory count 10). `src/app/api/sessions/[id]/messages/route.ts` takes a dedicated pool connection (`db.connect()`) for the life of each streamed turn, and the turn itself needs more connections from the same pool. `src/server/db/pool.ts` uses the `pg` default of 10 connections with no connection timeout, so once 10 turns overlap, every turn waits for a connection that only a finished turn can free. This is a deadlock. It is not slowness, and it is also hit by all other endpoints, which cannot get a connection. Facilitators sending a message every 10 s per session is faster than a human would, but the same state is reached by any 10 simultaneous turns, so it can occur with far fewer than 50 users.

### Run B: `--think-ms 40000` (about 3 turns in flight at any moment)

| Metric | n | p50 | p95 | max |
|---|---|---|---|---|
| Session creation (setup) | 50 | 109 ms | 180 ms | 186 ms |
| First streamed token (1000 ms fake latency) | 355 | 1024 ms | 1030 ms | 1177 ms |
| Facilitator turn, total | 355 | 2253 ms | 2267 ms | 2417 ms |
| Autosave (PATCH section) | 4941 | 18 ms | 38 ms | 181 ms |
| Lock renew | 750 | 17 ms | 134 ms | 161 ms |

6896 requests, **0 errors (0.000%)**. 350 autosave 409 conflicts were retried successfully. App overhead on first token under load is about 24 ms over the added 1000 ms (p50).

## NFR-5 verdict and follow-up

NFR-5 is **not met**: 50 active sessions are fine while at most a few turns overlap, but the app deadlocks when 10 turns overlap. Optimisation is out of scope for task 41, so no product code was changed. Follow-up task needed: stop holding a pool connection per streamed turn (or give turn locks their own pool), raise and make configurable the `pg` pool size, and set a connection acquisition timeout so exhaustion fails fast with an error instead of hanging. Re-run `npm run perf -- --scenario concurrency --think-ms 10000` after the fix; it must report 0 errors.

## Not measured

- Real-LLM first token and evaluation duration (no `COPILOT_GITHUB_TOKEN`).
- Real Jira/Confluence latency in session creation.
- Browser-side render timings (covered by the E2E suite, not rerun here).
- Production hardware. Container resource limits were not applied.
- Server-side `/metrics` histograms were not scraped; client-side timings were used.

## Reproduce

```
docker compose -f docker-compose.dev.yml up -d
npm run perf                                                 # latency, p50/p95
npm run perf -- --scenario concurrency --fake-latency-ms 1000 --think-ms 40000
npm run perf -- --real-llm   # needs COPILOT_GITHUB_TOKEN, FACILITATOR_MODEL, EVALUATOR_MODEL in the environment
```

Useful flags: `--iterations`, `--sessions`, `--duration-s`, `--think-ms`, `--autosave-ms`, `--fake-latency-ms`, `--attach --base-url <url>` (drive an already running stack), `--skip-build`, `--dev`, `--json <file>`. The script starts its own stack and database, so it does not collide with the E2E ports (3100, 4010) or database.

## MySQL 8.4 (2026-10-29)

Task 49 verification gate. Same harness (`npm run perf`, task 41), run after the Postgres to MySQL migration. The app, worker and database all ran on one host with the app's default perf database (`techplanner_perf`) on MySQL 8.4 at 127.0.0.1:3306. The verification sandbox could not install MySQL 8.4 natively (no package source reachable), so the server was the official `mysql:8.4` image on the host network standing in for a native install; the app, worker and harness ran natively.

**Real-LLM NFR-1 (first token) and NFR-2 (evaluation) were not measured.** No `COPILOT_GITHUB_TOKEN` is available, so `npm run perf -- --real-llm` was not run. Every MySQL figure below uses `LLM_FAKE=1` (scripted fake LLM), so it measures app overhead only.

### Environment

| | |
|---|---|
| OS | Linux 6.18.44-fc-v185 (VM) |
| CPU | Intel Xeon (x4 vCPU reported by the harness) |
| Memory | 16 GB |
| Node | v22.22.0 |
| App | production build (`next build`), `next start`, worker via tsx, all on one host |
| Database | MySQL 8.4.13 (`mysql:8.4` container, host network) at 127.0.0.1:3306, database `techplanner_perf`, app user `techplanner_app` |
| Upstream | Atlassian mock (zero upstream latency) |
| LLM | `FakeLlmClient`, E2E scenario file |
| Date | 2026-10-29 |

This is a different machine from the Postgres run (Windows 11, Ryzen 7 7800X3D, 31 GB), so the comparison shows the migration did not regress app overhead on comparable local hardware. It does not isolate the database change from the hardware change.

### Latency scenario (`npm run perf`, 20 iterations, 0 failed)

The Postgres run used 30 iterations. p95 values are compared below.

| Metric | Postgres p95 (2026-10-06) | MySQL p95 (2026-10-29) | MySQL p50 / max | ADR-0007 target | Result |
|---|---|---|---|---|---|
| Session creation (NFR-3) | 68 ms | 44 ms | 23 / 166 ms | <= 30 s | Pass |
| Session open (NFR-3) | 38 ms | 50 ms | 36 / 141 ms | <= 2 s | Pass (12 ms slower than Postgres, within target) |
| First streamed token, app overhead (NFR-1) | 23 ms | 22 ms | 15 / 24 ms | <= 3 s, real model not measured | App overhead pass; target unverified |
| Patch visible after patch event (NFR-1) | 12 ms | 11 ms | 10 / 18 ms | <= 1 s | Pass (HTTP level) |
| Facilitator turn, total (scripted ~1.2 s delay steps) | 1286 ms | 1268 ms | 1232 / 1268 ms | n/a | Matches script |
| Evaluation duration, app overhead (NFR-2) | 27 ms | 20 ms | 16 / 21 ms | <= 20 s, real model not measured | App overhead pass; target unverified |

### Concurrency scenario (NFR-5, `npm run perf -- --scenario concurrency`)

50 sessions on one user, 300 s, each with its own tab and session lock, an autosave every 3 s and a lock renewal every 20 s.

| Run | Postgres (2026-10-06) | MySQL 8.4 (2026-10-29) |
|---|---|---|
| A: `--think-ms 10000` | 79.5% errors, deadlock, 0 turns completed | **0 errors** (9819 requests, 0.000%), 1338 turns completed, 1331 autosave 409s retried |
| B: `--think-ms 40000` (`--fake-latency-ms 1000` requested) | 0 errors (6896 requests), first token p95 1030 ms | **0 errors** (6901 requests, 0.000%), 364 turns completed, 362 autosave 409s retried |

Run A (MySQL) detail, p50 / p95 / max:

| Metric | n | p50 | p95 | max |
|---|---|---|---|---|
| Session creation (setup) | 50 | 126 ms | 182 ms | 187 ms |
| First streamed token | 1338 | 14 ms | 46 ms | 164 ms |
| Facilitator turn, total | 1338 | 1228 ms | 1282 ms | 1377 ms |
| Autosave (PATCH section) | 4919 | 21 ms | 110 ms | 194 ms |
| Lock renew | 750 | 15 ms | 88 ms | 151 ms |

Run B (MySQL) detail, p50 / p95 / max:

| Metric | n | p50 | p95 | max |
|---|---|---|---|---|
| Session creation (setup) | 50 | 138 ms | 175 ms | 182 ms |
| First streamed token | 364 | 15 ms | 53 ms | 210 ms |
| Facilitator turn, total | 364 | 1230 ms | 1279 ms | 1422 ms |
| Autosave (PATCH section) | 4913 | 48 ms | 106 ms | 264 ms |
| Lock renew | 750 | 28 ms | 76 ms | 201 ms |

**Measurement caveat for Run B.** The harness reports "added latency 1000 ms" and writes the scenario file with the delay step (verified in the perf stack's `llm-script.json`). The measured turn times do not show it: the facilitator turn is about 1.23 s, where the Postgres Run B showed about 2.25 s. So Run B here is not equivalent to the Postgres Run B and gives less overlap than intended. Run A (no added latency, the default) is the stricter overlap test and is the one that deadlocked on Postgres. The added-latency discrepancy was not investigated, since the gate records results and does not fix product code or the harness.

### NFR-4 (edit loss)

`AUTOSAVE_MAX_WAIT_MS` is 5000 ms, so the cadence target is met. Autosave PATCH p95 under load was 106 ms (Run B) and 110 ms (Run A), against 38 ms on Postgres.

### Verdict (MySQL 8.4)

| NFR | Result on MySQL 8.4 |
|---|---|
| NFR-1 | App overhead pass (first token 22 ms p95, patch visible 11 ms p95). Real first-token target not measured (no `COPILOT_GITHUB_TOKEN`). |
| NFR-2 | App overhead pass (20 ms p95). Real evaluation target not measured. |
| NFR-3 | Pass (session open 50 ms p95, creation 44 ms p95). |
| NFR-4 | Pass by cadence (5000 ms max wait). |
| NFR-5 | **Pass in this run**: 50 sessions with 0 errors at both think times, including the 10 s case that deadlocked on Postgres. The cause of the difference from Postgres was not analysed in this gate. |

ADR-0007 targets are met for everything the fake LLM can exercise. The real-model NFR-1 and NFR-2 numbers remain unmeasured and need a run with `COPILOT_GITHUB_TOKEN`, `FACILITATOR_MODEL` and `EVALUATOR_MODEL` (`npm run perf -- --real-llm`).

### Reproduce

```
npm run perf                                                                       # latency
npm run perf -- --scenario concurrency --fake-latency-ms 1000 --think-ms 40000     # NFR-5 run B
npm run perf -- --scenario concurrency --think-ms 10000                            # NFR-5 run A
npm run perf -- --real-llm                                                         # needs COPILOT_GITHUB_TOKEN, FACILITATOR_MODEL, EVALUATOR_MODEL
```
