# SPEC_DOC — AI Tech Planning Assistant

| Field | Value |
|---|---|
| Status | Draft for implementation |
| Date | 2026-10-05 |
| Source | `PRD.md` (repo root) |
| Owner | Engineering Lead (primary user, PRD §7) |

---

## 0. Context & References

| Source | Status | Used for |
|---|---|---|
| `PRD.md` | Present — sole input | All requirements. Sections cited as `PRD §n` / `FR-n`. |
| `CONTEXT.md` / `CONTEXT-MAP.md` | **Does not exist** | — Glossary defined inline in §2 of this spec. |
| `PlanView.html` | **Does not exist** | — No recorded decision status; gaps resolved in §9. |
| `docs/adr/*.md` | **Does not exist** | — No accepted ADRs. Decisions in §9 are ADR candidates. |

**How to read this spec.** It has two layers that must never be confused:

1. **Requirements (§4–§8)** — traced to the PRD. Each item carries its PRD source.
2. **Resolved Decisions (§9, `D-n`)** — gaps the PRD leaves open, resolved by the spec author at the user's instruction ("resolve open knowledge gaps yourself, based on the desired outcome"). Each records the gap, decision, rationale and what would change it. Requirements that depend on a decision reference it as `[D-n]`.

---

## 1. Overview

Technical planning is done verbally and produces inconsistent specifications, which degrades the downstream AI Task Generator and AI Orchestrator (PRD §1). The AI Tech Planning Assistant is a web application in which an Engineering Lead loads a Jira ticket and its linked Confluence pages, runs a planning session with an AI facilitator that actively probes for gaps, watches a Generated Specification build live, evaluates its readiness, and publishes it back to Jira and Confluence — where it becomes the single source of truth for the downstream pipeline (PRD §1, §6).

**Primary quality metric (PRD §10):** a Generated Specification is implementation-ready when a developer unfamiliar with the project can complete the work without further clarification from the planning participants.

---

## 2. Glossary

| Term | Definition |
|---|---|
| **PRD (input)** | `PRD.md` in this repo — the product requirements for *this* tool. |
| **Generated Specification** | The document the tool produces for a Jira ticket. The PRD calls it "generated PRD"; this spec uses *Generated Specification* to avoid ambiguity. Structure fixed by FR-5. |
| **Facilitator** | The authenticated Engineering Lead running a Planning Session (PRD §7). |
| **Participant** | A Software Developer present in the meeting. In MVP participates verbally; does not log in to the session [D-3]. |
| **Planning Session** | A persisted unit of work bound to one or more Jira tickets, containing conversation, notes, working copy and revisions (FR-2). |
| **Working Copy** | The current, unsaved-to-history state of the Generated Specification, updated live by AI and Facilitator (FR-4) [D-5]. |
| **Revision** | An immutable snapshot of the Working Copy created by an explicit Save Draft, Restore, or Publish (FR-10, FR-11) [D-5]. |
| **Section** | One of the 27 headings mandated by FR-5. |
| **Section Status** | `Complete` / `Partial` / `Missing` (FR-6). |
| **Issue** | A readiness finding with severity `Critical` / `Warning` / `Informational` (FR-7). |
| **Readiness Score** | Percentage computed from Section Statuses [D-6]. |
| **Readiness Gate** | Advisory check: passes when no open Critical Issues exist (FR-8, FR-9) [D-6]. |
| **Override** | Facilitator bypass of a failing Readiness Gate, with justification + confirmation, audited (FR-9). |
| **Publish** | Explicit action that pushes a Revision to Jira and Confluence and triggers downstream (FR-13). |
| **Downstream Hook** | Configured mechanism signalling the existing AI Task Generator that a specification is published [D-9]. |
| **Audit Record** | Immutable log entry with the fields of PRD §14. |

---

## 3. Goals / Non-goals

### Goals (PRD §3)
- G1 Standardize technical planning via a fixed template (FR-5) and AI facilitation (FR-3, §9).
- G2 Eliminate missing implementation details via readiness evaluation and a clarification loop (FR-6–FR-8).
- G3 Produce implementation-ready Generated Specifications (PRD §10, §11).
- G4 Improve downstream AI task generation by publishing a single source of truth and triggering downstream (FR-13).
- G5 Maintain complete audit history and traceability (FR-11, FR-12, §14).
- G6 Integrate into existing Jira/Confluence workflows (PRD §13).

### Non-goals (PRD §4)
The system will not: generate production code; replace architectural discussion, Jira, Confluence or sprint planning; automatically approve designs. The Readiness Gate is advisory (FR-9) and never blocks a Facilitator.

### Out of scope for this release (PRD §15 Future Enhancements)
Multi-user authenticated participants; real-time collaborative editing; voice transcription/meeting summarization; diagram generation; API contract generation; database schema proposal; threat modeling; cost estimation; story points; milestones; reusable-service discovery; deeper task-decomposition integration beyond the Downstream Hook; centralized logging (FR-12); Product Owner / QA / Architect / BA roles (PRD §7 "Future Users").

---

## 4. Users & Roles

| Role | Capabilities in this release | Source |
|---|---|---|
| Facilitator (Engineering Lead) | Create/open sessions, converse with AI, edit Working Copy, save drafts, view/compare/restore revisions, run readiness, override, publish. | PRD §7 |
| Participant (Developer) | No login in MVP. Answers are relayed by the Facilitator in the conversation. May read the published Confluence page / Jira attachment. | PRD §7, §15 [D-3] |

Any authenticated user may act as Facilitator for a ticket they can read in Jira (authorization delegated to Atlassian) [D-12].

---

## 5. Functional Requirements

Requirement IDs `SR-<FR>.<n>` trace to PRD `FR-<n>`.

### FR-1 Atlassian Authentication
- **SR-1.1** The app authenticates users via Atlassian OAuth 2.0 (3LO) authorization-code flow with PKCE. (FR-1, §13)
- **SR-1.2** All Jira and Confluence reads/writes use the authenticated user's access token. No shared service account or personal access token is used for normal operation. (FR-1)
- **SR-1.3** Requested scopes [D-11]: `read:me`, `read:jira-work`, `write:jira-work`, `read:jira-user`, `read:confluence-content.all`, `read:confluence-space.summary`, `write:confluence-content`, `write:confluence-file`, `search:confluence`, `offline_access`.
- **SR-1.4** Deployment is bound to exactly one Atlassian Cloud site (`cloudId` configured); a user whose grant does not include that site is rejected with a clear message. [D-11]
- **SR-1.5** Access/refresh tokens are stored server-side only, encrypted at rest (AES-256-GCM, key from environment/secret store); the browser holds only an httpOnly, Secure, SameSite=Lax session cookie. [D-11]
- **SR-1.6** Expired access tokens are refreshed transparently; if refresh fails, the user is redirected to re-authenticate and unsaved Working Copy is preserved server-side.
- **SR-1.7** Login success, login failure, logout and token-refresh failure produce Audit Records. (FR-12 "Authentication")

### FR-2 Planning Session Creation
- **SR-2.1** Facilitator creates a session by entering one or more Jira issue keys (e.g. `ABC-123`). The first key is the **primary ticket** [D-8]. Keys are validated for format and existence/readability in Jira before creation.
- **SR-2.2** For each ticket the app retrieves: summary, description, issue type, status, priority, assignee, reporter, labels, components, fix versions, parent/epic, issue links, comments, attachment metadata, and remote/web links. (FR-2)
- **SR-2.3** Linked Confluence pages = pages referenced by Jira remote links plus Confluence page URLs found in the description or comments. Each is fetched (storage format → converted to text/markdown). Linked pages are followed one level only. (FR-2) [D-10]
- **SR-2.4** Attachments [D-10]: text (`.txt`, `.md`, `.json`, `.yaml`, `.csv`), PDF and DOCX ≤ 10 MB are text-extracted; images (`png`, `jpg`, `gif`, `webp`) ≤ 5 MB are passed to the model as images; max 20 ingested attachments per session. All others are listed by name/size/type only and marked "not ingested" in the UI.
- **SR-2.5** Total ingested context is capped (configurable; default 150k tokens). When exceeded, oldest comments and largest attachments are truncated first and the UI lists what was truncated.
- **SR-2.6** Retrieved source material is snapshotted into the session with a retrieval timestamp. Facilitator can trigger **Refresh sources**; diffs are shown to the AI as a new context message.
- **SR-2.7** If a session already exists for the primary ticket, the Facilitator is offered to open it instead of creating a duplicate (duplicate creation allowed after confirmation).
- **SR-2.8** Session creation produces an Audit Record (`draft.created`).

### FR-3 AI Technical Facilitator / PRD §9 AI Behaviour
- **SR-3.1** The AI is an active participant behaving as a senior software architect: asks follow-up questions, identifies ambiguity, contradictions, hidden/missing requirements, edge cases, risks and dependencies, validates/challenges assumptions, recommends improvements, ensures consistency. (FR-3, §9)
- **SR-3.2** The AI must not merely transcribe discussion; each AI turn must either (a) update the Working Copy, (b) ask at least one targeted question, or (c) both. (FR-3 "should never simply document")
- **SR-3.3** Vague statements (no quantity, owner, condition, or acceptance test where one is needed — e.g. "should be fast", "handle errors properly") are not accepted into a Section as Complete; the AI asks a concrete follow-up. (§9 "avoid accepting vague statements")
- **SR-3.4** Question prioritization: questions targeting open Critical Issues first, then Warnings, then Informational. The AI asks at most 3 questions per turn to keep the meeting flowing. [D-7]
- **SR-3.5** The left panel shows an **AI Questions** list: each open question with status `open` / `answered` / `dismissed`, linked to the Issue/Section it addresses. Facilitator may dismiss a question (reason optional, audited).
- **SR-3.6** Facilitator input modes: chat message (conversation), and **Notes** — free text that is included in AI context but not treated as a reply. (PRD §12)
- **SR-3.7** AI responses stream to the UI token-by-token. (FR-4 "real time")
- **SR-3.8** Every AI turn, including the structured changes it proposed, is recorded as an Audit Record (`ai.suggestion`). (FR-12)

### FR-4 Live Generated Specification
- **SR-4.1** The AI updates the Working Copy during discussion, covering at minimum: requirements, technical design (architecture), acceptance criteria, edge cases, risks, assumptions, dependencies, open questions. (FR-4)
- **SR-4.2** AI updates are expressed as **section-scoped patches** (replace section body, or append item to a section). Patches render in the center panel within 1 s of the AI producing them, with a transient highlight. (FR-4)
- **SR-4.3** Edit precedence [D-5]: if the Facilitator edited a Section after the AI last read it, an AI patch to that Section is **not** auto-applied; it is shown as a pending suggestion (accept / reject / edit-then-accept). Otherwise patches auto-apply. Accept/reject decisions are audited.
- **SR-4.4** The Facilitator can edit any Section directly (markdown editor). User edits are audited (`user.edit`, debounced: one record per Section per 30 s of activity, containing a diff). (FR-12)
- **SR-4.5** Working Copy is persisted server-side automatically (≤ 5 s after last change) so a browser crash loses no more than 5 s of edits. Autosave does **not** create a Revision. [D-5]

### FR-5 Generated Specification Template
- **SR-5.1** Every Generated Specification contains exactly these Sections in this order (FR-5): Executive Summary; Problem Statement; Business Context; Scope; Out of Scope; Functional Requirements; Non-functional Requirements; User Flows; Technical Design; Data Model; APIs; External Integrations; Security; Performance; Error Handling; Monitoring; Logging; Risks; Dependencies; Assumptions; Migration Strategy; Deployment Strategy; Rollback Strategy; Testing Strategy; Acceptance Criteria; Open Questions; Future Improvements.

  > Note: FR-5 lists 27 headings. "Edge Cases" is not a Section; edge cases are captured inside Functional Requirements, Error Handling and Acceptance Criteria [D-6].
- **SR-5.2** Sections cannot be removed or renamed. A Section that genuinely does not apply must contain an explicit "Not applicable — <reason>" statement, which the evaluator may score Complete.
- **SR-5.3** The document header contains: title, Jira ticket key(s) with links, Facilitator, session ID, revision number, readiness score at that revision, and override justification if an Override was used.
- **SR-5.4** Canonical storage format is Markdown. Jira and Confluence renderings are derived from it (§7).

### FR-6 Readiness Evaluation
- **SR-6.1** The AI evaluator assigns each Section a Section Status (`Complete` / `Partial` / `Missing`) with a one-line reason. (FR-6)
- **SR-6.2** The evaluator runs: automatically after each AI turn that changed the Working Copy (debounced to at most once per 20 s), on demand via "Evaluate now", and mandatorily before Publish. (FR-6 "continuously")
- **SR-6.3** Readiness Score = round(100 × Σ(wᵢ·vᵢ) / Σwᵢ) where v = 1 / 0.5 / 0 for Complete / Partial / Missing and wᵢ = 1 for every Section by default (weights configurable per deployment). [D-6]
- **SR-6.4** The evaluator's rubric is the PRD §11 acceptance criteria list plus the PRD §10 readiness definition. Specifically it must check: problem clearly defined; scope explicitly documented; requirements measurable; edge cases documented; dependencies identified; assumptions recorded; security addressed; performance expectations defined; monitoring specified; logging specified; testing strategy documented; rollback strategy documented; acceptance criteria measurable; risks documented; outstanding questions identified or resolved. (§10, §11)
- **SR-6.5** The right panel shows the score, per-Section status, missing Sections, Warnings, Critical Issues and action items (open AI questions). (PRD §12)
- **SR-6.6** Each evaluation is audited (`readiness.evaluated`) with score, statuses and issue counts.

### FR-7 Readiness Categories
- **SR-7.1** Each Issue has: id, severity (`Critical` / `Warning` / `Informational`), Section, description, and status (`open` / `resolved` / `accepted-risk`). (FR-7)
- **SR-7.2** Severity semantics (FR-7): Critical — implementation cannot reasonably begin; Warning — implementation can proceed with risk; Informational — improvement suggested.
- **SR-7.3** Mandatory Critical rules [D-6]: any of Problem Statement, Scope, Functional Requirements, Technical Design, Acceptance Criteria with status `Missing`; any Acceptance Criterion that is not measurable/testable; any unresolved contradiction between Sections.
- **SR-7.4** Issues persist across evaluations by stable identity (Section + normalized description); the evaluator resolves them when the gap is closed. Facilitator may mark a Warning/Informational as `accepted-risk` (audited); Critical Issues can only be resolved by the evaluator or bypassed via Override.

### FR-8 Clarification Loop
- **SR-8.1** The AI continues asking questions while any Critical Issue is open. (FR-8)
- **SR-8.2** The loop ends when (a) zero Critical Issues are open — the UI shows "Ready" and the AI states so — or (b) the Facilitator selects **End clarification**. After (b) the AI stops proactive questioning but still answers direct messages. (FR-8)
- **SR-8.3** With zero Critical Issues the AI may continue to raise Warnings, but must label them as non-blocking.

### FR-9 Readiness Override
- **SR-9.1** If Publish is attempted while the Readiness Gate fails, the UI requires **Bypass Readiness Gate**: a justification (min 20 characters) and an explicit confirmation step listing the open Critical Issues. (FR-9)
- **SR-9.2** The Override is audited (`readiness.override`) with justification and open Issue list, and is written into the Generated Specification header and the Jira comment. (FR-9, [D-6])
- **SR-9.3** The Override applies to one Publish only; a later Publish re-evaluates the gate.

### FR-10 Draft Saving
- **SR-10.1** **Save Draft** is available at any time and creates a Revision. (FR-10, FR-11)
- **SR-10.2** Drafts are never visible in Jira or Confluence. Publishing is a separate explicit action. (FR-10)
- **SR-10.3** Save Draft is audited (`draft.saved`); Working Copy autosave is audited at most as `draft.updated` once per 5 minutes of activity. (FR-12)

### FR-11 Version History
- **SR-11.1** A Revision is created on Save Draft, Restore, and Publish. Revisions are immutable and numbered sequentially per session. [D-5]
- **SR-11.2** History view lists revisions with number, timestamp, author, trigger (save/restore/publish), readiness score, and published flag. (FR-11)
- **SR-11.3** Compare any two Revisions: section-aligned line diff of the Markdown. (FR-11)
- **SR-11.4** Restore copies the chosen Revision into the Working Copy and creates a new Revision (`trigger=restore`); no history is deleted. (FR-11)

### FR-12 / PRD §14 Audit Logging
- **SR-12.1** Event types (FR-12): `auth.login`, `auth.logout`, `auth.failure`, `draft.created`, `draft.updated`, `draft.saved`, `ai.suggestion`, `ai.suggestion.accepted`, `ai.suggestion.rejected`, `user.edit`, `readiness.evaluated`, `readiness.override`, `publish.started`, `publish.completed`, `publish.failed`, `jira.updated`, `confluence.updated`, `downstream.triggered`, `revision.restored`, `error`.
- **SR-12.2** Each record contains (§14): timestamp (UTC, ms), user (Atlassian accountId + display name), session ID, ticket ID(s), action, result (`success` / `failure`), details (JSON). Additionally: record ID, previous-record hash, record hash. [D-13]
- **SR-12.3** Records are immutable: append-only storage with update/delete rejected at the database level, plus a SHA-256 hash chain so tampering is detectable. (§14 "immutable") [D-13]
- **SR-12.4** Stored on the hosting server's database (FR-12 "locally or on the hosting server"); retained indefinitely by default. Secrets and tokens are never written to audit details.
- **SR-12.5** Facilitators can view the audit trail for their sessions; export as JSON Lines. (§14 "troubleshooting, compliance, historical review")
- **SR-12.6** A verification command validates the hash chain and reports the first broken link.

### FR-13 Publish
- **SR-13.1** Publish runs on the latest Working Copy: (1) mandatory readiness evaluation, (2) gate check / Override (FR-9), (3) create a Revision marked published, then the external steps below. (FR-13)
- **SR-13.2** External steps, each independent, idempotent and individually retryable [D-8, D-9]:
  1. **Confluence** — create the page under the configured space/parent on first publish; on republish update the same page (stored page ID) with a new version. If the page was edited in Confluence since the last publish (version mismatch), the step fails with "page changed externally" and offers *overwrite* or *cancel* — never silently overwrite.
  2. **Jira attach** — attach `<KEY>-spec-r<rev>.md` to every session ticket.
  3. **Jira description** — insert/replace a delimited "Technical Specification" block at the end of each ticket description containing link to Confluence page, revision, readiness score and override flag. Original description content is never modified. [D-8]
  4. **Jira comment** — add a comment to every ticket: publisher, revision, score, Confluence link, Override justification if any.
  5. **Jira label** — add label `spec-published` to every ticket.
  6. **Downstream Hook** — fire after steps 1–5 succeed [D-9].
- **SR-13.3** Publish status UI shows each step's state (`pending` / `success` / `failed`) and a **Retry failed steps** action. Publish is `completed` only when all steps succeed; partial state is persisted and visible on reopening the session.
- **SR-13.4** Each step produces an Audit Record (`confluence.updated`, `jira.updated`, `downstream.triggered`) and the overall publish produces `publish.completed` or `publish.failed`.
- **SR-13.5** Republishing is allowed; each publish creates a new Revision and updates the same Confluence page.

---

## 6. User Interface (PRD §12)

Three-panel layout, desktop-first (min width 1280 px).

| Panel | Contents |
|---|---|
| Left | Session header (tickets, sources, Refresh sources); Conversation (streaming); AI Questions list; Notes. |
| Center | Generated Specification Working Copy (27 Sections, collapsible, per-Section status badge, inline markdown editing, pending AI suggestions inline); Save Draft; Version history (list, compare, restore). |
| Right | Readiness Score; per-Section status list; Missing Sections; Critical Issues; Warnings; Action items; Evaluate now; End clarification; Publish controls & publish step status. |

Additional screens: Login; Session list (my sessions, filter by ticket/status: draft / published / partially published); Audit trail view for a session.

Session lock [D-3]: a session is editable by one browser tab at a time. Opening it elsewhere shows read-only mode with "Take over" (audited).

---

## 7. Design

### 7.1 Architecture [D-1]
- **Frontend**: TypeScript, React (Next.js App Router), server-rendered shell; markdown editor component; SSE for streaming AI output and live patches.
- **Backend**: Next.js server (Node.js 22 LTS) route handlers + a background job worker in the same codebase for evaluation and publish steps.
- **Database**: PostgreSQL 16 — sessions, working copies, revisions, issues, questions, publish runs, encrypted tokens, audit log.
- **LLM** [D-2]: **GitHub Copilot SDK + GitHub Copilot CLI** are the only LLM integration path (user requirement). See §7.6.
- **Integrations**: Atlassian Cloud REST — Jira Platform REST v3, Confluence REST v2 (v1 for attachment/storage-format operations where v2 lacks them).

### 7.2 Data model (logical)
- `user` (atlassian_account_id PK, display_name, email, created_at)
- `oauth_token` (user_id, enc_access_token, enc_refresh_token, expires_at, scopes)
- `planning_session` (id UUID, primary_ticket_key, ticket_keys[], facilitator_id, status {draft, published, partially_published}, clarification_ended bool, confluence_page_id, confluence_page_version, created_at, updated_at, lock_holder, lock_expires_at)
- `source_snapshot` (session_id, kind {jira_issue, confluence_page, attachment}, ref, content_text, truncated bool, retrieved_at)
- `conversation_message` (session_id, seq, role {facilitator, ai, note, system}, content, created_at)
- `working_copy` (session_id PK, sections JSONB {name → {body, last_ai_read_at, last_user_edit_at}}, updated_at)
- `pending_suggestion` (id, session_id, section, patch, status, created_at)
- `revision` (session_id, number, sections JSONB, trigger {save, restore, publish}, readiness_score, author_id, created_at; immutable)
- `evaluation` (id, session_id, section_statuses JSONB, score, created_at)
- `issue` (id, session_id, severity, section, description, fingerprint, status, created_at, resolved_at)
- `ai_question` (id, session_id, issue_id?, text, status, created_at)
- `publish_run` (id, session_id, revision_number, override_justification?, steps JSONB, status, created_at)
- `audit_record` (id bigserial, ts, user_id, session_id, ticket_ids[], action, result, details JSONB, prev_hash, hash) — append-only

### 7.3 APIs (internal, JSON over HTTPS)
- `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`
- `GET/POST /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions/:id/refresh-sources`
- `POST /api/sessions/:id/messages` (returns SSE stream of AI tokens, patches, questions)
- `POST /api/sessions/:id/notes`
- `PATCH /api/sessions/:id/working-copy/sections/:section`
- `POST /api/sessions/:id/suggestions/:sid/{accept|reject}`
- `POST /api/sessions/:id/revisions` (Save Draft), `GET /api/sessions/:id/revisions`, `GET /api/sessions/:id/revisions/compare?a=&b=`, `POST /api/sessions/:id/revisions/:n/restore`
- `POST /api/sessions/:id/evaluate`, `POST /api/sessions/:id/end-clarification`
- `POST /api/sessions/:id/publish` (body: optional override justification + confirmation), `POST /api/sessions/:id/publish/:runId/retry`
- `GET /api/sessions/:id/audit`, `GET /api/sessions/:id/audit/export`
- `POST /api/sessions/:id/lock/take-over`

All endpoints require an authenticated session; session-scoped endpoints additionally verify the caller can read the primary ticket in Jira (cached ≤ 5 min).

### 7.4 Downstream Hook [D-9]
Configurable per deployment, one of:
- **Webhook**: HTTP POST to a configured URL, HMAC-SHA256 signed (`X-Signature` header, shared secret), 3 retries with exponential backoff (1 s, 5 s, 25 s), 10 s timeout. Payload:
  ```json
  { "event": "spec.published", "sessionId": "…", "primaryTicket": "ABC-123", "tickets": ["ABC-123"],
    "revision": 4, "readinessScore": 92, "override": false,
    "confluencePageUrl": "…", "attachmentName": "ABC-123-spec-r4.md",
    "specMarkdown": "…", "publishedBy": "<accountId>", "publishedAt": "ISO-8601" }
  ```
- **Label only** (default when no webhook is configured): the `spec-published` label from SR-13.2 step 5 is the signal; downstream tooling polls/uses Jira automation.

### 7.5 Configuration
`ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET`, `ATLASSIAN_CLOUD_ID`, `OAUTH_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`, `COPILOT_GITHUB_TOKEN`, `COPILOT_CLI_PATH`, `FACILITATOR_MODEL`, `EVALUATOR_MODEL`, `CONTEXT_TOKEN_BUDGET`, `CONFLUENCE_SPACE_KEY`, `CONFLUENCE_PARENT_PAGE_ID`, optional per-Jira-project overrides of space/parent, `DOWNSTREAM_WEBHOOK_URL`, `DOWNSTREAM_WEBHOOK_SECRET`, `SECTION_WEIGHTS` (JSON).

### 7.6 LLM integration — GitHub Copilot SDK & CLI [D-2]
- **LLM-1** All model calls (facilitation turns, readiness evaluation) go through the **GitHub Copilot SDK** (npm `@github/copilot-sdk`, used from the Node backend/worker). No direct calls to any model provider API.
- **LLM-2** The SDK drives the **GitHub Copilot CLI**, which is installed in the Docker image and runs in server mode; the SDK talks to it over JSON-RPC and manages the CLI process lifecycle. The CLI version is pinned in the image; the backend health check (`/healthz`) reports CLI availability and authentication state.
- **LLM-3** Authentication to Copilot uses a deployment-level GitHub token with a Copilot entitlement (`COPILOT_GITHUB_TOKEN`, an env var the SDK supports; issued from an OAuth GitHub App or dedicated bot account), stored as a secret, never logged. End users do **not** sign in to GitHub. FR-1's "no shared credentials" rule covers Atlassian operations only; the Copilot token is a service credential for model access and never touches Jira/Confluence. BYOK (bring-your-own model-provider key, which the SDK also supports) is not used. [D-2]
- **LLM-4** Each Planning Session maps to one Copilot SDK facilitation session (conversation history held by the app's DB and replayed/resumed as needed); readiness evaluation uses a separate, stateless Copilot session per evaluation so the evaluator is not biased by the conversation.
- **LLM-5** Structured outputs are produced via **custom tools registered with the SDK** — e.g. `apply_section_patch`, `ask_question`, `report_section_status`, `raise_issue`. The backend validates every tool call against a JSON schema before applying it; invalid calls are rejected and the model is told why.
- **LLM-6** The Copilot agent must have **no access** to the host filesystem, shell, network fetch or other built-in CLI tools; only the custom tools in LLM-5 are enabled (allow-list). This is enforced by the SDK client's tool enable/disable options plus a permission handler that denies every tool call not in the allow-list. The CLI runs with a dedicated empty working directory and no repository context.
- **LLM-7** Streaming: SDK streaming events (assistant message deltas, tool calls) are forwarded to the browser via SSE (SR-3.7, NFR-1).
- **LLM-8** Model selection: `FACILITATOR_MODEL` and `EVALUATOR_MODEL` hold model identifiers as exposed by Copilot. At startup the backend calls the SDK's list-available-models method and fails `/healthz` if a configured model is not available. Default: the strongest available reasoning model for facilitation (e.g. Claude Opus via Copilot) and a faster model for evaluation (e.g. Claude Sonnet via Copilot). Model IDs are configuration, not code.
- **LLM-9** Failure handling: CLI process crash → automatic restart (max 3 in 5 min, then `/healthz` unhealthy and UI shows "AI unavailable" while editing/saving continue to work); Copilot rate-limit or quota errors are retried per NFR-8 and surfaced with an `error` Audit Record.
- **LLM-10** An `LlmClient` interface wraps the SDK so tests can substitute a deterministic fake; behaviour evals (Testing strategy) run against the real SDK/CLI.

---

## 8. Non-functional Requirements

| ID | Requirement | Source |
|---|---|---|
| NFR-1 | AI first streamed token ≤ 3 s p95; Working Copy patch visible ≤ 1 s after generation. | FR-4 "real time" [D-7] |
| NFR-2 | Readiness evaluation completes ≤ 20 s p95. | FR-6 [D-7] |
| NFR-3 | Session open (incl. cached sources) ≤ 2 s p95; session creation with source fetch ≤ 30 s p95. | [D-7] |
| NFR-4 | Working Copy data loss ≤ 5 s of edits on crash. | FR-10 [D-5] |
| NFR-5 | Supports ≥ 50 concurrent active sessions per instance. | [D-7] |
| NFR-6 | All traffic TLS 1.2+; tokens encrypted at rest; no secrets in logs/audit; CSRF protection on state-changing endpoints; CSP set. | FR-1 [D-11] |
| NFR-7 | Atlassian content leaves the system only via GitHub Copilot (SDK/CLI), under the organisation's Copilot Business/Enterprise data terms (no training use). Users are shown this on first login. | [D-2] |
| NFR-8 | Atlassian API rate-limit (429) handled with `Retry-After`-respecting backoff; LLM errors retried twice then surfaced to the user without losing the message. | FR-12 "Errors" |
| NFR-9 | Operational logs (structured JSON, separate from Audit Records) and metrics: request latency, LLM latency/tokens/errors, Atlassian API errors, publish step failures, evaluator score distribution. Health endpoint `/healthz`. | PRD §14 [D-14] |
| NFR-10 | Accessibility: keyboard-operable, WCAG 2.1 AA contrast. | [D-14] |

### Error handling
- Every error surfaced in the UI has a human-readable message and a correlation ID; an `error` Audit Record is written with that ID. (FR-12)
- Source fetch failures for individual pages/attachments do not fail session creation; they are listed as "unavailable" with the reason.
- Publish failures follow SR-13.3 (per-step retry, no rollback of successful steps).

### Testing strategy
- Unit: score formula, Issue fingerprinting, patch application & edit-precedence, hash chain, Jira description block insert/replace idempotency.
- Integration: Atlassian API client against recorded fixtures; Postgres append-only enforcement (UPDATE/DELETE on `audit_record` must fail).
- LLM behaviour evals: a fixture set of ≥ 20 tickets with known gaps; pass criteria — facilitator asks about each seeded Critical gap within 3 turns; evaluator flags each seeded Critical gap; evaluator never marks a vague statement Complete (SR-3.3).
- E2E (Playwright): login (mocked OAuth), create session, converse, save, compare, restore, override, publish with injected step failure + retry.

### Deployment & rollback
- Single Docker image (web + worker processes + pinned GitHub Copilot CLI) plus managed PostgreSQL, deployed to the organisation's hosting server; DB migrations run forward-only on deploy. [D-1]
- Rollback: redeploy previous image; migrations must be backward compatible for one release (expand/contract).
- Migration strategy: greenfield — no existing data to migrate.

---

## 9. Resolved Decisions

Gaps not settled by the PRD, resolved by the spec author per user instruction. Each is a candidate ADR.

| ID | Gap | Decision | Rationale (tie to PRD outcome) | Revisit if |
|---|---|---|---|---|
| D-1 | Tech stack & hosting unspecified. | TypeScript / Next.js / Node 22 / PostgreSQL 16, single Docker image on the hosting server. | One language end-to-end, strong streaming support, Postgres gives relational history + enforceable append-only audit; FR-12 allows hosting-server storage. | Org mandates another stack or cloud. |
| D-2 | LLM integration unspecified in PRD. | **User directive (2026-10-05):** GitHub Copilot SDK + GitHub Copilot CLI (§7.6). Author-resolved sub-decisions: deployment-level Copilot token (no per-user GitHub login); custom-tool-only allow-list; strongest model for facilitation, faster model for evaluation, both configurable. | Directive from user. Single Atlassian login stays the only user auth (FR-1); locking down built-in tools keeps the agent a planner, not a code generator (§4). | Per-user Copilot attribution/billing is required → add GitHub OAuth per user. |
| D-3 | Multi-user participation (PRD §7 secondary users vs §15 future multi-user). | MVP: single Facilitator drives; Participants speak in the meeting; single-editor session lock. | §15 explicitly defers multi-user auth and collaborative editing. | §15 items get scheduled. |
| D-4 | Generated output naming collides with this PRD. | Term "Generated Specification". | Avoid ambiguity in docs and code. | — |
| D-5 | "Every draft creates a revision" (FR-11) vs real-time updates (FR-4). | Continuous autosave of Working Copy (no revision); Revision only on Save Draft / Restore / Publish; Restore is non-destructive. AI patches don't overwrite sections the user edited since AI last read them — they become pending suggestions. | Avoid revision-per-keystroke while keeping meaningful history and protecting human edits (§4 "does not replace engineering judgement"). | Users want automatic periodic revisions. |
| D-6 | Score formula, gate rule, Section mapping of FR-6 example. | Equal-weight score (Complete 1 / Partial 0.5 / Missing 0); gate = zero open Critical Issues (score is informational); mandatory Critical rules in SR-7.3; FR-6 "Architecture" ≙ Technical Design, "Edge Cases" evaluated within Functional Requirements / Error Handling / Acceptance Criteria; "Testing" ≙ Testing Strategy. | FR-8 ties loop termination to Critical gaps, so the gate must too; §10 says a developer must not need clarification — core sections missing violates that. | Calibration data shows score/gate disagree with developer feedback. |
| D-7 | No performance or pacing targets. | NFR-1–NFR-5 values; ≤ 3 questions per AI turn. | "Real time" in a live meeting implies sub-3 s responsiveness; capping questions keeps the meeting usable. | Measured meeting feedback. |
| D-8 | Multiple tickets; destructive "Update description". | First key = primary; all tickets receive attachment, delimited description block, comment and label; one Confluence page per session. Description update only appends/replaces a delimited block. | §13 asks to update description but §4 says don't replace Jira; preserving original ticket content is the safe reading. | Team wants description replaced wholesale. |
| D-9 | "Trigger downstream workflow" has no defined interface (today manual, §5). | Configurable signed webhook with defined payload; fallback signal = `spec-published` Jira label. Do not call the Task Generator's API directly. | Downstream interface is unknown; a webhook + label decouples and is adaptable. | Task Generator exposes a defined API. |
| D-10 | Which attachments / Confluence links to ingest. | SR-2.3–SR-2.5 limits (one-level links; text/PDF/DOCX/images with size caps; token budget with visible truncation). | Maximise useful context while keeping model input bounded and transparent. | Context limits or needs change. |
| D-11 | OAuth scopes, token storage, tenancy. | Scopes per SR-1.3; server-side AES-256-GCM token storage; one Atlassian site per deployment. | Least privilege for the operations in §13; FR-1 forbids shared credentials. | Multi-site requirement. |
| D-12 | Authorization model. | Delegated to Atlassian: can read primary ticket ⇒ can open its sessions; writes succeed only if Atlassian permits. | No separate permission system to maintain; aligns with "authenticated user identity used for all external operations" (§13). | Need for app-level roles (future users). |
| D-13 | How "immutable" audit is enforced. | Append-only Postgres table (trigger rejects UPDATE/DELETE, app role has INSERT/SELECT only) + SHA-256 hash chain + verify command. Indefinite retention. | §14 requires immutable records for compliance; hash chain makes tampering detectable. | Move to centralized logging (FR-12 future). |
| D-14 | Monitoring/accessibility unspecified for the tool itself. | NFR-9, NFR-10. | The tool demands Monitoring/Logging sections of others (§11); it should meet the same bar. | — |

---

## 10. Acceptance Criteria (release)

1. A user logs in with Atlassian OAuth; no PAT or shared credential is configured anywhere. (FR-1)
2. Creating a session with `ABC-123` shows its description, comments, attachments (ingested vs listed) and linked Confluence pages. (FR-2)
3. In a seeded ticket missing acceptance criteria, the AI asks about acceptance criteria within its first 2 turns and the evaluator raises a Critical Issue on Acceptance Criteria. (FR-3, FR-6, FR-7)
4. AI answers stream; a Section patch appears in the center panel ≤ 1 s after generation. (FR-4, NFR-1)
5. A Section edited by the Facilitator is not overwritten by a later AI patch; a pending suggestion appears instead. (D-5)
6. The Generated Specification always contains the 27 FR-5 Sections in order. (FR-5)
7. Right panel shows per-Section status and a score matching SR-6.3 for a known fixture. (FR-6)
8. Publish with an open Critical Issue requires justification (≥ 20 chars) and confirmation; the Override appears in the audit log, the spec header and the Jira comment. (FR-9)
9. Save Draft creates a Revision; two revisions can be compared; restoring revision 1 creates a new revision with revision 1's content. (FR-10, FR-11)
10. Every event type in SR-12.1 that occurs during an E2E run has an Audit Record with all §14 fields; an attempted UPDATE on `audit_record` fails; the chain verifier passes. (FR-12, §14)
11. Publish creates/updates the Confluence page, attaches the markdown to every ticket, inserts the delimited description block without altering original description text, comments, labels, and fires the webhook with a valid signature. (FR-13)
12. With Confluence publish forced to fail, Jira steps' results persist, the UI shows the failed step, and Retry completes it without duplicating attachments/comments. (SR-13.2, SR-13.3)
13. Ending clarification stops proactive AI questions. (FR-8)

---

## 11. Success Metrics (PRD §16)

Tracked post-launch (not release gates): ≥ 95 % of implementation tasks begin with a Generated Specification; decrease in clarification requests during implementation; developer survey on sufficiency without prior project knowledge; manual correction rate of downstream task generation; cross-team consistency of outputs; 100 % of published decisions traceable via revisions and audit log. Instrumentation: publish counts per Jira project, override rate, readiness score at publish, and post-publish edits to the Confluence page (detected on republish).

---

## 12. Open Questions

None blocking. All PRD gaps are resolved in §9; stakeholders should ratify D-1, D-2, D-8 and D-9 (organisation-specific) before implementation of those areas starts.

**To confirm against the Copilot SDK docs during the first implementation task.** The architecture was checked against the `github/copilot-sdk` README on 2026-10-05: JSON-RPC to the CLI in server mode, SDK-managed lifecycle, `COPILOT_GITHUB_TOKEN`, tool enable/disable plus a permission handler, and runtime model listing. The README does not name the exact TypeScript APIs for:
- registering custom tools (LLM-5)
- the tool enable/disable options (LLM-6)
- the streaming event types (LLM-7)
- resuming a session (LLM-4)

Confirm these against the SDK reference and record them in an ADR before building §7.6.
