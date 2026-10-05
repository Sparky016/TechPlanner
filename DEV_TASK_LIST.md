# Dev Task List

source: SPEC_DOC.md
generated: 2026-10-05 08:17
updated: 2026-10-05 22:44

Status values: PENDING | IN_PROGRESS | EVAL | REWORK | DONE | BLOCKED

Phases:
1. **Foundation**: scaffold, schema, audit, crypto, core pure modules, worker, observability, ADRs
2. **Integrations & core services**: OAuth, Copilot LlmClient, security wrapper, Atlassian reads, session/working-copy/revision/audit APIs
3. **AI facilitation & readiness**: facilitator engine, evaluator, streaming conversation API, readiness scheduling
4. **Publish**: step contract and converters, Confluence/Jira/webhook steps, orchestration with override and retry
5. **UI**: shell and pages, three-panel workspace, history and audit views
6. **Hardening & verification**: Docker/runbook, E2E, LLM evals, performance, accessibility

## Tasks

| ID | Phase | Task | Severity | Complexity | Model / Effort | Depends On | Status | Commit |
|----|-------|------|----------|------------|----------------|------------|--------|--------|
| 01 | 1 | [Project scaffold, toolchain and validated configuration](DEV_TASK_01.yml) | critical | medium | sonnet / medium | — | DONE | 5bb7516 |
| 02 | 1 | [Database migration runner and full schema](DEV_TASK_02.yml) | critical | critical | opus / high | 01 | DONE | 106d2b8 |
| 03 | 1 | [Immutable, hash-chained audit log service and verifier](DEV_TASK_03.yml) | critical | critical | opus / high | 02 | DONE | d7eaac9..b30d338 |
| 04 | 1 | [AES-256-GCM secret encryption utility](DEV_TASK_04.yml) | critical | critical | opus / high | 01 | DONE | 3d0c9be |
| 05 | 1 | [Generated Specification template module (27 sections, markdown rendering)](DEV_TASK_05.yml) | high | medium | sonnet / medium | 01 | DONE | af49afa |
| 06 | 1 | [Readiness score, mandatory critical rules, gate and issue fingerprinting](DEV_TASK_06.yml) | high | medium | sonnet / medium | 05 | DONE | 980c276 |
| 07 | 1 | [Working copy repository with section patches and edit precedence](DEV_TASK_07.yml) | high | high | opus / medium | 02, 05 | DONE | b431223 |
| 08 | 1 | [Background job queue and worker process](DEV_TASK_08.yml) | high | medium | sonnet / medium | 02 | DONE | 3631df1 |
| 09 | 1 | [Operational logging, correlation IDs, metrics and /healthz](DEV_TASK_09.yml) | medium | medium | sonnet / medium | 02 | DONE | 8f6d548 |
| 10 | 1 | [Record resolved decisions D-1..D-14 as ADRs and glossary as CONTEXT.md](DEV_TASK_10.yml) | low | trivial | haiku / low | — | DONE | 4dd107d |
| 11 | 2 | [Atlassian OAuth 2.0 (3LO) login, app sessions and token refresh](DEV_TASK_11.yml) | critical | critical | opus / high | 02, 03, 04, 09 | DONE | 33969e1 |
| 12 | 2 | [GitHub Copilot SDK/CLI LlmClient with locked-down tools (includes SDK API spike + ADR)](DEV_TASK_12.yml) | critical | critical | opus / high | 01, 09 | DONE | 9e4ac2e |
| 13 | 2 | [API handler wrapper, CSRF protection and security headers](DEV_TASK_13.yml) | critical | critical | opus / high | 03, 09, 11 | DONE | e9d8d3c |
| 14 | 2 | [Atlassian REST client with token injection, refresh-on-401 and rate-limit backoff](DEV_TASK_14.yml) | high | high | opus / medium | 09, 11 | DONE | 9375c1d |
| 15 | 2 | [Session access guard (Jira-delegated) and single-editor session lock](DEV_TASK_15.yml) | high | critical | opus / high | 13, 14 | DONE | 55501db |
| 16 | 2 | [Jira ticket retrieval and normalisation](DEV_TASK_16.yml) | high | medium | sonnet / medium | 14 | DONE | 63453d1 |
| 17 | 2 | [Linked Confluence page discovery and retrieval](DEV_TASK_17.yml) | high | medium | sonnet / medium | 14, 16 | DONE | f8a4486..65b1ea8 |
| 18 | 2 | [Planning session creation, listing, source snapshots and refresh API](DEV_TASK_18.yml) | high | high | opus / medium | 03, 07, 15, 16, 17, 21 | DONE | ba7c88e..017f3ee |
| 19 | 2 | [Working copy API: section edits, debounced audit and suggestion accept/reject](DEV_TASK_19.yml) | high | high | opus / medium | 07, 13, 15 | DONE | fd64747 |
| 20 | 2 | [Revisions API: save draft, history, compare and restore](DEV_TASK_20.yml) | high | medium | sonnet / medium | 07, 13, 15, 19 | DONE | ced0782 |
| 21 | 2 | [Attachment ingestion and context budget](DEV_TASK_21.yml) | medium | medium | sonnet / medium | 12, 14, 16 | DONE | 610ec79 |
| 22 | 2 | [Audit trail read and JSON Lines export API](DEV_TASK_22.yml) | medium | low | haiku / medium | 03, 13, 15 | DONE | 3e3ce31 |
| 23 | 3 | [AI facilitator engine: prompt, tools and turn execution](DEV_TASK_23.yml) | high | high | opus / medium | 07, 12, 18, 26 | DONE | 8e1c51b |
| 24 | 3 | [Readiness evaluator engine and issue reconciliation](DEV_TASK_24.yml) | high | high | opus / medium | 03, 06, 07, 12 | DONE | 705ef58 |
| 25 | 3 | [Conversation API: streaming messages (SSE), notes and AI questions](DEV_TASK_25.yml) | high | high | opus / medium | 13, 15, 23 | DONE | fe9858d |
| 26 | 3 | [Readiness scheduling and API: debounced evaluation, evaluate now, end clarification, accepted risk](DEV_TASK_26.yml) | high | medium | sonnet / medium | 08, 13, 15, 24 | DONE | d0c3dcf |
| 27 | 4 | [Publish orchestration: mandatory evaluation, gate/override, published revision, step runner and retry](DEV_TASK_27.yml) | critical | critical | opus / high | 08, 20, 24, 28, 29, 30, 31 | DONE | 6c006c0 |
| 28 | 4 | [Publish foundations: step contract, published markdown, Confluence storage and Jira ADF builders](DEV_TASK_28.yml) | high | high | opus / medium | 05 | DONE | eb5b169 |
| 29 | 4 | [Confluence publish step with external-change conflict detection](DEV_TASK_29.yml) | high | high | opus / medium | 09, 14, 28 | DONE | 0d12a68 |
| 30 | 4 | [Jira publish steps: attachment, description block, comment and label (idempotent)](DEV_TASK_30.yml) | high | high | opus / medium | 14, 28 | DONE | 463749d |
| 31 | 4 | [Downstream webhook step (HMAC-signed, retried)](DEV_TASK_31.yml) | high | medium | sonnet / medium | 03, 28 | DONE | 90f4494 |
| 32 | 5 | [App shell, login page, data notice, session list and new-session form](DEV_TASK_32.yml) | high | medium | sonnet / medium | 11, 13, 18 | DONE | 2f0d8c5 |
| 33 | 5 | [Session workspace layout, session lock UX and left panel (conversation, questions, notes, sources)](DEV_TASK_33.yml) | high | high | opus / medium | 15, 18, 25, 32 | DONE | c09c14a |
| 34 | 5 | [Center panel: section editor, autosave, live AI patch highlight, pending suggestions, Save Draft](DEV_TASK_34.yml) | high | high | opus / medium | 19, 20, 33 | REWORK | — |
| 35 | 5 | [Right panel: readiness, issues, action items, clarification control, publish with override and step status](DEV_TASK_35.yml) | high | high | opus / medium | 26, 27, 33 | DONE | 43de824 |
| 36 | 5 | [Version history UI: list, compare and restore](DEV_TASK_36.yml) | medium | medium | sonnet / medium | 20, 34 | PENDING | — |
| 37 | 5 | [Audit trail view for a session](DEV_TASK_37.yml) | medium | low | haiku / medium | 22, 32 | DONE | e2cabd1 |
| 38 | 6 | [Production Docker image (web + worker + pinned Copilot CLI), migrations on deploy, rollback runbook](DEV_TASK_38.yml) | high | high | opus / medium | 02, 08, 09, 12 | PENDING | — |
| 39 | 6 | [End-to-end Playwright suite with Atlassian, Copilot and webhook mocks](DEV_TASK_39.yml) | high | high | opus / medium | 27, 34, 35, 36, 37 | PENDING | — |
| 40 | 6 | [LLM behaviour eval harness (≥20 seeded-gap tickets) against the real Copilot SDK](DEV_TASK_40.yml) | high | high | opus / medium | 23, 24 | PENDING | — |
| 41 | 6 | [Performance verification against NFR-1 to NFR-5](DEV_TASK_41.yml) | medium | medium | sonnet / medium | 39 | PENDING | — |
| 42 | 6 | [Accessibility verification and fixes (keyboard, WCAG 2.1 AA contrast)](DEV_TASK_42.yml) | medium | medium | sonnet / medium | 39 | PENDING | — |

## Execution notes

- **Layout and scripts are defined in task 01** and every task relies on them: `src/app`, `src/components`, `src/lib` (isomorphic), `src/server/<domain>` (server-only), `src/worker`, `db/migrations`, `scripts`, `tests/integration`, `tests/e2e`, `evals`, `docs/adr`. npm scripts: `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`, `migrate`, `worker`, `audit:verify`, `eval:llm`.
- **Shared contracts. Tasks must import these, never re-create them:**
  - `getConfig()` in `src/server/config.ts` (task 01)
  - `db` / `withTransaction()` in `src/server/db/pool.ts` (task 02)
  - `recordAudit()` in `src/server/audit/audit.ts` (task 03)
  - `encryptSecret()` / `decryptSecret()` (task 04)
  - `SECTION_NAMES` in `src/lib/spec/sections.ts` (task 05)
  - readiness functions in `src/lib/readiness` (task 06)
  - `workingCopyRepo` (task 07)
  - `enqueue` / `JOB_NAMES` (task 08)
  - logger, metrics and health (task 09)
  - `getValidAccessToken()` and `HttpError` (task 11)
  - `LlmClient` / `getLlmClient()` / `FakeLlmClient` (task 12)
  - `withApiHandler()` (task 13)
  - `atlassianFetch()` (task 14)
  - `requireSessionAccess()` / `requireLock()` (task 15)
  - `PublishStep` contract (task 28)
- **Migration ordering**:
  - 0001 is task 02.
  - 0002 is task 03.
  - 0003 is task 19.
  - Any further migration takes the next free number at commit time. Migrations are forward-only.
- **Parallel integration tests** must each use their own database (e.g. `techplanner_t03`): `resetDatabase()` drops the whole public schema.
- **Integration tests** need `docker compose -f docker-compose.dev.yml up -d` (Postgres 16). Atlassian is always mocked with undici MockAgent or the task-39 mock server.
- **LLM in tests**: all non-eval tests use `LLM_FAKE=1` / `FakeLlmClient`. Only task 40 (and optionally 41) needs a real Copilot token.
- **Every Atlassian call uses the acting user's token** (SR-1.2). No shared Atlassian credentials anywhere.
- **Parallel lanes**:
  - Phase 1: start 01 and 10 together. Once 01 is done, 02, 04 and 05 can run in parallel.
  - Phase 2: 12 can run alongside the 11 → 13/14 chain.
  - Phase 4: 28 → (29, 30, 31) in parallel → 27.
- **Stakeholder ratification:** SPEC_DOC §12 asks for D-1, D-2, D-8 and D-9 to be ratified. Tasks 01, 12, 30 and 31 assume the spec's resolved positions. If the decisions change, rework those tasks and the tasks that depend on them.

## Open knowledge gaps

All gaps have a stated fallback in their task file. None blocks `/orchestrate`.

- [ ] **Stakeholder ratification of D-1, D-2, D-8 and D-9** (blocks: none; annotates 01, 12, 30, 31). D-1 is the stack, D-2 is Copilot, D-8 is the Jira description block and D-9 is the downstream webhook.
- [ ] **Copilot SDK API names.** These are the APIs for tool registration, built-in tool disable, streaming events, session resume and image input. Task 12 resolves them in a spike and records them in ADR 0015. (blocks: none; resolved inside 12)
- [ ] **Copilot-entitled `COPILOT_GITHUB_TOKEN`** for real-model runs. (blocks: 40 AC2/AC4, 41 real-LLM mode, 38 AC3 with the real model)
- [ ] **Atlassian OAuth app** (client id/secret, redirect URI, cloud id) and a **Confluence space/parent page** for manual verification. Automated tests use mocks. (blocks: none)
- [ ] **Confluence link vs. step independence.** SR-13.2 says all steps are independent, but the Jira description block and comment embed the Confluence link. Fallback: those two steps wait for the Confluence step. (task 27)
- [ ] **`APP_BASE_URL`** added as a required env var (task 01) though not in SPEC_DOC §7.5 — confirm. (blocks: none)
- [ ] **Items the spec does not define, with fallbacks:**
  - `app_session` table (02)
  - session lifetime (11)
  - PKCE support in Atlassian 3LO (11)
  - job queue library: pg-boss (08)
  - metrics exposure via `METRICS_TOKEN` (09)
  - `APP_BASE_URL` (01)
  - lock acquire endpoint and TTL (15)
  - token counting (21)
  - converter libraries (21, 28)
  - webhook signature format (31)
  - extra audit action names (03)
  - eval thresholds (40)
  - data-notice wording (32)

## Run log

<!-- orchestrator appends one line per dispatch/verdict: -->
2026-10-05 11:31 | 01 | worker dispatched (sonnet/medium)
2026-10-05 11:31 | 10 | worker dispatched (haiku/low)
2026-10-05 11:35 | 10 | worker complete @ 4dd107d → eval dispatched (haiku/low)
2026-10-05 11:37 | 10 | eval PASS → DONE @ 4dd107d
2026-10-05 12:30 | 01 | worker complete @ 5bb7516 (~56m, npm TLS failures from AVG HTTPS scanning; fixed by appending AVG root to ~/ca-bundle.pem) → eval dispatched (sonnet/low)
2026-10-05 12:31 | 01 | eval PASS → DONE @ 5bb7516
2026-10-05 12:31 | 02 | worker dispatched (opus/high)
2026-10-05 12:31 | 04 | worker dispatched (opus/high)
2026-10-05 12:31 | 05 | worker dispatched (sonnet/medium)
2026-10-05 12:33 | 05 | worker complete @ af49afa → eval dispatched (sonnet/low)
2026-10-05 12:33 | 04 | worker complete @ 3d0c9be → eval dispatched (opus/medium)
2026-10-05 12:33 | 05 | eval PASS → DONE @ af49afa
2026-10-05 12:33 | 06 | worker dispatched (sonnet/medium)
2026-10-05 12:34 | 04 | eval PASS → DONE @ 3d0c9be
2026-10-05 12:34 | 06 | worker complete @ 980c276 → eval dispatched (sonnet/low)
2026-10-05 12:35 | 06 | eval PASS → DONE @ 980c276
2026-10-05 12:35 | 02 | worker complete @ 106d2b8 → eval dispatched (opus/medium)
2026-10-05 12:36 | 02 | eval PASS → DONE @ 106d2b8
2026-10-05 12:36 | 03 | worker dispatched (opus/high)
2026-10-05 12:36 | 07 | worker dispatched (opus/medium)
2026-10-05 12:39 | 07 | worker complete @ b431223 → eval dispatched (sonnet/medium)
2026-10-05 12:40 | 07 | eval PASS → DONE @ b431223
2026-10-05 12:42 | 03 | worker complete @ d7eaac9 → eval dispatched (opus/medium)
2026-10-05 12:42 | 08 | worker dispatched (sonnet/medium)
2026-10-05 12:44 | 03 | eval FAIL (1 failure: non-canonical UUID sessionId breaks hash chain) → rework cycle 1 dispatched (opus/high)
2026-10-05 12:45 | 08 | worker complete @ 3631df1 → eval dispatched (sonnet/low)
2026-10-05 12:45 | 09 | worker dispatched (sonnet/medium)
2026-10-05 12:45 | 03 | rework 1 complete @ c17aec1 → re-eval dispatched (opus/medium)
2026-10-05 12:46 | 08 | eval PASS → DONE @ 3631df1
2026-10-05 12:46 | 09 | worker complete @ 8f6d548 → eval dispatched (sonnet/low)
2026-10-05 12:47 | 09 | eval PASS → DONE @ 8f6d548
2026-10-05 12:48 | 03 | re-eval FAIL (lone UTF-16 surrogates in text fields stored as U+FFFD break chain) → rework cycle 2 dispatched (opus/high; already top routing tier, no escalation possible)
2026-10-05 12:49 | 03 | rework 2 complete @ b30d338 → re-eval dispatched (opus/medium)
2026-10-05 12:51 | 03 | re-eval PASS (rework cycle 2) → DONE @ d7eaac9..b30d338
2026-10-05 12:51 | phase 1 | all 10 tasks DONE — phase boundary pause
2026-10-05 12:55 | phase 2 | resumed after phase-1 pause
2026-10-05 12:55 | 11 | worker dispatched (opus/high)
2026-10-05 12:55 | 12 | worker dispatched (opus/high)
2026-10-05 13:20 | 11 | worker complete @ 33969e1 → eval dispatched (opus/medium)
2026-10-05 13:28 | 11 | eval PASS → DONE @ 33969e1 (follow-up: OAUTH_REDIRECT_URI sample/test values say /api/auth/callback, route is /auth/callback)
2026-10-05 13:29 | 13 | worker dispatched (opus/high)
2026-10-05 13:29 | 14 | worker dispatched (opus/medium)
2026-10-05 13:45 | 14 | worker complete @ 9375c1d (+tokens.ts force option) → eval dispatched (sonnet/medium)
2026-10-05 13:47 | 12 | worker complete @ 9e4ac2e (+toolCall.ts, ajv, @types/json-schema, SDK pinned 1.0.16) → eval dispatched (opus/medium)
2026-10-05 13:52 | 14 | eval PASS → DONE @ 9375c1d (auth integration regression 11/11)
2026-10-05 13:52 | 16 | worker dispatched (sonnet/medium)
2026-10-05 13:58 | 12 | eval PASS → DONE @ 9e4ac2e (ADR 0015 names verified against SDK 1.0.16 d.ts; follow-up: register copilot health check at boot)
2026-10-05 14:05 | 13 | worker complete @ e9d8d3c → eval dispatched (opus/medium)
2026-10-05 14:10 | 16 | worker complete @ 63453d1 → eval dispatched (sonnet/low)
2026-10-05 14:15 | 13 | eval PASS → DONE @ e9d8d3c (follow-up for UI tasks: pages must render dynamically for CSP nonce)
2026-10-05 14:15 | 15 | worker dispatched (opus/high)
2026-10-05 14:18 | 16 | eval PASS → DONE @ 63453d1
2026-10-05 14:18 | 17 | worker dispatched (sonnet/medium)
2026-10-05 14:18 | 21 | worker dispatched (sonnet/medium)
2026-10-05 14:30 | 21 | worker complete @ 610ec79 → eval dispatched (sonnet/low)
2026-10-05 14:34 | 17 | worker complete @ f8a4486 (+turndown-plugin-gfm.d.ts) → eval dispatched (sonnet/low)
2026-10-05 14:37 | 15 | worker complete @ 55501db → eval dispatched (opus/medium)
2026-10-05 14:40 | 21 | eval PASS → DONE @ 610ec79 (CRLF-converted sample.pdf still extracts identically)
2026-10-05 14:42 | 17 | eval FAIL (1 failure: only /wiki/x/ tiny links flagged unsupported_link; other unresolvable /wiki/ URLs silently dropped) → rework cycle 1 dispatched (sonnet/medium)
2026-10-05 14:46 | 15 | eval PASS → DONE @ 55501db
2026-10-05 14:46 | 19 | worker dispatched (opus/medium)
2026-10-05 14:46 | 22 | worker dispatched (haiku/medium)
2026-10-05 14:49 | 17 | rework 1 complete @ 65b1ea8 → re-eval dispatched (sonnet/low)
2026-10-05 14:52 | 17 | re-eval PASS (rework cycle 1) → DONE @ f8a4486..65b1ea8
2026-10-05 14:52 | 18 | worker dispatched (opus/medium)
2026-10-05 14:58 | 22 | worker complete @ 3e3ce31 (report not in YAML contract; worker ran tests on shared default DB) → eval dispatched (haiku/low)
2026-10-05 15:02 | 19 | worker complete @ fd64747 (migration 0003; hand-rolled unified diff — no diff pkg) → eval dispatched (sonnet/medium)
2026-10-05 15:10 | 19 | eval PASS → DONE @ fd64747 (hand-rolled diff coarse but valid)
2026-10-05 15:10 | 20 | worker dispatched (sonnet/medium)
2026-10-05 15:12 | deps | orchestrator chore commit adds diff@9 (needed by task 20 compare; task 19 hand-rolled diff can switch later)
2026-10-05 15:12 | 22 | eval PASS → DONE @ 3e3ce31
2026-10-05 15:20 | 18 | worker complete @ ba7c88e (+workingCopyRepo.ts client param; hand-rolled diff excerpt + concurrency mapper) → eval dispatched (sonnet/medium)
2026-10-05 15:28 | 18 | eval FAIL (1 failure: truncated diff excerpt is 4019 chars, over the 4000 cap, because the marker is appended after slicing) → rework cycle 1 dispatched (opus/medium)
2026-10-05 15:31 | 20 | worker complete @ ced0782 → eval dispatched (sonnet/low)
2026-10-05 15:36 | 18 | rework 1 complete @ 017f3ee → re-eval dispatched (sonnet/medium)
2026-10-05 15:38 | 20 | eval PASS → DONE @ ced0782 (accepted risk: restore not atomic across replaceAllSections and createRevision)
2026-10-05 15:42 | 18 | re-eval PASS (rework cycle 1) → DONE @ ba7c88e..017f3ee
2026-10-05 15:42 | phase 2 | all 12 tasks DONE → phase verification gate dispatched (haiku/low)
2026-10-05 17:42 | phase 2 | resumed after /clear; gate result lost → phase verification gate re-dispatched (haiku/low)
2026-10-05 17:47 | phase 2 | gate PASS (lint, typecheck, build; unit 166, integration 102) → phase boundary pause
2026-10-05 17:5x | phase 3 | started on user instruction
2026-10-05 17:5x | 24 | worker dispatched (opus/medium)
2026-10-05 18:1x | 24 | worker complete @ 705ef58 → eval dispatched (sonnet/medium)
2026-10-05 18:2x | 24 | eval PASS → DONE @ 705ef58 (8 assumptions all accepted)
2026-10-05 18:2x | 26 | worker dispatched (sonnet/medium)
2026-10-05 18:2x | 26 | worker complete @ d0c3dcf → eval dispatched (sonnet/low)
2026-10-05 18:2x | 26 | eval PASS → DONE @ d0c3dcf (note: background eval falls back to userId 'system' when facilitator_id is NULL)
2026-10-05 18:2x | 23 | worker dispatched (opus/medium)
2026-10-05 18:3x | 23 | worker complete @ 8e1c51b (+snapshot file, SessionNotFoundError) → eval dispatched (sonnet/medium)
2026-10-05 18:3x | 23 | eval PASS → DONE @ 8e1c51b (12 assumptions accepted; open edge: scheduleEvaluation failure after commit means no 'done' event)
2026-10-05 18:3x | 25 | worker dispatched (opus/medium)
2026-10-05 18:4x | 25 | worker complete @ fe9858d (notes INSERT duplicated from runTurn.ts; latent pre-aborted-signal edge in sse.ts) → eval dispatched (sonnet/medium)
2026-10-05 18:4x | 25 | eval PASS → DONE @ fe9858d (9 assumptions accepted; follow-up: export insertMessage from runTurn.ts and dedupe notes route)
2026-10-05 18:4x | phase 3 | all 4 tasks DONE → phase verification gate dispatched (haiku/low)
2026-10-05 18:46 | phase 3 | gate PASS (lint, typecheck, build; unit 194, integration 125) → phase boundary pause
2026-10-05 18:5x | phases 4+5 | started on user instruction (run 4 and 5 continuously; 32 runs alongside phase 4, no file overlap)
2026-10-05 18:5x | 28 | worker dispatched (opus/medium)
2026-10-05 18:5x | 32 | worker dispatched (sonnet/medium)
2026-10-05 18:5x | 28 | worker complete @ eb5b169 (+marked, @xmldom/xmldom dev) → eval dispatched (sonnet/medium)
2026-10-05 18:5x | 32 | worker complete @ 2f0d8c5 (+tailwind, jsdom, testing-library; 5 extra files) → eval dispatched (sonnet/low)
2026-10-05 18:5x | deps | 28 and 32 both edited package.json concurrently; HEAD verified to contain both dependency sets, tree clean. Lesson: do not co-schedule tasks that may add deps
2026-10-05 18:5x | 28 | eval PASS → DONE @ eb5b169 (contract matches task doc verbatim)
2026-10-05 18:5x | 29 | worker dispatched (opus/medium)
2026-10-05 18:5x | 30 | worker dispatched (opus/medium; 31 held — concurrency cap 3 with 32 in EVAL)
2026-10-05 19:0x | 32 | eval PASS → DONE @ 2f0d8c5 (extras accepted as required Tailwind setup; build needs config env vars)
2026-10-05 19:0x | 31 | worker dispatched (sonnet/medium)
2026-10-05 19:0x | 31 | worker complete @ 90f4494 (sha256=<hex> signature fallback; README note skipped, not in Files) → eval dispatched (sonnet/low)
2026-10-05 19:0x | 31 | eval PASS → DONE @ 90f4494 (README downstream note deferred — knowledge gap only)
2026-10-05 19:0x | 33 | worker dispatched (opus/medium; 37 held — shares SessionHeader.tsx with 33)
2026-10-05 19:0x | 29 | worker complete @ 0d12a68 (ctx.title assumed = ticket summary; task 27 must pass summary) → eval dispatched (sonnet/medium)
2026-10-05 19:0x | 30 | worker complete @ 463749d (description step fails fast on null confluencePageUrl) → eval dispatched (sonnet/medium)
2026-10-05 19:0x | 29 | eval PASS → DONE @ 0d12a68 (14/14; spurious-mismatch edge judged safe-side; task 27 must pass primary ticket summary as ctx.title)
2026-10-05 19:0x | 30 | eval PASS → DONE @ 463749d (8/8; acting-user token confirmed)
2026-10-05 19:0x | 27 | worker dispatched (opus/high)
2026-10-05 19:1x | 33 | worker complete @ c09c14a (+apiFetchResponse in client.ts; <a>→Link in 2 task-32 files for lint) → eval dispatched (sonnet/medium)
2026-10-05 19:1x | 33 | eval PASS → DONE @ c09c14a (full unit suite 259; no lock-release route — relies on 60 s expiry)
2026-10-05 19:1x | 34 | worker dispatched (opus/medium)
2026-10-05 19:1x | 37 | worker dispatched (haiku/medium)
2026-10-05 19:1x | 27 | worker complete @ 6c006c0 (self-amended own commit ed0328d; verified no other commit affected) → eval dispatched (opus/medium)
2026-10-05 19:2x | 27 | eval PASS → DONE @ 6c006c0 (follow-ups: enqueue-failure path writes no publish.failed audit nor session.status; retry by another user runs on original publisher tokens and attributes audits to them)
2026-10-05 19:2x | phase 4 | all 5 tasks DONE → continuing into phase 5 without pause (user instruction); 35 held — shares sessions/[id]/page.tsx with in-flight 34
2026-10-05 19:22 | 37 | worker complete @ e2cabd1 (client component imports AUDIT_ACTIONS from @/server/audit/actions) → eval dispatched (haiku/low)
2026-10-05 19:26 | 37 | eval PASS → DONE @ e2cabd1 (eval report omitted lint/typecheck/build results — deferred to final gate)
2026-10-05 19:3x | list | DEV_TASK_LIST.md found reverted to its committed 4335fe9 (phase-2) state — a worker reset the working tree. Rows and run log for 17:42–19:2x reconstructed from session record (minute-level times approximate, marked x). Orchestrator now commits the list after each update.
2026-10-05 19:28 | 34 | worker complete @ 7a58997 (self-amended own commit 6d2e461 after on-disk revert of page.tsx; textarea instead of CodeMirror/react-markdown due to orchestrator no-deps instruction) → eval dispatched (sonnet/medium)
2026-10-05 19:28 | 35 | worker dispatched (opus/medium)
2026-10-05 19:30 | 34 | eval FAIL (1 failure: textarea/pre instead of CodeMirror + react-markdown required by Scope In — caused by orchestrator no-deps instruction) → rework cycle 1 dispatched (opus/medium; deps allowed)
2026-10-05 19:35 | 35 | worker complete @ 43de824 (section statuses unordered — JSONB key order) → eval dispatched (sonnet/medium)
2026-10-05 22:42 | 34,35 | rework-34 worker and eval-35 killed by usage limit (HTTP 429); rework 34 left uncommitted partial changes (deps installed, SectionEditor + tests edited) → fresh worker dispatched to finish cycle 1 from tree state; eval 35 re-dispatched
2026-10-05 22:44 | 35 | eval PASS → DONE @ 43de824 (isolated copy: 301 tests, build ok; confluenceAction matches retry API)
