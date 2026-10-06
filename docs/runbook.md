# Operations runbook

Source: SPEC_DOC.md §8 (deployment and rollback), ADR-0015 (Copilot CLI pin), task 38.

The target hosting platform is not specified. This runbook therefore uses generic Docker and Compose terms. `docker-compose.prod.example.yml` is a working reference: map its services onto whatever the organisation's hosting server runs.

## 1. The image

There is one image, `techplanner`, for every role. The `ROLE` environment variable selects the process:

| `ROLE`          | Process                                          | Lifetime                         |
| --------------- | ------------------------------------------------ | -------------------------------- |
| `web` (default) | Next.js standalone server on `PORT` (3000)       | long-running, `HEALTHCHECK` on `/healthz` |
| `worker`        | pg-boss job worker (`npm run worker` equivalent) | long-running                     |
| `migrate`       | forward-only migration runner (`npm run migrate` equivalent) | one-shot, exits 0 on success |

- `web` and `worker` **never** run migrations. Migrations run only through the explicit `migrate` role.
- Arguments passed to the container replace the role process, for example `docker run --rm techplanner id -u`.
- The image runs as the non-root `node` user (uid 1000). It contains only build output: the Next.js standalone server, the bundled worker and migration runner (`dist/*.mjs`), `db/migrations` and runtime `node_modules`. It contains no repository source, no `.env` file and no secrets.
- The GitHub Copilot CLI is installed at `/opt/copilot` at the version pinned in ADR-0015 (**1.0.90**, matching `@github/copilot-sdk` 1.0.16). `COPILOT_CLI_PATH=/opt/copilot/bin/copilot` is set in the image. Check it with:
  `docker run --rm --entrypoint sh techplanner -c '$COPILOT_CLI_PATH --version'`.
  The LLM client creates the CLI's working directory and home under the OS temp directory at runtime.
- To upgrade the CLI, bump `@github/copilot-sdk` and update ADR-0015, then build with `--build-arg COPILOT_CLI_VERSION=<copilotCliVersion from the SDK's package.json>`. Update the `ARG` default in the `Dockerfile` as well.

### Building

```sh
docker build -t techplanner:<release> .
```

Tag every release immutably (for example with the git short SHA). Rollback relies on the previous tag still being available.

**Hosts behind a TLS-intercepting proxy** (corporate proxy, antivirus HTTPS scanning) make `npm ci` fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `self-signed certificate in certificate chain`. Pass the extra root CA as a BuildKit secret:

```sh
docker build --secret id=npm_ca,src=$HOME/ca-bundle.pem -t techplanner:<release> .
```

The secret is mounted only while the `npm ci` / CLI install steps run, through `NODE_EXTRA_CA_CERTS`. It is never written to a layer, and it never reaches the final image. Never work around the error with `strict-ssl=false`.

`next build` imports route modules, and the database pool reads configuration at import time. So the build step sets obviously fake configuration values inline on that one `RUN` command. They are not `ENV`, and they do not exist in the runtime image.

## 2. Configuration and secrets

All configuration comes from the environment (see `.env.example` and `src/server/config.ts`). An invalid or missing required variable makes the process fail with `Invalid configuration: <names>`. Values are never logged.

Secrets. Store them in the hosting platform's secret store and inject them as environment variables:

| Variable                    | Purpose                                                                   |
| --------------------------- | ------------------------------------------------------------------------- |
| `ATLASSIAN_CLIENT_SECRET`   | Atlassian OAuth 2.0 (3LO) app secret                                      |
| `TOKEN_ENCRYPTION_KEY`      | base64 of exactly 32 bytes; encrypts stored Atlassian tokens. Rotating it invalidates stored tokens, so users must sign in again |
| `DATABASE_URL`              | Postgres connection string, including credentials                         |
| `COPILOT_GITHUB_TOKEN`      | Copilot-entitled GitHub token used by the Copilot CLI                     |
| `DOWNSTREAM_WEBHOOK_SECRET` | signing secret for the downstream webhook (required when `DOWNSTREAM_WEBHOOK_URL` is set) |
| `METRICS_TOKEN`             | bearer token for `GET /metrics` (optional; `/metrics` returns 404 when unset) |

Non-secret required settings: `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLOUD_ID`, `OAUTH_REDIRECT_URI`, `APP_BASE_URL`, `FACILITATOR_MODEL`, `EVALUATOR_MODEL`, `CONFLUENCE_SPACE_KEY` and `CONFLUENCE_PARENT_PAGE_ID`. Optional settings: `CONTEXT_TOKEN_BUDGET`, `CONFLUENCE_PROJECT_OVERRIDES`, `DOWNSTREAM_WEBHOOK_URL`, `SECTION_WEIGHTS` and `COPILOT_CLI_PATH`, which the image already sets.

`LLM_FAKE=1` swaps the Copilot client for a scripted fake. Use it only for smoke tests without a Copilot-entitled token, **never in production**.

Every role (`migrate`, `worker`, `web`) receives the same environment.

### Copilot token rotation

1. Issue a new Copilot-entitled token for the service account. Keep the old one valid.
2. Update `COPILOT_GITHUB_TOKEN` in the secret store.
3. Restart the worker, then web (rolling if possible). The token is read once per process, when the LLM client starts the CLI. Migrations are not involved.
4. Confirm `/healthz` reports `"copilot": {"ok": true}` once the LLM client has started. Then confirm a facilitator turn works.
5. Revoke the old token.

If the token is revoked or expires before rotation, LLM features fail with `ai_unavailable` and the `copilot` health check fails. The rest of the app keeps working. Follow steps 2 to 4.

## 3. Deploy

Order: **migrate → worker → web**.

1. **Migrate.** Run the new image once with `ROLE=migrate` against the production database, and wait for exit code 0. The runner applies each pending `db/migrations/*.sql` file and its `schema_migrations` row in one transaction, serialised by an advisory lock. A failed migration leaves nothing applied, and re-running applies only what is missing. Non-zero exit: stop. Do not roll out the new image. The old release is still serving against a schema that is still compatible (see §5).
2. **Worker.** Replace the worker containers with the new image (`ROLE=worker`). On `SIGTERM`, the worker stops the queue gracefully. Confirm the log line `[worker] started with N handler(s)`.
3. **Web.** Replace the web containers (`ROLE=web`). Wait until the container `HEALTHCHECK` (and the load balancer's probe of `GET /healthz`) reports healthy before you shift traffic. `/healthz` returns 200 with every check `ok`, and 503 otherwise.

Compose reference (local stand-in for the managed DB):

```sh
docker build -t techplanner .
docker compose --env-file prod.env -f docker-compose.prod.example.yml up -d --wait
curl -fsS localhost:3000/healthz   # {"status":"ok","checks":{"database":{"ok":true}}}
```

`depends_on` enforces the order: `postgres` healthy → `migrate` completed successfully → `worker` → `web`. Required variables use `${VAR:?}`, so Compose refuses to start when one is missing. In production, remove the `postgres` service and point `DATABASE_URL` at the managed database. Keep `prod.env` out of version control. `.env*` files are git-ignored and excluded from the Docker build context.

## 4. Rollback

A rollback **redeploys the previous image tag**. It never reverses migrations: they are forward-only, and there are no down migrations.

1. Redeploy the previous tag for web, then worker. Do **not** run `migrate` with the old image. Its migration set is a subset of what is applied, so it would do nothing anyway.
2. Wait for `/healthz` to report 200 on web.
3. Fix forward. The next release ships a corrected migration (if one is needed) with the next free number.

This is safe because of the expand/contract rule below. The previous release always runs against the current schema.

## 5. Migration rule: expand/contract, compatible for one release

Every migration must keep the **previous release** working against the **new schema**. Old code keeps serving during a deploy, between steps 1 and 3, and after a rollback.

- **Expand (release N):** add only. New tables, new nullable columns or columns with defaults, new indexes (`CREATE INDEX CONCURRENTLY` is not possible inside the runner's transaction; size large indexes accordingly), new enum values, and backfills. Release N's code writes both the old and the new shape where needed.
- **Contract (release N+1 or later):** remove or tighten. Drop old columns and tables, add `NOT NULL` or constraints that old code would violate, and rename (as add + backfill + drop). Do this only once no deployed or rollback-candidate release reads the old shape.
- Never rename or drop something in the same release that stops using it.
- Never edit a migration that has shipped. Add a new file with the next free number.
- The audit tables are append-only (ADR-0013). Migrations must not update or delete audit rows.

## 6. Health and monitoring

- `GET /healthz`: `database` check (`SELECT 1`), plus the `copilot` check once the LLM client has started in that process. Results never contain secrets. Timeout per check: 2 s. A cold Copilot CLI start can exceed this on the very first probe (ADR-0015).
- `GET /metrics`: Prometheus format, behind `METRICS_TOKEN`.
- Logs are structured JSON on stdout (pino). Collect them with the platform's log driver.
