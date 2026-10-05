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
