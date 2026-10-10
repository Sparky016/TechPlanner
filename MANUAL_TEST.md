# Tech Planner Manual Smoke Test

This is a manual smoke test that shows whether Tech Planner is operational end to end. It takes about 30 to 45 minutes when run against real Atlassian and Copilot services. Run it after a fresh setup, after a deploy, or after changing configuration.

The test has six stages. Each stage builds on the one before it, so stop and investigate at the first failure. Record PASS or FAIL for each step in the [results table](#results-table).

## 0. Preconditions

| # | Requirement | How to check |
|---|-------------|--------------|
| P1 | Postgres is running and healthy | `docker compose -f docker-compose.dev.yml ps` shows `techplanner-db-1` as `healthy` |
| P2 | Migrations are applied | `npm run migrate` prints `No pending migrations` (or applies them and exits 0) |
| P3 | `.env` is configured | Copy `.env.example` to `.env` if needed. Set `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET`, `ATLASSIAN_SITE`, and `SESSION_SECRET` (see [README.md](./README.md)) |
| P4 | Port 3000 is free | `APP_BASE_URL` and `OAUTH_REDIRECT_URI` use `http://localhost:3000`. If another process holds port 3000, `npm run dev` moves to 3001, and the OAuth callback fails. Stop the other process first |
| P5 | Dev server is running | Run `npm run dev` in a separate terminal. Wait for `Ready` and confirm it is listening on `http://localhost:3000` |
| P6 | Test accounts and resources exist | An Atlassian account that can access `ATLASSIAN_SITE`, a disposable Jira project and ticket for publish tests (for example `SMOKE-1`), and a disposable Confluence space. Do not use production tickets |

Set a shell variable for the base URL to keep commands short:

```powershell
$BASE = "http://localhost:3000"
```

## Stage A: Infrastructure (no login needed)

These checks confirm the server, database, and auth gate work before anyone signs in.

| Step | Action | Expected result |
|------|--------|-----------------|
| A1 | `curl.exe -s -w "`n%{http_code}" $BASE/healthz` | HTTP `200`. JSON body has `"status":"ok"` and `"checks":{"database":{"ok":true}}` |
| A2 | Open `$BASE/login` in a browser | Login page renders with a **Sign in with Atlassian** link |
| A3 | `curl.exe -s -o NUL -w "%{http_code} %{redirect_url}\n" $BASE/sessions` | `307` redirecting to `/login` (unauthenticated users cannot reach the app) |
| A4 | `curl.exe -s -o NUL -w "%{http_code}\n" $BASE/api/sessions` | `401` |
| A5 | `curl.exe -s -o NUL -w "%{http_code}\n" $BASE/metrics` | `404` when `METRICS_TOKEN` is unset. This is expected and not a failure. If the token is set, expect `401` without a bearer token |

Notes:
- The `copilot` health check is not listed in A1 until the AI client starts. It appears after the first AI call (Stage D). Once it appears, it must also be `ok`.
- A `503` from `/healthz` means something is unhealthy. Read the `checks` object to find which one.

## Stage B: Authentication

| Step | Action | Expected result |
|------|--------|-----------------|
| B1 | On `/login`, click **Sign in with Atlassian** | Redirected to Atlassian. The consent page names your Atlassian site |
| B2 | Approve the consent | Redirected back to `$BASE/auth/callback`, then to `/sessions`. The sessions list loads without errors |
| B3 | Confirm the session list renders | A heading and a way to create a new session are visible. The page is not blank and shows no error banner |
| B4 | Log out using the sign-out control | Redirected to `/login`. Visiting `$BASE/sessions` again returns to `/login` |
| B5 | Sign in again (B1 and B2) | Lands on `/sessions` again |
| B6 | Failure path: sign out, click **Sign in with Atlassian**, then click **Cancel** or **Deny** on the Atlassian consent page | Returns to `/login` with an error message (URL contains `error=denied`) |

## Stage C: Session creation

Sign in before starting this stage.

| Step | Action | Expected result |
|------|--------|-----------------|
| C1 | Open the new-session page from the sessions list | The form asks for ticket keys |
| C2 | Enter one disposable ticket key (for example `SMOKE-1`) and submit | Redirected to `$BASE/sessions/<id>`. The workspace loads |
| C3 | Go back to the new-session page and submit the same ticket key again | Alert dialog: **A session already exists for this ticket.** The existing session is linked. No new session is created |
| C4 | Submit a malformed key such as `not a key!!` | Form shows a validation error (API returns `400` with `invalidKeys`). No session is created |
| C5 | Submit a key that does not exist in Jira, such as `ZZZ-99999` | Form shows an unreadable-ticket error (API returns `422` with `unreadable`). No session is created |
| C6 | Return to the sessions list | The session from C2 is listed. Duplicate and invalid attempts do not appear |

## Stage D: Workspace

Use the session from C2.

The workspace has three panels, each with an accessible label:
- **Session and conversation** (left)
- **Specification** (center)
- **Readiness** (right)

| Step | Action | Expected result |
|------|--------|-----------------|
| D1 | Open `$BASE/sessions/<id>` | All three panels render. The ticket context from Jira is shown in the session header |
| D2 | Click **Refresh sources** in the session header | Completes without an error. Source status is updated |
| D3 | Open **Audit trail** from the session header | Audit trail page opens. It lists at least the session creation event from Stage C |
| D4 | Return to the session. In the **Session and conversation** panel, type a short message in the message box (`#message-input`) such as `Smoke test: summarise the ticket`, and click **Send** | Button shows **AI is responding…** while streaming. Then the response appears in the conversation. It is either a reply or one or more AI questions. Both are a pass |
| D5 | Wait for the first AI call to finish, then open `$BASE/healthz` in a new tab | The `copilot` check appears with `"ok":true`. If it shows as failed or the request times out, see Troubleshooting |
| D6 | Add a note. Type `Smoke note` in the notes input (`#note-input`) and click **Add note** | The note is saved and visible after reload |
| D7 | Wait for a specification suggestion. If one appears in the **Specification** panel, click **Accept**. If it is not accepted, click **Reject** and confirm the spec is unchanged | Accept or reject updates the spec. No error is shown |
| D8 | Edit the spec text in the **Specification** panel, then click **Save Draft** | Saved without error. Reload the page and the edit is still there |
| D9 | Click **History** in the **Specification** panel | Lists at least one revision, including the draft you just saved |
| D10 | In the **Readiness** panel, click **Evaluate now** | Readiness result appears. It includes a status and a list of gate items. It does not show an error |
| D11 | Open the same session in a second browser tab | The second tab shows a lock banner with **Take over**. Mutating controls (Send, Save Draft, Publish) are disabled in the second tab. Click **Take over** in the second tab. The first tab's controls become disabled |
| D12 | Return to the first tab | It shows the lock banner and its controls are disabled. Click **Take over** again to restore control |

Stage D is also the only place where the AI service is exercised. If D4 fails, check the Copilot CLI and sign-in before continuing.

## Stage E: Publish

Use a disposable ticket and a disposable Confluence space. Publishing writes to real Jira and Confluence.

| Step | Action | Expected result |
|------|--------|-----------------|
| E1 | In the **Readiness** panel, click **End clarification** | Clarification ends. The Publish control becomes available |
| E2 | Click **Publish** in the **Publish** panel | Status shows **Publishing…** The step list (`Publish steps`) lists: Confluence page, Jira attachment, Jira description, Jira comment, Jira label |
| E3 | Wait for the run to finish | Status shows **Published** with a revision number. Every step is marked complete |
| E4 | In Confluence, open the page for this session | The page exists and its content matches the spec |
| E5 | In Jira, open the disposable ticket | The description is updated. An attachment is present. A comment is posted. The label is applied |
| E6 | Failure path (optional, run only if you can make a gate fail): make the readiness gate fail, then click **Publish** | Returns `409` with `gate_failed`. The override dialog opens with a justification field (`#override-justification`), a confirm checkbox, and buttons **Publish with override** and **Cancel**. Click **Cancel**. Nothing is published |
| E7 | Override path (optional): repeat E6 and fill in a justification, check the confirm box, click **Publish with override** | Publish runs. Status moves to **Published** |
| E8 | Conflict path (optional): change the Confluence page by hand after the last publish, then publish again | The Confluence step fails with `page_changed_externally`. The step offers **Overwrite** or **Cancel**. Click **Cancel**. Retry later with **Retry failed steps** |

## Stage F: Cleanup

| Step | Action | Expected result |
|------|--------|-----------------|
| F1 | Delete or archive the Confluence test page and the Jira test comment, label, and attachment | Test artefacts are removed. Leave the disposable ticket if it is shared |
| F2 | Stop `npm run dev` (Ctrl+C) | Process exits |
| F3 | Optional: `docker compose -f docker-compose.dev.yml ps` | Database container is still `healthy`. Stop it with `docker compose -f docker-compose.dev.yml down` only if you do not need it |

## Results table

Copy this table into the test log and fill it in.

| Step | Result (PASS / FAIL) | Notes |
|------|----------------------|-------|
| P1-P6 Preconditions | | |
| A1 healthz 200 and database ok | | |
| A2 login page renders | | |
| A3 unauthenticated redirect to /login | | |
| A4 API returns 401 | | |
| A5 metrics 404 (no token) | | |
| B1-B2 sign in lands on /sessions | | |
| B3 sessions list renders | | |
| B4 log out returns to /login | | |
| B5 sign in again | | |
| B6 denied path shows error=denied | | |
| C2 create session | | |
| C3 duplicate shows 409 dialog | | |
| C4 malformed key rejected (400) | | |
| C5 unreadable ticket rejected (422) | | |
| C6 session listed | | |
| D1 workspace renders three panels | | |
| D2 Refresh sources | | |
| D3 Audit trail | | |
| D4 Send gets AI response | | |
| D5 healthz copilot ok | | |
| D6 note saved | | |
| D7 accept or reject suggestion | | |
| D8 Save Draft persists | | |
| D9 History lists revision | | |
| D10 Evaluate now | | |
| D11-D12 lock banner and Take over | | |
| E1 End clarification | | |
| E2-E3 publish completes | | |
| E4 Confluence page correct | | |
| E5 Jira updated | | |
| E6-E8 optional failure paths | | |
| F1-F3 cleanup | | |

The smoke test passes when Stages A through E1-E5 are all PASS. The optional E6-E8 paths are only needed when you change publish logic.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---------|--------------|------------|
| `npm run dev` prints a port other than 3000 | Another process holds port 3000 | Find it with `Get-NetTCPConnection -LocalPort 3000` and stop that process, then restart `npm run dev`. Do not change `OAUTH_REDIRECT_URI` to avoid this, because the Atlassian app must match it |
| `/healthz` returns `503` with `database` failing | Postgres is down or the URL in `.env` is wrong | Run `docker compose -f docker-compose.dev.yml up -d` and check `ps` |
| `/healthz` returns `503` with `copilot` failing | Copilot CLI is not signed in, or the first cold start exceeded the 2 s check timeout | Run the Send action again (D4), then re-check `/healthz`. Sign in to the Copilot CLI if the failure persists |
| OAuth returns to `/login?error=state` or `oauth` | Callback host differs from `OAUTH_REDIRECT_URI`, or the browser was on a different port | Use `http://localhost:3000` only, and make sure the Atlassian app redirect URL matches |
| OAuth returns to `/login?error=site` | The account has no access to `ATLASSIAN_SITE` | Use an account that belongs to the configured site |
| Session creation returns an unreadable error for a valid ticket | Jira credentials or project permissions | Check that the account can view the ticket in Jira |
| Publish fails at a Jira step | Missing permission on the project, or the ticket was deleted | Check the step error in the publish panel and fix the Jira permission, then **Retry failed steps** |
| Second tab shows a lock banner unexpectedly | Another tab or window holds the session lock | Click **Take over** only if you own the other tab. Otherwise close the other tab |
