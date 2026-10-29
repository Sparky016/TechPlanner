# Tech Planner

AI Tech Planning Assistant (Next.js App Router, TypeScript, MySQL 8.4).

## Development

Requirements: Node 22, npm, a native MySQL 8.4 server (no Docker needed).

```bash
npm ci
mysql -uroot -p < scripts/mysql-bootstrap.sql     # once: databases, users and grants (see "Database" below)
cp .env.example .env                              # then fill in values
npm run migrate                                   # applies db/migrations/*.sql as the owner (reads .env if present)
npm run dev                                       # http://localhost:3000
npm run worker                                    # background jobs (readiness evaluation, publish)
```

Scripts: `lint`, `typecheck`, `test` (unit, `src/**/*.test.ts`), `test:integration`
(`tests/integration/**`, sequential, needs the local MySQL), `test:e2e` (Playwright, needs the local MySQL),
`migrate`, `worker`, `audit:verify`, `eval:llm`, `perf`, `build`, `start`.

### Database

Install MySQL 8.4 LTS (8.4 is the minimum and target version):

- macOS: `brew install mysql@8.4 && brew services start mysql@8.4` (the formula is keg-only: add
  `$(brew --prefix mysql@8.4)/bin` to `PATH` for the `mysql` client).
- Debian/Ubuntu: add the [MySQL APT repository](https://dev.mysql.com/downloads/repo/apt/), choose `mysql-8.4-lts`,
  then `sudo apt-get install mysql-server` and `sudo systemctl start mysql`.
- Windows: the [MySQL Installer](https://dev.mysql.com/downloads/installer/) (8.4 LTS, "Server only"), run as a
  service on port 3306.

Then run `scripts/mysql-bootstrap.sql` once as root. It creates the `techplanner` and `techplanner_test` databases and
two users with **dev-only** passwords (never reuse them in a shared environment):

| User | Password (dev) | Used by | Privileges |
| --- | --- | --- | --- |
| `techplanner_owner` | `owner-dev-password` | `npm run migrate`, test resets (`MIGRATE_DATABASE_URL`) | everything on `techplanner` and `techplanner_*` |
| `techplanner_app` | `app-dev-password` | web, worker, scripts (`DATABASE_URL`) | per-table grants written by the migrations; `SELECT, INSERT` only on `audit_record` |

It also sets `log_bin_trust_function_creators = ON` (persisted), which MySQL requires for the owner to create the
schema's triggers while binary logging is on.

```bash
DATABASE_URL=mysql://techplanner_app:app-dev-password@localhost:3306/techplanner
MIGRATE_DATABASE_URL=mysql://techplanner_owner:owner-dev-password@localhost:3306/techplanner
```

`npm run migrate` connects with `MIGRATE_DATABASE_URL`, falling back to `DATABASE_URL`. Migration grants go to
`APP_DB_USER` (default `'techplanner_app'@'%'`). MySQL commits each DDL statement on its own, so a migration that fails
part-way leaves its earlier statements applied: undo them by hand before running `npm run migrate` again.

Tests use their own databases on the same server, so the dev data is never touched:

- Integration tests (`npm run test:integration`) drop, re-create and migrate `techplanner_test` (or the database
  `DATABASE_URL` names) as the owner, then run as the app user. Defaults are in `tests/integration/env.ts`.
- E2E (`npm run test:e2e`) uses `techplanner_e2e` (`E2E_DATABASE_URL`, `E2E_MIGRATE_DATABASE_URL`); evals use
  `techplanner_eval` and `npm run perf` uses `techplanner_perf`. The owner creates these on first use.

MySQL keeps table-level grants after `DROP DATABASE`, so the integration and E2E resets revoke the app user's
per-table grants before dropping their database. The perf reset does not; its leftover rows in `mysql.tables_priv`
are harmless (the next migration grants the same privileges again).

### Configuration

All settings come from environment variables, validated by `getConfig()` in `src/server/config.ts`.
See `.env.example`. Validation errors list variable names only, never values.

- `TOKEN_ENCRYPTION_KEY`: base64 of exactly 32 bytes (`openssl rand -base64 32`).
- `DOWNSTREAM_WEBHOOK_SECRET` is required when `DOWNSTREAM_WEBHOOK_URL` is set.
- `SECTION_WEIGHTS`: optional JSON object, section name to positive number.
- `CONFLUENCE_PROJECT_OVERRIDES`: optional JSON of per-Jira-project overrides, e.g.
  `{"ABC": {"spaceKey": "ENG", "parentPageId": "12345"}}`.
- `APP_BASE_URL`: used for absolute links and CSRF origin checks.

### Credentials setup

`.env` is git-ignored. Keep secrets there only, and never paste them into issues, chat, or logs.
Startup errors such as `Invalid configuration: ATLASSIAN_CLIENT_ID` name the variable that is missing or malformed, never its value.

**Atlassian OAuth app (`ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET`, `ATLASSIAN_CLOUD_ID`, `OAUTH_REDIRECT_URI`)**

1. In the [Atlassian Developer Console](https://developer.atlassian.com/console/myapps/), create an **OAuth 2.0 integration**.
2. Under **Authorization**, add the callback URL `http://localhost:3000/auth/callback`. It must match `OAUTH_REDIRECT_URI` exactly.
3. Under **Permissions**, add the **Jira API** and the **Confluence API**, with these scopes:
   - Jira: `read:jira-work`, `write:jira-work`, `read:jira-user`
   - Confluence: `read:confluence-content.all`, `read:confluence-space.summary`, `write:confluence-content`, `write:confluence-file`, `search:confluence`
   - Identity: `read:me`

   The app also requests `offline_access` during sign-in so it receives a refresh token. The console has no separate toggle for it.
4. Under **Settings**, copy the **Client ID** and **Secret** into `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET`.
5. Set `OAUTH_REDIRECT_URI=http://localhost:3000/auth/callback`. This matches the route in `src/app/auth/callback/route.ts`.
6. Find the Cloud ID for your site. Open `https://<your-site>.atlassian.net/_edge/tenant_info` in a browser and copy the `cloudId` value. This endpoint is undocumented by Atlassian, so after the first sign-in, confirm the ID appears in the `accessible-resources` response. The callback route rejects the sign-in if it doesn't.

**Encryption key (`TOKEN_ENCRYPTION_KEY`)**

Generate a value with `openssl rand -base64 32`. It must decode to exactly 32 bytes.

**Database (`DATABASE_URL`, `MIGRATE_DATABASE_URL`)**

Use the `mysql://` URLs from [Database](#database) above. Both must be `mysql://` URLs. Use generated passwords for any
shared environment.

Optional: `DB_POOL_SIZE` (connections per process, default 20) and `DB_POOL_ACQUIRE_TIMEOUT_MS` (how long a request
waits for a free connection before it fails with 503 `db_pool_exhausted`, default 5000). Each streamed facilitator
turn holds one connection. Keep the web and worker pools together below the server's `max_connections`.
`db_pool_wait_seconds` on `/metrics` shows the waits.

**Copilot (`COPILOT_GITHUB_TOKEN`, `FACILITATOR_MODEL`, `EVALUATOR_MODEL`)**

- `COPILOT_GITHUB_TOKEN` is a GitHub token with a Copilot entitlement. The app does not use the logged-in user, so this token must be set. Production guidance is in `SPEC_DOC.md` (LLM-3).
- `FACILITATOR_MODEL` and `EVALUATOR_MODEL` must be model IDs your Copilot account can use. The app checks them at startup. The dev setup uses `claude-haiku-5.5` for both.

**Confluence publish target (`CONFLUENCE_SPACE_KEY`, `CONFLUENCE_PARENT_PAGE_ID`)**

- `CONFLUENCE_SPACE_KEY` is the key in the space URL, `/wiki/spaces/<KEY>/...`. You can also find it under **Space settings → Space details**.
- `CONFLUENCE_PARENT_PAGE_ID` is the number in the page URL, `/wiki/spaces/<KEY>/pages/<id>/...`. Use the full address-bar URL. Short `/wiki/x/...` links redirect to sign-in and don't contain the ID.

**Application URL (`APP_BASE_URL`)**

Use `http://localhost:3000` for local development.

**Optional settings**

- `CONTEXT_TOKEN_BUDGET` defaults to `150000`.
- `COPILOT_CLI_PATH` is only needed when the Copilot CLI isn't on the default path. The Docker image sets it.
- `DOWNSTREAM_WEBHOOK_URL` and `DOWNSTREAM_WEBHOOK_SECRET` go together. The secret is required when the URL is set.
- `METRICS_TOKEN` enables `GET /metrics` with a bearer token. Leave it empty to return 404.

**Azure DevOps code investigation (optional: `AZURE_DEVOPS_ORG_URL`, `AZURE_DEVOPS_PROJECT`, `AZURE_DEVOPS_PAT`)**

When set, the facilitator agent can search and read code in your Azure DevOps repositories to ground the specification in the existing code, and can write a summary of its findings to a session ticket's Jira description. See [ADR-0016](docs/adr/0016-azure-devops-code-investigation.md).

1. Set `AZURE_DEVOPS_ORG_URL` to the organisation URL, e.g. `https://dev.azure.com/<org>`, and `AZURE_DEVOPS_PROJECT` to the project name.
2. In Azure DevOps, open **User settings → Personal access tokens** and create a token for that organisation with the **Code (Read)** scope only. Put it in `AZURE_DEVOPS_PAT`. Use a service account for shared environments.
3. Optional: limit the agent to some repositories with `AZURE_DEVOPS_REPOSITORIES=api,web`.
4. Code search uses the Azure DevOps [Code Search extension](https://marketplace.visualstudio.com/items?itemName=ms.vss-code-search), which must be installed in the organisation. Without it, `search_code` returns an error and the agent can still browse and read files.
5. Check the connection: the **New session** page and each session's **Code repository** panel call Azure DevOps live and show either "Connected to Azure DevOps (<project>): N repositories available" or the failure reason (for example a rejected PAT). **Re-check** repeats the call. `GET /api/azure-devops/status` returns the same result as JSON.
6. Pick the session's repository in that panel (or when creating the session). The agent investigates that repository first, and `search_code` searches it by default. With no repository picked, the agent searches every allowed repository.

The agent gets these tools: `list_repositories`, `search_code`, `list_code_directory`, `read_code_file` (at most 25 repository reads per turn, files cut at 40,000 characters) and `update_ticket_code_findings`. The last one upserts a block between `TECH-PLANNER-CODE-START` and `TECH-PLANNER-CODE-END` in the ticket description, as the signed-in facilitator, only when the facilitator asks for or agrees to it. The rest of the description is never changed, and each update is audited as `jira.updated` (`step: code_findings`).

### Verify Jira access with Atlassian CLI

Install the official [Atlassian CLI](https://developer.atlassian.com/cloud/acli/guides/install-windows/) first. On Windows, authenticate interactively in PowerShell:

```powershell
& "$env:LOCALAPPDATA\Programs\AtlassianCLI\acli.exe" jira auth login --web
```

Then check the authenticated account and list Jira projects it can access:

```powershell
& "$env:LOCALAPPDATA\Programs\AtlassianCLI\acli.exe" jira auth status
& "$env:LOCALAPPDATA\Programs\AtlassianCLI\acli.exe" jira project list
```

This CLI login is separate from the app's Atlassian OAuth settings in `.env`; it confirms Jira access for the CLI account, not that the app's OAuth client configuration works.
