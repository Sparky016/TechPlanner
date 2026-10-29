# ADR-0017: Guided Intake and Question Lifecycle

Status: Proposed

Date: 2026-10-29

Source: user request (2026-10-29); specification `docs/specs/guided-intake-and-question-answering.md` §12 (GD-1 to GD-9). Amends `SPEC_DOC.md` FR-2, FR-3, §6, §7.2 and §7.3, and ADR-0016 (the code repository is set before intake).

## Context

Creating a session ingested every source immediately, and the AI did nothing until the Facilitator typed a message. The Facilitator could not set the code repository before the sources were pulled. AI questions could only be dismissed, so an answer reached the specification only through free-form conversation, and the AI could not see which questions were closed or why.

## Decision

- **GD-1 Chained analysis is client-side.** The client calls `POST /ingest`, then `POST /analyze`, controlled by a checkbox (**Analyze after ingest**, checked by default). Ingest (no LLM, possibly slow on Atlassian) stays a plain request. Analysis is an SSE turn that reuses the existing per-session turn lock.
- **GD-2 The first turn may ask 8 questions.** The analysis turn is limited by `ANALYSIS_MAX_QUESTIONS` (default 8); every other turn keeps the limit of 3 (D-7). A first pass over fresh tickets naturally finds more gaps than 3.
- **GD-3 A question is `answered` when the Facilitator submits the answer,** before the AI runs. The answer is persisted first, so an LLM failure loses nothing, and **Edit answer** resends it.
- **GD-4 One terminal state, `resolved`,** with a resolution of `answered` or `not_relevant`. `dismissed` rows migrate to `resolved` / `not_relevant`. `dismissed` stays allowed by the check constraint and `/dismiss` stays as an alias for one release (expand/contract); the next release removes both.
- **GD-5 Discuss with AI is the existing conversation,** reframed and given the full question context (open, answered and resolved questions with answers and reasons), not a separate thread. A second thread would split the history the AI replays every turn (LLM-4) and duplicate the turn machinery.
- **GD-6 Existing sessions are backfilled** as ingested and analyzed (migration 0005), so nothing re-runs when they are opened.
- **GD-7 Resolving does not call the AI.** The AI learns of a resolution from the resolved-questions group in its next turn's context, with the rule not to ask those questions again unless new information makes them relevant.
- **GD-8 Create and ingest.** The New session page can ingest during creation. Ingest runs in the create request after the creation transaction commits; analysis starts in the workspace (`?analyze=1`), because it needs the session lock and a streaming view. A failed ingest still creates the session.
- **GD-9 One answer per AI turn.** Answering several questions in one turn needs multi-question instructions, a per-question failure state and a batch form, so it is out of scope.

Supporting decisions:

- Intake state is derived from two timestamps on `planning_session` (`ingested_at`, `analyzed_at`) rather than stored as a status, so it cannot disagree with them. AI turns and Refresh sources return `409 not_ingested` before ingestion.
- `message`, `analysis` and `answer` are turn kinds of one runner and one SSE helper. One turn at a time per session holds across all kinds.
- The four new audit actions are `sources.ingested`, `question.answered`, `question.resolved` and `question.reopened`. `ai.suggestion` details gain `turnKind`.

## Rationale

Explicit steps give the Facilitator control over when sources are pulled and make questions the work queue: answer, see the specification change, close. Keeping ingest and analysis as separate requests keeps the slow, LLM-free step off the streaming path and reuses the turn lock. Persisting the answer before the model runs and resolving without an AI call keep the actions cheap and recoverable.

## Revisit if

- Facilitators want ingest and analysis to survive closing the tab: move both into a worker job (GD-1).
- Eight initial questions overwhelm a live meeting (GD-2).
- Facilitators routinely answer many questions back to back (GD-9).
- Users want separate discussion threads per topic (GD-5).
