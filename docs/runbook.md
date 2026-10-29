# Operations runbook

Source: SPEC_DOC.md §8 (deployment and rollback), ADR-0015 (Copilot CLI pin), task 38.

The target hosting platform is not specified. This runbook therefore uses generic Docker and Compose terms. `docker-compose.prod.example.yml` is a working reference: map its services onto whatever the organisation's hosting server runs. The database is MySQL 8.4 LTS installed natively on that server (ADR-0017), not a container; §7 to §11 cover it.

## 1. The image

There is one image, `techplanner`, for every role. The `ROLE` environment variable selects the process:

| `ROLE`          | Process                                          | Lifetime                         |
| --------------- | ------------------------------------------------ | -------------------------------- |
| `web` (default) | Next.js standalone server on `PORT` (3000)       | long-running, `HEALTHCHECK` on `/healthz` |
| `worker`        | job queue worker (`npm run worker` equivalent)   | long-running                     |
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
| `DATABASE_URL`              | MySQL connection string (`mysql://…`) of the restricted **app** user, used by `web` and `worker` |
| `MIGRATE_DATABASE_URL`      | MySQL connection string of the **owner** user (DDL). Only the `migrate` service receives it (as its `DATABASE_URL`) |
| `COPILOT_GITHUB_TOKEN`      | Copilot-entitled GitHub token used by the Copilot CLI                     |
| `DOWNSTREAM_WEBHOOK_SECRET` | signing secret for the downstream webhook (required when `DOWNSTREAM_WEBHOOK_URL` is set) |
| `METRICS_TOKEN`             | bearer token for `GET /metrics` (optional; `/metrics` returns 404 when unset) |

Non-secret required settings: `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLOUD_ID`, `OAUTH_REDIRECT_URI`, `APP_BASE_URL`, `FACILITATOR_MODEL`, `EVALUATOR_MODEL`, `CONFLUENCE_SPACE_KEY` and `CONFLUENCE_PARENT_PAGE_ID`. `APP_DB_USER` is the `'user'@'host'` the migrations grant table privileges to; the `migrate` service needs it in production (§7.4). Optional settings: `DB_POOL_SIZE` (connections per process, default 20; web and worker each open a pool, so keep 2 × `DB_POOL_SIZE` plus headroom below MySQL's `max_connections`, default 151), `DB_POOL_ACQUIRE_TIMEOUT_MS` (default 5000; past it a request gets 503 `db_pool_exhausted`), `CONTEXT_TOKEN_BUDGET`, `CONFLUENCE_PROJECT_OVERRIDES`, `DOWNSTREAM_WEBHOOK_URL`, `SECTION_WEIGHTS` and `COPILOT_CLI_PATH`, which the image already sets.

`LLM_FAKE=1` swaps the Copilot client for a scripted fake. Use it only for smoke tests without a Copilot-entitled token, **never in production**.

`worker` and `web` receive the same environment. `migrate` receives it too, except that its `DATABASE_URL` is the owner connection (`MIGRATE_DATABASE_URL`) and it also gets `APP_DB_USER`. **Owner credentials exist only in the `migrate` service's environment**: never put `MIGRATE_DATABASE_URL` or the owner password in the `web` or `worker` environment, in the shared `x-app-env` block, or in an image. Check with `docker compose --env-file prod.env -f docker-compose.prod.example.yml config`: `techplanner_owner` must appear only under `migrate`.

### Copilot token rotation

1. Issue a new Copilot-entitled token for the service account. Keep the old one valid.
2. Update `COPILOT_GITHUB_TOKEN` in the secret store.
3. Restart the worker, then web (rolling if possible). The token is read once per process, when the LLM client starts the CLI. Migrations are not involved.
4. Confirm `/healthz` reports `"copilot": {"ok": true}` once the LLM client has started. Then confirm a facilitator turn works.
5. Revoke the old token.

If the token is revoked or expires before rotation, LLM features fail with `ai_unavailable` and the `copilot` health check fails. The rest of the app keeps working. Follow steps 2 to 4.

## 3. Deploy

Order: **migrate → worker → web**.

1. **Migrate.** Run the new image once with `ROLE=migrate` against the production database as the owner user, and wait for exit code 0. The runner applies each pending `db/migrations/*.sql` file in order and records it in `schema_migrations` once all its statements succeeded, serialised by a MySQL `GET_LOCK`. MySQL DDL is not transactional, so a failed migration can leave **partial changes behind**; re-running applies only the files not yet recorded. Non-zero exit: stop. Do not roll out the new image, and follow §10 before you retry. The old release is still serving against a schema that is still compatible (see §5).
2. **Worker.** Replace the worker containers with the new image (`ROLE=worker`). On `SIGTERM`, the worker stops the queue gracefully. Confirm the log line `[worker] started with N handler(s)`.
3. **Web.** Replace the web containers (`ROLE=web`). Wait until the container `HEALTHCHECK` (and the load balancer's probe of `GET /healthz`) reports healthy before you shift traffic. `/healthz` returns 200 with every check `ok`, and 503 otherwise.

Compose reference (MySQL on the host, set up as in §7):

```sh
docker build -t techplanner .
docker compose --env-file prod.env -f docker-compose.prod.example.yml up -d --wait
curl -fsS localhost:3000/healthz   # {"status":"ok","checks":{"database":{"ok":true}}}
```

`depends_on` enforces the order: `migrate` completed successfully → `worker` → `web`. There is no database container. All three services map `host.docker.internal` to the Docker bridge gateway (`extra_hosts: host-gateway`), so the URLs use that host name:

```sh
# prod.env (excerpt)
DATABASE_URL=mysql://techplanner_app:<app password>@host.docker.internal:3306/techplanner
MIGRATE_DATABASE_URL=mysql://techplanner_owner:<owner password>@host.docker.internal:3306/techplanner
APP_DB_USER="'techplanner_app'@'172.30.0.%'"   # must match the host used in CREATE USER (§7.4)
```

Passwords containing `@ : / # ?` or `%` must be percent-encoded in the URLs (or generate hex passwords, §7.4). Compose refuses to start when a `${VAR:?}` variable is missing. Keep `prod.env` out of version control, mode 600. `.env*` files are git-ignored and excluded from the Docker build context.

## 4. Rollback

A rollback **redeploys the previous image tag**. It never reverses migrations: they are forward-only, and there are no down migrations.

1. Redeploy the previous tag for web, then worker. Do **not** run `migrate` with the old image. Its migration set is a subset of what is applied, so it would do nothing anyway. Restoring the database from a dump (§8.3) is a separate last resort: it discards writes made since the dump.
2. Wait for `/healthz` to report 200 on web.
3. Fix forward. The next release ships a corrected migration (if one is needed) with the next free number.

This is safe because of the expand/contract rule below. The previous release always runs against the current schema.

## 5. Migration rule: expand/contract, compatible for one release

Every migration must keep the **previous release** working against the **new schema**. Old code keeps serving during a deploy, between steps 1 and 3, and after a rollback.

- **Expand (release N):** add only. New tables, new nullable columns or columns with defaults, new indexes (MySQL builds most indexes online, but size large indexes accordingly), new enum values, and backfills. Release N's code writes both the old and the new shape where needed.
- **Contract (release N+1 or later):** remove or tighten. Drop old columns and tables, add `NOT NULL` or constraints that old code would violate, and rename (as add + backfill + drop). Do this only once no deployed or rollback-candidate release reads the old shape.
- Never rename or drop something in the same release that stops using it.
- Never edit a migration that has shipped. Add a new file with the next free number.
- The audit tables are append-only (ADR-0013). Migrations must not update or delete audit rows.

## 6. Health and monitoring

- `GET /healthz`: `database` check (`SELECT 1` against MySQL), plus the `copilot` check once the LLM client has started in that process. Results never contain secrets. Timeout per check: 2 s. A cold Copilot CLI start can exceed this on the very first probe (ADR-0015).
- `GET /metrics`: Prometheus format, behind `METRICS_TOKEN`.
- Logs are structured JSON on stdout (pino). Collect them with the platform's log driver.

## 7. MySQL on the hosting server

MySQL 8.4 LTS runs natively on the hosting server, so its data, upgrades and backups are independent of the app image (spec `docs/specs/mysql-migration.md` §11a, ADR-0017). The hosting OS and firewall are not specified in the repository. The steps below assume **Ubuntu 24.04 with `ufw`** as a fallback; on another distribution use the MySQL YUM repository, `firewalld` or `nftables`, and the equivalent service names. Run everything as root (or with `sudo`) on the server.

### 7.1 Install MySQL 8.4 from the official MySQL APT repository

The distribution's own `mysql-server` package may be another version. Use Oracle's repository so the LTS line is pinned.

```sh
# Download mysql-apt-config from https://dev.mysql.com/downloads/repo/apt/ and verify its checksum there.
dpkg -i mysql-apt-config_<version>_all.deb   # choose "MySQL Server & Cluster", then "mysql-8.4-lts"
apt update
apt install mysql-server                      # set a strong root password when prompted
mysql --version                               # must report 8.4.x
systemctl enable --now mysql
```

### 7.2 Apply `techplanner.cnf`

```sh
install -m 644 docs/ops/mysql/techplanner.cnf /etc/mysql/mysql.conf.d/techplanner.cnf
```

Edit it before use:

- `bind-address`: loopback plus the **Docker bridge gateway**. On Linux, `host-gateway` resolves to that gateway, so MySQL must listen on it. It must **not** be `0.0.0.0`. Read the gateway with `docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'` (normally `172.17.0.1`).
- `innodb_buffer_pool_size`: about 50% of the RAM left after the app containers.

The gateway address exists only while Docker is up. Make MySQL start after Docker so the bind succeeds:

```sh
mkdir -p /etc/systemd/system/mysql.service.d
printf '[Unit]\nAfter=docker.service\nWants=docker.service\n' > /etc/systemd/system/mysql.service.d/after-docker.conf
systemctl daemon-reload && systemctl restart mysql
```

What the settings are for: UTC and strict `sql_mode` (the app assumes both); `utf8mb4`; `binlog_format = ROW`, which the READ COMMITTED isolation the app sets per connection requires; the binary log with 7-day expiry for point-in-time recovery; and `log_bin_trust_function_creators = ON`, without which the migrations' `CREATE TRIGGER` fails while the binary log is on (the alternative is giving the owner `SUPER`). Verify after the restart:

```sh
mysql -uroot -p -e "SELECT @@bind_address, @@binlog_format, @@log_bin, @@log_bin_trust_function_creators, @@sql_mode, @@global.time_zone"
```

### 7.3 Firewall

Close 3306 to everything except the Docker bridge subnet. Docker publishes only the web port, so MySQL is not reachable from outside as long as it listens only on the two addresses above. The firewall rule is the second layer.

```sh
ufw allow in on br-techplanner to any port 3306 proto tcp   # the compose project network
ufw deny 3306/tcp                                    # everyone else (rules match in order: keep the allow first)
ufw status numbered
```

The containers connect from the compose project network, which `docker-compose.prod.example.yml` pins to subnet `172.30.0.0/24` on bridge `br-techplanner`; MySQL listens on the `docker0` gateway (`172.17.0.1`), which exists as soon as Docker starts, and the host routes between the two bridges without NAT, so MySQL sees `172.30.0.x` source addresses. Docker edits `iptables` itself, which bypasses some `ufw` rules for container traffic, so the `bind-address` limit is the primary control. From another machine, `nc -vz <server> 3306` must fail.

### 7.4 Create the database and users (production bootstrap)

Do **not** run `scripts/mysql-bootstrap.sql` as it is. It has dev passwords, host `%`, and it grants the owner `ALL` on `techplanner\_%`.\* so that test suites can create databases. The production variant:

- uses generated passwords (`openssl rand -hex 24`; hex needs no URL encoding);
- restricts both users to the compose network subnet (`172.30.0.%`) instead of `%`;
- has **no** `techplanner\_%` wildcard grant and no `techplanner_test` database;
- gives the app user no grant at all (migrations grant per table, and `audit_record` gets `SELECT, INSERT` only).

```sh
OWNER_PW=$(openssl rand -hex 24); APP_PW=$(openssl rand -hex 24)   # put both in the secret store now
mysql -uroot -p <<SQL
CREATE DATABASE IF NOT EXISTS techplanner CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'techplanner_owner'@'172.30.0.%' IDENTIFIED BY '${OWNER_PW}';
CREATE USER 'techplanner_app'@'172.30.0.%'   IDENTIFIED BY '${APP_PW}';
GRANT ALL PRIVILEGES ON techplanner.* TO 'techplanner_owner'@'172.30.0.%' WITH GRANT OPTION;
SQL
unset OWNER_PW APP_PW
```

If you change the pinned subnet in the compose file, change the user hosts here, the firewall rule (§7.3) and `APP_DB_USER` with it; check the source address MySQL sees with `SELECT host FROM information_schema.processlist WHERE user LIKE 'techplanner%'` while the stack runs. Then **set `APP_DB_USER` on the `migrate` service to exactly the app user created above**, `'techplanner_app'@'172.30.0.%'`. The migrations grant table privileges to that account. With the default `'techplanner_app'@'%'` the grants would target an account that does not exist and the migration fails. The value must match the user and host in `mysql.user` character for character.

Verify:

```sh
mysql -uroot -p -e "SELECT user, host FROM mysql.user WHERE user LIKE 'techplanner%'"
```

The owner user is for migrations only. Its credentials belong to the `migrate` service alone (§2).

### 7.5 First deploy

Run §3 in order. When `migrate` has finished, confirm the app user's grants are per table and that `audit_record` is `SELECT, INSERT` only:

```sh
mysql -uroot -p -e "SHOW GRANTS FOR 'techplanner_app'@'172.30.0.%'"
```

## 8. Backups, restore and restore drill

### 8.1 Backup user

```sh
BACKUP_PW=$(openssl rand -hex 24)
mysql -uroot -p <<SQL
CREATE USER 'techplanner_backup'@'localhost' IDENTIFIED BY '${BACKUP_PW}';
GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES ON techplanner.* TO 'techplanner_backup'@'localhost';
GRANT PROCESS ON *.* TO 'techplanner_backup'@'localhost';
SQL
install -d -m 700 /etc/techplanner
printf '[client]\nuser = techplanner_backup\npassword = %s\nhost = localhost\n' "$BACKUP_PW" > /etc/techplanner/backup.cnf
chmod 600 /etc/techplanner/backup.cnf; unset BACKUP_PW
```

### 8.2 Nightly job

`scripts/ops/mysql-backup.sh` runs `mysqldump --single-transaction --routines --triggers | gzip` into `/var/backups/techplanner/techplanner-<UTC timestamp>.sql.gz`, deletes dumps older than 14 days, and **exits non-zero on any failure**, removing the partial file. Install and schedule it:

```sh
install -m 755 scripts/ops/mysql-backup.sh /usr/local/sbin/techplanner-mysql-backup
cat > /etc/cron.d/techplanner-backup <<'CRON'
MAILTO=ops@example.com
17 2 * * * root /usr/local/sbin/techplanner-mysql-backup || logger -p user.err -t techplanner-backup "backup FAILED"
CRON
```

Cron mails `MAILTO` whenever the job prints output (the script prints its error to stderr on failure, and one line on success; drop the success line or filter it if the mail is unwanted). The `logger` call adds a syslog error on failure. Replace `ops@example.com` and wire the failure into the organisation's alerting. Backups that fail silently are the risk, so also alert when the newest file in `/var/backups/techplanner` is older than 26 hours.

Copy the dumps **off the host** (for example with `rsync` or to object storage) using a job of your own: a dump on the same disk does not survive the disk. Dumps hold every table, including encrypted tokens and the audit log, so protect them like the database. The binary logs in `/var/lib/mysql` (7 days) give point-in-time recovery between dumps; copy them off too if the recovery point matters.

### 8.3 Restore

Restore into a scratch database first. The dump has no `CREATE DATABASE` or `USE` line, so the target is whichever database you name.

```sh
mysql -uroot -p -e "CREATE DATABASE techplanner_restore CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
gunzip -c /var/backups/techplanner/techplanner-<stamp>.sql.gz | mysql -uroot -p techplanner_restore
```

To restore into production itself, stop `web` and `worker` first, drop and re-create `techplanner`, and load the dump into it as above. Then run the `migrate` service (it applies anything newer than the dump, and the dump already includes `schema_migrations`, the triggers and the routines), and start `worker` and `web`. The app user and its grants live in the `mysql` system schema, not in the dump, so they survive a restore into the same server. On a new server, create the users as in §7.4, then re-apply the per-table grants by hand: take the `GRANT` statements from `db/migrations/*.sql` and replace `${APP_DB_USER}` with the app user's `'user'@'host'`.

### 8.4 Restore drill (before go-live, then after any change to the backup setup)

1. Run `techplanner-mysql-backup`. Confirm it exits 0 and wrote a non-empty `.sql.gz`.
2. Restore it into `techplanner_restore` as in §8.3.
3. Verify the audit chain on the restored copy, from a checkout of the same release (`npm ci` once). `audit:verify` loads the full application configuration, so export the variables of `prod.env` first (`set -a; . ./prod.env; set +a`) and override `DATABASE_URL`. It only reads, so use a MySQL account that can read the scratch database (root, run on the server):

   ```sh
   DATABASE_URL='mysql://root:<password>@127.0.0.1:3306/techplanner_restore' npm run audit:verify
   ```

   It must report an intact chain.
4. Drop the scratch database: `DROP DATABASE techplanner_restore`.
5. Record the date and the result of the drill.

## 9. MySQL upgrades

Stay on the **8.4 LTS** line and do not move to an innovation release. Before any MySQL package upgrade, take a dump (`techplanner-mysql-backup`) and confirm it exists. Then `apt update && apt install --only-upgrade mysql-server`. Re-check `techplanner.cnf` against the release notes (deprecated options; `log_bin_trust_function_creators` is already deprecated) and check `/healthz` afterwards. A major version change is a planned task with its own restore drill.

## 10. Failed migration: cleanup

MySQL commits every DDL statement implicitly. A migration file that fails part-way therefore leaves the statements before the failing one **applied**, while its `schema_migrations` row is **not** written. Re-running then fails with "already exists" or similar. The `migrate` container exits non-zero and its log names the file; nothing else rolls out (§3).

1. Read the error with `docker compose --env-file prod.env -f docker-compose.prod.example.yml logs migrate` and note the file, for example `0005_x.sql`.
2. As root, compare the file with the database: `SHOW TABLES`, `SHOW CREATE TABLE …`, `SHOW TRIGGERS`, `SHOW GRANTS FOR 'techplanner_app'@'172.30.0.%'`.
3. Undo by hand what the file's earlier statements did (`DROP TABLE`, `DROP TRIGGER`, `ALTER TABLE … DROP COLUMN`, `REVOKE …`), in reverse order. Never touch audit rows. If the damage is unclear, restore the last dump into a scratch database to compare, or restore it over production (§8.3).
4. Fix the cause. A file that has been applied in any environment is never edited (§5). A file that failed and was never recorded anywhere may be corrected in place; otherwise add a new migration.
5. Re-run the `migrate` service. Confirm exit 0 and a `schema_migrations` row for the file.

Take a dump before deploying any release that adds migrations, so step 3 always has a way back.

## 11. Audit TRUNCATE

MySQL has no TRUNCATE triggers. `audit_record` is protected against `UPDATE` and `DELETE` by triggers, but against `TRUNCATE` **only by privileges**: the app user holds `SELECT, INSERT` on it and no `DROP`. The **owner** user can truncate it. This weakening of SR-12.3 is accepted (ADR-0013, ADR-0017). It is why owner credentials stay out of the `web` and `worker` containers (§2), why the owner's host is restricted (§7.4), and why the owner password is used for migrations only. A truncated chain is detectable only against an earlier dump, so keep the off-host copies (§8.2).
