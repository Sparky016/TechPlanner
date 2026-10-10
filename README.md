# Tech Planner

AI Tech Planning Assistant (Next.js App Router, TypeScript, PostgreSQL).

## Development

Requirements: Node 22, npm, Docker.

```bash
npm ci
cp .env.example .env                              # then fill in values
docker compose -f docker-compose.dev.yml up -d    # PostgreSQL 16 on :5432 (techplanner/techplanner/techplanner)
npm run migrate                                   # applies db/migrations/*.sql (reads .env if present)
npm run dev                                       # http://localhost:3000
```

Scripts: `lint`, `typecheck`, `test` (unit, `src/**/*.test.ts`), `test:integration`
(`tests/integration/**`, sequential, needs the dev database), `test:e2e` (Playwright), `build`, `start`.
`worker`, `audit:verify` and `eval:llm` print "not implemented" until their tasks land.

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

**Database (`DATABASE_URL`)**

For the dev database in `docker-compose.dev.yml`, use `postgres://techplanner:techplanner@localhost:5432/techplanner`. Change the password for any shared environment.

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
