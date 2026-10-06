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
