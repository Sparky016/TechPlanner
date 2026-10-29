# Spec — Guided Ticket Intake, Question Answering and Discuss with AI

| Field | Value |
|---|---|
| Status | Draft for review |
| Date | 2026-10-29 |
| Source | User request (2026-10-29) |
| Amends | `SPEC_DOC.md` FR-2, FR-3, §6, §7.2, §7.3; ADR-0016 (code repository is set before intake) |

---

## 1. Summary

Today, creating a Planning Session ingests every source immediately (tickets, linked Confluence pages, attachments), and nothing happens with the AI until the Facilitator types the first message. AI questions can only be dismissed; they are answered implicitly through free-form conversation.

This change makes the session flow explicit and question-driven:

1. **Ingest ticket** — after the session's sources are set (ticket keys, optional code repository), the Facilitator presses a button in the left panel to ingest the sources. Nothing is ingested at creation.
2. **Analyze** — ingestion is chained (by default) into an AI analysis turn that reads the sources, drafts the Working Copy and asks its initial questions.
3. **Answer / Resolve questions** — each question has an **Answer** action that sends the answer to the AI, which works it into the specification. Answered questions can be **Resolved**. An open question can be resolved without answering when it is irrelevant.
4. **Discuss with AI** — an overview chat with the specification, all questions (and their answers) and the sources as context. It can update the specification.

---

## 2. Current behaviour (as built)

| Area | Today | Code |
|---|---|---|
| Session creation | `createSession` validates keys, fetches issues, runs `collectSources` and inserts snapshots in the creation transaction. | `src/server/sessions/createSession.ts` |
| Sources | Shown in `SessionHeader` with **Refresh sources** (`refreshSources`, diff posted as a `system` message). | `SessionHeader.tsx`, `refreshSources.ts` |
| First AI turn | None until the Facilitator sends a message. | `POST /api/sessions/:id/messages` |
| Questions | `ai_question.status` ∈ `open` / `answered` / `dismissed`. AI marks `answered` via `mark_question_answered`; Facilitator can only **Dismiss** (optional reason, `question.dismissed` audit). | `QuestionsList.tsx`, `questions/[qid]/dismiss/route.ts`, `facilitator/tools.ts` |
| AI context | Sources, notes, Working Copy, unresolved issues, **open** questions only. Dismissed questions are invisible to the AI, so it can re-ask them. | `facilitator/context.ts`, `facilitator/prompt.ts` |
| Conversation | Always visible in the left panel; one turn at a time per session (advisory lock, `409 turn_in_progress`). | `Conversation.tsx` |

---

## 3. Goals / Non-goals

### Goals
- G-1 The Facilitator controls when sources are pulled, so the code repository (and later, other source settings) can be set first.
- G-2 The AI's first output is a structured analysis plus initial questions, without the Facilitator having to prompt it.
- G-3 Questions are the primary work queue: answer each one directly, see it worked into the spec, and close it.
- G-4 Free-form discussion remains available, with full awareness of the spec and every question's state.
- G-5 Every new action is audited and works under the existing session lock and turn lock.

### Non-goals
- Changing which sources are discovered or the ingestion limits (D-10 unchanged).
- Adding or removing tickets after creation.
- Background/queued ingestion (ingestion stays a synchronous request, like Refresh sources today).
- Multi-user answering (D-3 unchanged: one editor per session).
- Answering several questions in one AI turn (GD-9): one answer per turn.

---

## 4. User flow

```
New session ──► Workspace (state: not_ingested)
                 │  Set/confirm code repository (optional)
                 │  [Ingest ticket]  ☑ Analyze after ingest
                 ▼
               Ingesting… ──► sources listed (state: ingested)
                 │  (chained, or [Analyze ticket] when unchecked / after a failure)
                 ▼
               Analyzing… (streamed AI turn) ──► spec drafted, initial questions listed (state: analyzed)
                 ▼
               Questions loop:  [Answer] ─► AI turn updates spec ─► question "Answered" ─► [Resolve]
                                [Resolve] (not relevant, optional reason)
               Any time:        [Discuss with AI] ─► overview chat, may update spec / ask new questions
```

---

## 5. Functional requirements

IDs `GI-<n>` (Guided Intake). Each states the SPEC_DOC requirement it amends, if any.

### 5.1 Session intake state

- **GI-1** A Planning Session has an intake state derived from two new timestamps on `planning_session`:

  | State | Condition |
  |---|---|
  | `not_ingested` | `ingested_at IS NULL` |
  | `ingested` | `ingested_at IS NOT NULL AND analyzed_at IS NULL` |
  | `analyzed` | `analyzed_at IS NOT NULL` |

  `GET /api/sessions/:id` returns `ingestedAt`, `analyzedAt` and `intakeState`.

- **GI-2** *(amends SR-2.1, SR-2.6, SR-2.8)* Session creation still validates ticket key format and that every ticket is readable in Jira (`fetchIssues`), and still runs the duplicate check. It **no longer** calls `collectSources` or inserts snapshots, unless the Facilitator chose **Create and ingest** (GI-25). `draft.created` audit details drop `sourceCount`.

### 5.2 Ingest ticket

- **GI-3** In the left panel, `SessionHeader` shows, while `intakeState = not_ingested`:
  - the ticket keys and the `CodeRepositoryPicker` (unchanged, editable);
  - a primary **Ingest ticket** button (label **Ingest tickets** when the session has more than one key);
  - a checkbox **Analyze after ingest**, checked by default;
  - in place of the sources list, the text "Sources not ingested yet."

  The button is disabled when `readOnly`, while a request is in flight, or while a turn is in progress (GI-22).

- **GI-4** `POST /api/sessions/:id/ingest` (lock required, no body) fetches the tickets and runs `collectSources` exactly as creation does today, inserts one snapshot batch, sets `ingested_at`, appends one `system` conversation message ("Sources ingested at <ts>: N Jira issues, N Confluence pages, N attachments (N listed only, N unavailable, N truncated).") and audits `sources.ingested` (details: counts by kind and status). Returns `{ ingestedAt, sources }`.
  - Already ingested → `409 already_ingested` (use Refresh sources).
  - A ticket that became unreadable since creation is stored as an `unavailable` `jira_issue` snapshot (same as `refreshSources`), not a failure.
  - A failure of the whole request (Atlassian outage, token expiry) leaves `ingested_at` NULL, audits `sources.ingested` with `result: failure`, and the button stays available.
- **GI-5** Ingestion and refresh share one core in `src/server/sessions/refreshSources.ts` (rename to `ingestSources.ts`): first ingest = refresh with an empty previous batch, but with the summary message of GI-4 instead of an all-"added" diff.
- **GI-6** After ingestion, **Refresh sources** and the sources list appear as today. **Ingest ticket** is no longer shown.
- **GI-7** Changing the code repository is allowed in every state. Changing it does not re-ingest (code is read live by the code tools, ADR-0016).

### 5.3 Analyze

- **GI-8** When **Analyze after ingest** is checked, the client starts the analysis turn as soon as ingestion succeeds. When unchecked, or when the analysis turn failed, an **Analyze ticket** button is shown while `intakeState = ingested`.
- **GI-9** `POST /api/sessions/:id/analyze` (lock required, no body) streams a facilitator turn as SSE with the same event types as `POST /messages`. It holds the same per-session turn lock (`409 turn_in_progress`). Preconditions: `not_ingested` → `409 not_ingested`; `analyzed` → `409 already_analyzed` (use Discuss with AI).
- **GI-10** The analysis turn:
  - persists a `system` message "Initial analysis requested by <display name>." instead of a facilitator message;
  - runs with an extra system-prompt block (`ANALYSIS_TEXT`, §8) that asks the AI to summarise its understanding, draft every section the sources support, record gaps, contradictions and risks, and ask its initial questions;
  - raises the per-turn question limit to `MAX_INITIAL_QUESTIONS` (default 8, config `ANALYSIS_MAX_QUESTIONS`) — the D-7 limit of 3 stays for every other turn;
  - may use the code investigation tools when Azure DevOps is enabled;
  - on success sets `analyzed_at` in the same transaction that persists the AI message; on error `analyzed_at` stays NULL.
  - Audited once as `ai.suggestion` with `details.turnKind = 'analysis'`. A readiness evaluation is scheduled when a patch was applied (unchanged).
- **GI-11** While the analysis streams, the left panel shows "Analyzing <KEY>…" with the streamed text in the Discuss with AI panel (GI-20), and new questions appear in the Questions list as `question` events arrive.

### 5.4 Questions: answer and resolve

- **GI-12** *(amends SR-3.5)* Question states:

  | Status | Meaning | Facilitator actions |
  |---|---|---|
  | `open` | Asked, not answered. | **Answer**, **Resolve** (not relevant) |
  | `answered` | An answer exists (from the Facilitator, or the AI recorded one from the discussion). | **Resolve**, **Edit answer** |
  | `resolved` | Closed. `resolution` = `answered` or `not_relevant`. | **Reopen** |

  Existing `dismissed` rows migrate to `resolved` / `not_relevant` (§7).

- **GI-13** **Answer** expands an inline form under the question: a textarea (max 10 000 chars, same as messages) with **Send answer** and **Cancel**. `Ctrl/Cmd+Enter` submits.
- **GI-14** `POST /api/sessions/:id/questions/:qid/answer` (lock required, body `{ text }`) streams a facilitator turn as SSE (same events and turn lock as `/messages`). In one transaction before the model runs it:
  - stores the answer on the question (`answer_text`, `answered_at`, `answered_via = 'facilitator'`) and sets `status = 'answered'`;
  - persists a `facilitator` conversation message whose `question_id` is set and whose content is the answer text;
  - audits `question.answered` (details: questionId, section, answer length).

  Then it runs a facilitator turn with an extra instruction (`ANSWER_TEXT`, §8) naming the question and its id: work the answer into the affected sections, keep content consistent, and ask a follow-up question only if the answer is vague or opens a new gap (SR-3.3). The question limit is the D-7 default. Audited as `ai.suggestion` with `details.turnKind = 'answer'`, `details.questionId`.
  - Allowed from `open` and `answered` (an edited answer replaces `answer_text`; the earlier answer remains in the conversation history). `resolved` → `409 question_resolved`.
  - The answer is persisted before the model runs, so an LLM failure loses nothing (NFR-8); the question stays `answered` and the Facilitator can **Edit answer** to resubmit.
- **GI-15** While an answer turn streams, the question shows "AI is updating the specification…", and on `done` the question shows the answer text and a short list of the sections patched (from the turn's `patch`/`suggestion` events). The AI's reply text is shown in the Discuss with AI history (GI-20).
- **GI-16** **Resolve** — `POST /api/sessions/:id/questions/:qid/resolve` (lock required, body `{ reason?: string }`, max 500 chars):
  - from `answered` → `resolved`, `resolution = 'answered'` (one click, no form);
  - from `open` → `resolved`, `resolution = 'not_relevant'`; the UI asks for an optional reason (current dismiss form, button label **Resolve as not relevant**);
  - from `resolved` → `409 question_not_open`.

  Sets `resolved_at`, audits `question.resolved` (details: questionId, section, resolution, reason). Does not call the AI: the AI learns of the resolution from the next turn's context (GI-21, GD-7).
  The existing `/dismiss` route stays for one release as an alias for "resolve from open" (expand/contract, §8 Deployment of SPEC_DOC), then is removed.
- **GI-17** **Reopen** — `POST /api/sessions/:id/questions/:qid/reopen` (lock required): `resolved` → `answered` when `answer_text` is set, else `open`; clears `resolution`, `resolved_at`. Audits `question.reopened`.
- **GI-18** Questions list layout: groups **Open** (oldest first), **Answered — awaiting resolve**, and **Resolved** (collapsed by default, with count). Each item keeps its section label and links to its issue (existing `issueId`). Header shows counts, e.g. "Questions · 4 open · 2 answered".
- **GI-19** *(amends `mark_question_answered`)* The AI tool gains an optional `answerSummary` (max 2 000 chars). When the AI marks an `open` question answered from the discussion, the server stores the summary as `answer_text` with `answered_via = 'ai'`. The UI labels such answers "Answered in discussion (AI summary)". The tool can no longer change `resolved` questions.

### 5.5 Discuss with AI

- **GI-20** The existing `Conversation` component becomes **Discuss with AI**: a collapsible section in the left panel, collapsed by default once questions exist, opened by a **Discuss with AI** button under the Questions list. It behaves as today (streamed turns, notes and system messages inline) and is disabled until `intakeState ≠ not_ingested`.
  - Messages that carry a `question_id` render as "Answer to: <question text, truncated>" followed by the answer.
  - Turns started elsewhere (analysis, answers) show their streamed reply here too (published through the workspace event bus; `Conversation` reloads on `done` as well as `conversation_changed`).
- **GI-21** *(amends LLM context, `context.ts` / `prompt.ts`)* The context message for every turn kind lists **all** questions, grouped:
  - **Open AI questions** — as today.
  - **Answered questions** — question, answer, `answered_via`.
  - **Resolved questions** — question, resolution, reason; with the rule "Do not ask these again unless new information makes them relevant; if so, explain why."

  The Working Copy, sources, notes and issues are unchanged. The discussion turn's system prompt adds: "This is an overview discussion. Update the Working Copy with apply_section_patch wherever the discussion settles something, and record open points with ask_question."
- **GI-22** One turn at a time per session across all turn kinds (message, analysis, answer). The workspace exposes `turnInProgress` so every Send / Answer / Analyze control is disabled while any turn streams in this tab; the server's `409 turn_in_progress` remains the authority.
- **GI-23** *(amends SR-3.6)* Before ingestion, Notes may be added and the specification edited; AI turns (`/messages`, `/analyze`, `/answer`) return `409 not_ingested`.

### 5.6 Clarification loop interaction

- **GI-24** After **End clarification** (SR-8.2b): **Answer** still works (the AI incorporates the answer but cannot ask new questions — `ask_question` is not offered, unchanged); **Analyze** still works and runs without `ask_question` (the analysis then only drafts the spec). The prompt's `CLARIFICATION_ENDED_TEXT` applies to all turn kinds.

### 5.7 Create and ingest (New session page)

- **GI-25** The New session page has two submit buttons: **Create session** (primary; creates without ingesting, as GI-2) and **Create and ingest**. The code repository select stays above both, so a repository can still be set first.
- **GI-26** **Create and ingest** sends `POST /api/sessions` with `ingest: true`. After the creation transaction commits, the server runs the same ingest core as `POST /ingest` (GI-4, GI-5) for the new session. No session lock is needed: the session was just created and no tab holds it yet.
  - Ingest succeeded → response `{ session, ingested: true }`. The client navigates to `/sessions/:id?analyze=1`.
  - Ingest failed → the session is still created (source failures never fail creation, as today). Response `{ session, ingested: false, ingestError: { code, message, correlationId } }`. The client navigates to `/sessions/:id`, where **Ingest ticket** is shown with the error.
- **GI-27** When the workspace opens with `?analyze=1`, it starts the analysis turn (GI-9) once this tab holds the session lock and `intakeState = ingested`, then removes the parameter with `history.replaceState` so a reload does not start it again. `409 already_analyzed` is ignored silently. If the lock is held elsewhere, nothing runs and the parameter is removed.

---

## 6. UI summary (amends SPEC_DOC §6)

New session page: ticket keys, code repository, **Create session** and **Create and ingest** (GI-25).

Workspace left panel, top to bottom:

1. **Session header** — tickets, Audit trail link, code repository picker.
2. **Sources** — before ingest: **Ingest ticket** + **Analyze after ingest**; after: sources list + **Refresh sources**; after ingest without analysis: **Analyze ticket**.
3. **Questions** — grouped list with **Answer**, **Resolve**, **Edit answer**, **Reopen**.
4. **Discuss with AI** — collapsible chat.
5. **Notes** — unchanged.

Accessibility (NFR-10): every new control is a native `button`/`textarea` with a visible label; status changes announced via an `aria-live="polite"` region in the Questions section; the inline answer form moves focus to its textarea on open and back to the **Answer** button on cancel.

---

## 7. Data model and migration

New migration `db/migrations/0005_guided_intake.sql`:

```sql
ALTER TABLE planning_session
  ADD COLUMN ingested_at timestamptz,
  ADD COLUMN analyzed_at timestamptz;

ALTER TABLE ai_question
  ADD COLUMN answer_text text,
  ADD COLUMN answered_at timestamptz,
  ADD COLUMN answered_via text CHECK (answered_via IN ('facilitator', 'ai')),
  ADD COLUMN resolution text CHECK (resolution IN ('answered', 'not_relevant')),
  ADD COLUMN resolved_at timestamptz;

-- Status 'resolved' replaces 'dismissed'. 'dismissed' stays allowed for one release (expand/contract).
ALTER TABLE ai_question DROP CONSTRAINT ai_question_status_check;
ALTER TABLE ai_question ADD CONSTRAINT ai_question_status_check
  CHECK (status IN ('open', 'answered', 'resolved', 'dismissed'));

UPDATE ai_question
   SET status = 'resolved', resolution = 'not_relevant', resolved_at = created_at
 WHERE status = 'dismissed';

ALTER TABLE conversation_message ADD COLUMN question_id uuid REFERENCES ai_question (id);

-- Existing sessions were ingested at creation; do not ask them to ingest or analyze again.
UPDATE planning_session p
   SET ingested_at = s.first_retrieved,
       analyzed_at = s.first_retrieved
  FROM (SELECT session_id, min(retrieved_at) AS first_retrieved FROM source_snapshot GROUP BY session_id) s
 WHERE s.session_id = p.id;
```

- `dismiss_reason` is kept and reused as the resolve reason (rename deferred to the contract step).
- The release after this one drops `'dismissed'` from the check constraint and removes the `/dismiss` route.
- `SPEC_DOC.md` §7.2 is updated to list the new columns.

---

## 8. API, LLM and audit changes

### 8.1 Endpoints (amends SPEC_DOC §7.3)

| Method & path | Lock | Body | Response |
|---|---|---|---|
| `POST /api/sessions` | — | adds `ingest?: boolean` | adds `ingested: boolean`, `ingestError?` (GI-26) |
| `POST /api/sessions/:id/ingest` | yes | — | `{ ingestedAt, sources }`; `409 already_ingested` |
| `POST /api/sessions/:id/analyze` | yes | — | SSE turn; `409 not_ingested` / `already_analyzed` / `turn_in_progress` |
| `POST /api/sessions/:id/questions/:qid/answer` | yes | `{ text }` | SSE turn; `409 question_resolved` / `not_ingested` / `turn_in_progress`; `413 body_too_large` |
| `POST /api/sessions/:id/questions/:qid/resolve` | yes | `{ reason? }` | `{ id, status, resolution, reason }`; `409 question_not_open` |
| `POST /api/sessions/:id/questions/:qid/reopen` | yes | — | `{ id, status }`; `409 question_not_resolved` |
| `GET /api/sessions/:id/questions` | no | — | adds `answerText`, `answeredAt`, `answeredVia`, `resolution`, `resolvedAt` |
| `GET /api/sessions/:id/messages` | no | — | adds `questionId` per message |
| `POST /api/sessions/:id/messages` | yes | `{ text }` | unchanged; adds `409 not_ingested` |

The three SSE routes share one helper (extracted from `messages/route.ts`) for the turn advisory lock, first-token metric, error mapping and release. Client: `streamMessage` generalises to `streamTurn(path, body)`.

### 8.2 Turn runner

`runFacilitatorTurn` takes a discriminated `kind`:

```ts
type TurnKind =
  | { kind: 'message'; text: string }
  | { kind: 'analysis' }
  | { kind: 'answer'; questionId: string; text: string };
```

- `message` — unchanged behaviour.
- `analysis` — persists the `system` message (GI-10), appends `ANALYSIS_TEXT`, question limit `ANALYSIS_MAX_QUESTIONS`, sets `analyzed_at` on success.
- `answer` — the answer and its conversation message are persisted by the route transaction (GI-14); the runner appends `ANSWER_TEXT` for that question.
- The SR-3.2 corrective follow-up applies to all kinds.
- `MAX_QUESTIONS_PER_TURN` becomes a per-turn value on `FacilitatorTurnState` (`maxQuestions`).

### 8.3 Prompt additions (`facilitator/prompt.ts`)

- `ANALYSIS_TEXT` — "This is the initial analysis of newly ingested tickets. 1) Reply with a short summary of your understanding of the work. 2) Draft every section the sources support with apply_section_patch; leave the rest empty. 3) Record contradictions, risks, dependencies and assumptions in their sections. 4) Ask up to N questions, most critical gaps first (Problem Statement, Scope, Functional Requirements, Technical Design, Acceptance Criteria). Do not ask what the sources or the code already answer."
- `ANSWER_TEXT(question)` — "The facilitator answered question <id>: "<text>". Their answer is the last message. Work it into every affected section with apply_section_patch. If the answer is vague (SR-3.3) or reveals a new gap, ask one targeted follow-up question. Do not call mark_question_answered for this question; it is already answered."
- Context message: answered and resolved question groups (GI-21).
- Snapshot tests in `facilitator/__snapshots__` are updated.

### 8.4 Audit (amends SR-12.1 "Additional events")

New actions in `src/server/audit/actions.ts`: `sources.ingested`, `question.answered`, `question.resolved`, `question.reopened`. `question.dismissed` stays in the list (historical records) but is no longer emitted. `ai.suggestion.details` gains `turnKind` (`message` | `analysis` | `answer`) and, for answers, `questionId`.

---

## 9. Error handling

| Case | Behaviour |
|---|---|
| Ingest fails (Atlassian 5xx, network) | Error banner with correlation id; no snapshots written; button stays; `sources.ingested` failure audited. |
| Token expired during ingest | Existing SR-1.6 re-auth flow; session state unchanged. |
| Ingest succeeds, chained analysis fails | Sources shown; error banner in the Sources block; **Analyze ticket** button shown. |
| AI unavailable during an answer turn | Answer kept, question `answered`; banner "AI unavailable: your answer was saved but not yet worked into the specification. Use Edit answer to resend." |
| Two tabs | Session lock (D-3) as today: read-only tab cannot ingest, analyze, answer or resolve. |
| Concurrent turn | `409 turn_in_progress`; client restores the unsent answer text into the form. |
| Answer patch hits a section the Facilitator edited | Pending suggestion (D-5), unchanged; the question shows "1 suggestion pending" instead of "patched". |

---

## 10. Testing

- **Unit** — `ingestSources` first-ingest summary message and counts; turn runner per kind (analysis limit, `analyzed_at` only on success, answer instruction present); prompt snapshot for the three question groups; `mark_question_answered` with `answerSummary` and refusal on resolved questions.
- **Component** (`vitest` + Testing Library) — `SessionHeader` states (not_ingested / ingested / analyzed, chained checkbox); `QuestionsList` grouping, Answer form, Resolve from open vs answered, Reopen, disabled while `turnInProgress` or `readOnly`; `Conversation` "Answer to:" rendering.
- **Integration** (`tests/integration`) — creation no longer writes snapshots; `/ingest` then `/analyze` happy path with the fake LLM client; every new `409`; answer persisted when the fake client errors; migration of `dismissed` rows and of existing sessions' timestamps; audit records for each new action.
- **E2E** (`tests/e2e`) — create session → set repository → Ingest (chained) → questions appear → answer one → spec section updates → resolve it → resolve another as not relevant → Discuss with AI updates a section. Second flow: **Create and ingest** → workspace opens with sources listed and the analysis streaming; reload does not start a second analysis. Update `clarification.spec.ts` and `a11y.spec.ts` for the new controls.
- **Evals** — `evals/`: the analysis turn on the seeded fixtures asks about each seeded Critical gap (replaces "within its first 2 turns" with "in the analysis turn" for AC-3 of SPEC_DOC §10).

---

## 11. Acceptance criteria

1. Creating a session writes no `source_snapshot` rows; the workspace shows **Ingest ticket** and "Sources not ingested yet."
2. The code repository can be changed before ingesting; ingesting afterwards lists all sources with their ingest status and one "Sources ingested" system message.
3. With **Analyze after ingest** checked, one click produces a streamed AI analysis, Working Copy patches and up to 8 questions; `analyzed_at` is set.
4. With it unchecked, **Analyze ticket** appears and produces the same result.
5. Answering a question streams an AI turn that patches at least one related section (or creates a pending suggestion), and the question moves to **Answered** showing the answer.
6. **Resolve** on an answered question moves it to **Resolved** with resolution "answered"; **Resolve** on an open question asks for an optional reason and records "not relevant".
7. A resolved question is listed to the AI as resolved, and the AI does not re-ask it in the next turn for the seeded fixture.
8. **Discuss with AI** can change a section, and its context includes all questions with answers and resolutions.
9. While any turn is streaming, all Send / Answer / Analyze controls are disabled; a second request from another client returns `409 turn_in_progress`.
10. Each new action produces its audit record with all §14 fields; existing sessions open in `analyzed` state after the migration, with former dismissed questions shown as Resolved (not relevant).
11. **Create and ingest** opens the workspace with sources ingested and the analysis running; if ingestion fails, the session exists and shows **Ingest ticket** with the error.

---

## 12. Decisions

| ID | Gap | Decision | Revisit if |
|---|---|---|---|
| GD-1 | How "chained" analysis is triggered. | Client-side chain: `/ingest` then `/analyze`, controlled by a default-on checkbox. Two endpoints keep ingest (no LLM, can be slow on Atlassian) separate from the SSE turn and reuse the existing turn lock. | Users want ingest + analysis to survive closing the tab → move both into a worker job. |
| GD-2 | Question limit for the first turn. | 8 for the analysis turn (configurable); D-7's 3 for every other turn. A first pass over fresh tickets naturally has more gaps; 3 would hide most of them behind extra turns. | Facilitators find 8 overwhelming in a live meeting. |
| GD-3 | When a question becomes `answered`. | When the Facilitator submits the answer (before the AI runs), not when the AI acknowledges it. The Facilitator's answer is the fact; AI processing is retriable via Edit answer. | — |
| GD-4 | "Dismiss" vs "Resolve". | One terminal state `resolved` with `resolution` (`answered` / `not_relevant`); `dismissed` migrates to `resolved/not_relevant`. Matches the requested wording and lets the AI see why a question closed. | — |
| GD-5 | Is "Discuss with AI" a new chat or the existing conversation? | The existing conversation, reframed and given full question context. A separate thread would split history the AI replays every turn (LLM-4) and duplicate the turn machinery. | Users want separate threads per topic. |
| GD-6 | Existing sessions. | Backfilled as ingested and analyzed so nothing re-runs on open. | — |
| GD-7 | Resolving as not relevant: tell the AI now or later? | **User decision (2026-10-29):** only on the AI's next turn, through the resolved-questions group in its context. No AI turn runs on resolve. | — |
| GD-8 | Ingest from the New session page. | **User decision (2026-10-29):** yes, as **Create and ingest** (GI-25–GI-27). Ingest runs in the create request; analysis starts in the workspace because it needs the session lock and a streaming view. | — |
| GD-9 | Answer several questions in one AI turn. | **User decision (2026-10-29):** not needed if it adds complexity. It does (multi-question turn instructions, per-question failure state, a batch form), so it is out of scope. | Facilitators routinely answer many questions back to back. |

---

## 13. Open questions

None. The three questions from the first draft are settled in GD-7, GD-8 and GD-9.

---

## 14. Implementation plan

| # | Task | Main files | Depends on |
|---|---|---|---|
| 1 | Migration 0005 + repo mapping (`ingestedAt`, `analyzedAt`, `intakeState`, question columns) | `db/migrations/0005_guided_intake.sql`, `sessions/repo.ts`, `api/sessions/[id]/route.ts` | — |
| 2 | Stop ingest at creation; `ingestSources` core + `POST /ingest`; `sources.ingested` audit | `createSession.ts`, `refreshSources.ts` → `ingestSources.ts`, `api/sessions/[id]/ingest/route.ts`, `audit/actions.ts` | 1 |
| 3 | Turn kinds in `runFacilitatorTurn`; shared SSE turn helper; `POST /analyze`; `not_ingested` guard on `/messages` | `facilitator/runTurn.ts`, `facilitator/tools.ts`, `facilitator/prompt.ts`, `api/sessions/[id]/analyze/route.ts`, `api/sessions/[id]/messages/route.ts`, `config.ts` | 1, 2 |
| 4 | Answer / resolve / reopen routes; `mark_question_answered` summary; context groups | `api/sessions/[id]/questions/[qid]/{answer,resolve,reopen}/route.ts`, `facilitator/context.ts`, `facilitator/prompt.ts`, `facilitator/tools.ts` | 3 |
| 5 | Left panel: Ingest/Analyze controls, `turnInProgress` in `WorkspaceProvider`, `streamTurn` client | `SessionHeader.tsx`, `SourcesList.tsx`, `WorkspaceProvider.tsx`, `lib/api/sse.ts` | 2, 3 |
| 6 | Questions UI: groups, Answer form, Resolve, Edit answer, Reopen | `QuestionsList.tsx` | 4, 5 |
| 7 | Discuss with AI: collapsible conversation, "Answer to" rendering, reload on `done` | `Conversation.tsx`, `sessions/[id]/page.tsx` | 5 |
| 8 | **Create and ingest**: `ingest` option on `POST /api/sessions`, second button on the New session page, `?analyze=1` auto-start in the workspace | `api/sessions/route.ts`, `createSession.ts`, `sessions/new/page.tsx`, `SessionHeader.tsx` | 2, 5 |
| 9 | Docs: SPEC_DOC §6/§7.2/§7.3/FR-2/FR-3 amendments, README, MANUAL_TEST; e2e, a11y and eval updates | `SPEC_DOC.md`, `README.md`, `MANUAL_TEST.md`, `tests/e2e/*`, `evals/*` | 6, 7, 8 |
