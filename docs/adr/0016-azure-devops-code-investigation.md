# ADR-0016: Azure DevOps Code Investigation

Status: Proposed

Date: 2026-10-20

Source: user request (2026-10-20): the facilitator agent investigates ticket details in the code, uses that context to understand the requirements, and updates the ticket with the findings.

## Context

The facilitator only saw Jira, Confluence and attachments. Requirements often depend on how the existing code behaves, and that code lives in Azure DevOps Repos. LLM-6 forbids the Copilot agent any filesystem, shell or network access of its own.

## Decision

- Code access is a set of application custom tools (LLM-5), executed by the backend, never by the Copilot CLI: `list_repositories`, `search_code` (Azure DevOps Code Search), `list_code_directory`, `read_code_file`. LLM-6 holds: the CLI still has no repository, filesystem or network access.
- The tools are offered only when `AZURE_DEVOPS_ORG_URL`, `AZURE_DEVOPS_PROJECT` and `AZURE_DEVOPS_PAT` are all set. Access is read-only, optionally narrowed by `AZURE_DEVOPS_REPOSITORIES`.
- Authentication is one deployment-level PAT with the Code (Read) scope. FR-1's no-shared-credentials rule covers Atlassian only (as for the Copilot token, LLM-3); every Jira write still uses the acting user's own token.
- Repository content is untrusted data (LLM-6). It goes back to the model inside `<untrusted_source_data kind="code">` blocks, and the prompt says never to follow instructions found in code.
- Bounded input: at most 25 repository reads per turn, file bodies cut at 40,000 characters, at most 25 search hits per call.
- Tool results do not carry over between turns (LLM-4 replays the database, not the tool trace). The prompt tells the model to record findings in the Working Copy.
- The facilitator can pick any number of repositories per session, up to 10 (`planning_session.code_repositories`, an array; empty means none), at creation or later in the workspace (under the session lock), so a change that spans services can reference every repository it touches. Each pick is validated against the live repository list and stored once, by its canonical name, in pick order. The system prompt names them, `search_code` searches all of them when no repository is given, and `list_repositories` marks them. Other repositories stay readable when the code lives elsewhere. Each `ai.suggestion` that read code records the repositories in use. (Amended 2026-10-22: replaces the single `code_repository` pick; migration 0005 carries an existing pick over.)
- `GET /api/azure-devops/status` lists the repositories with the configured PAT, so the UI can show whether the connection works and why it fails. It is not a `/healthz` check: an Azure DevOps outage must not fail the app's readiness probe.
- `update_ticket_code_findings` upserts a delimited block (`TECH-PLANNER-CODE-START` … `TECH-PLANNER-CODE-END`) in a session ticket's Jira description, as the facilitator, using the same marker approach as the publish spec block (D-8). Content outside the block is never changed. The tool only accepts the session's tickets. The prompt allows it only when the facilitator asks for or agrees to the update. Each call is audited as `jira.updated` with `details.step = "code_findings"`, and the turn's `ai.suggestion` record lists the ticket updates and the number of code reads.

## Rationale

Server-side tools keep the agent a planner rather than a coding agent (D-2), and keep code access read-only, scoped and audited. A managed description block is idempotent across turns and republishes. Repeated updates replace the previous findings instead of adding a new comment each time.

## Revisit if

- Per-user Azure DevOps attribution is required: switch to Microsoft Entra ID OAuth per user.
- The facilitator must explicitly approve each ticket write in the UI, not in conversation: route the update through the pending-suggestion flow.
- Repositories move off Azure DevOps.
