# Spec: Migrate from PostgreSQL to MySQL

Status: Implemented (2026-10-29)
Date: 2026-10-29
Supersedes (on acceptance): ADR-0001 database choice (PostgreSQL 16)

## 1. Goal

Replace PostgreSQL with MySQL 8.4 LTS (a requirement, §13). Developers run a native MySQL 8.4 install, point
`DATABASE_URL` at it and run `npm run migrate && npm run dev`, with no Docker container for the database. In
production, MySQL 8.4 runs natively on the hosting server next to the TechPlanner containers (§11a).

## 2. Scope

In scope:

- Schema (`db/migrations/0001`–`0004`) rewritten for MySQL 8.4.
- Driver swap `pg` → `mysql2` behind `src/server/db/pool.ts`.
- Every Postgres-specific query in `src/`, `scripts/`, `tests/` (65 files use `$n` placeholders).
- Job queue: `pg-boss` is Postgres-only and must be replaced.
- Migration runner, integration test reset, E2E DB bootstrap.
- Docs: README, runbook, `.env.example`, ADR-0001 update, compose files.
- Production: MySQL on the hosting server, users and grants, backups (§11a).

Out of scope:

- Data migration of an existing production database. There is no production data yet; if that changes, add a
  one-off export/import task.
- Any feature or behaviour change. Every integration and E2E test must pass unchanged in intent.

## 3. Target platform

| Item | Choice | Reason |
| --- | --- | --- |
| Server | MySQL 8.4 LTS, InnoDB (minimum supported: 8.4) | CHECK constraints (8.0.16+), `SKIP LOCKED`, JSON, CTEs, `DEFAULT (expr)` |
| Driver | `mysql2` (promise API, pool) | Maintained, prepared statements, TypeScript types |
| Charset | `utf8mb4`, collation `utf8mb4_0900_bin` on audit and key columns | Full Unicode; byte-exact comparison for hashed text |
| Session settings | `time_zone = '+00:00'`, `sql_mode` includes `STRICT_ALL_TABLES,NO_ZERO_DATE` | UTC timestamps; reject silent truncation |
| Isolation | `READ COMMITTED`, set per connection (`SET SESSION transaction_isolation`) | Each statement reads a fresh snapshot, as PostgreSQL's default does. Under InnoDB's default `REPEATABLE READ` the snapshot is fixed by the first read, so a read taken before the `audit_chain` lock would make `recordAudit` see a stale chain head and fork the chain. Requires `binlog_format = ROW` (the 8.4 default) |

`DATABASE_URL` becomes `mysql://techplanner:techplanner@localhost:3306/techplanner`.

## 4. Schema mapping

### 4.1 Types

| PostgreSQL (current) | MySQL | Notes |
| --- | --- | --- |
| `text` (keys, ids, enums) | `VARCHAR(n)` | MySQL cannot index or PK unbounded `TEXT`. Sizes: account ids 128, ticket keys 64, section names 64, status/role/kind 32, fingerprints 128, `ref` 512 |
| `text` (bodies) | `MEDIUMTEXT` / `LONGTEXT` | `content_text`, `content`, `baseline_body`, `description` |
| `uuid` | `CHAR(36)` | Keep canonical lowercase string; audit hashing already hashes canonical form (`canonicalUuid`). `BINARY(16)` rejected: every query and test would need conversion |
| `gen_random_uuid()` default | `DEFAULT (UUID())` | MySQL 8.0.13+ expression default; drop `pgcrypto` extension |
| `bigserial` | `BIGINT UNSIGNED AUTO_INCREMENT` | |
| `timestamptz` | `DATETIME(6)` stored as UTC | Session `time_zone='+00:00'`; driver `timezone: 'Z'`, `dateStrings: false` |
| `now()` default | `DEFAULT CURRENT_TIMESTAMP(6)` | |
| `bytea` | `VARBINARY(64)` (hashes) / `BLOB` (encrypted tokens) | `app_session.id_hash` PK → `BINARY(32)` |
| `jsonb` | `JSON` | MySQL normalises key order and drops duplicate keys; see §7.3 |
| `text[]` | `JSON` (array of strings) | `ticket_keys`, `scopes`, `ticket_ids` |
| `boolean` | `BOOLEAN` (`TINYINT(1)`) | Driver returns `0/1`; map with `typeCast` (§5.2) |
| `int` | `INT` | |

### 4.2 Constraints and triggers

| Current | MySQL replacement |
| --- | --- |
| `CHECK (status IN (...))` | Same syntax; enforced in 8.0.16+ |
| FKs, `ON DELETE CASCADE`, `UNIQUE (session_id, fingerprint)` | Same |
| `revision_immutable()` trigger (only `published false → true`) | `BEFORE UPDATE` trigger comparing each column `OLD.c <=> NEW.c` except `published`, then `SIGNAL SQLSTATE '45000'` |
| `audit_record` UPDATE/DELETE reject triggers | `BEFORE UPDATE` and `BEFORE DELETE` triggers with `SIGNAL SQLSTATE '45000'` |
| `audit_record` TRUNCATE trigger | **No equivalent** (MySQL has no TRUNCATE triggers). Enforced by privileges: the app user gets `SELECT, INSERT` only on `audit_record`, and no `DROP` (which TRUNCATE needs). The owner user can still truncate; this weakening of SR-12.3 is accepted (§13) and recorded in ADR-0013 |
| `REVOKE ... FROM PUBLIC` | Two users: `techplanner_owner` (DDL, runs migrations) and `techplanner_app` (DML only, used by web and worker); see §11a |

Trigger bodies must be applied without `DELIMITER` (that is a CLI directive). The migration runner sends each
statement separately (§6).

### 4.3 Migrations

Rewrite rather than translate: there is no deployed data. Either replace `0001`–`0004` with one MySQL
`0001_init.sql`, or keep four files with the same numbering and MySQL bodies. Recommendation: keep four files
(same history, easier review against the Postgres originals) and delete the Postgres versions in the same PR.

## 5. Data-access layer

### 5.1 `src/server/db/pool.ts`

Keep the exported surface (`db`, `query`, `withTransaction`) so call sites change minimally. Introduce a small
`DbClient` interface (`query<T>(sql, params) → { rows, rowCount }`) implemented over a `mysql2` `PoolConnection`,
and replace `PoolClient` imports from `pg` with it (12 files under `src/server`, plus scripts and tests).

### 5.2 Driver configuration

- `namedPlaceholders: false`; use `?` placeholders.
- `typeCast`: `TINYINT(1)` → boolean; `JSON` already parsed by mysql2; `BIGINT` → string (matches current `pg`
  behaviour for `bigserial` ids, which callers treat as strings).
- `timezone: 'Z'`, `supportBigNumbers: true`, `bigNumberStrings: true`.
- `multipleStatements: false` for the app pool; the migration runner uses its own connection (§6).

### 5.3 Query rewrites

| Pattern (found in) | Count | Rewrite |
| --- | --- | --- |
| `$1, $2` placeholders | 65 files | `?`; queries that reuse `$1` must repeat the parameter. Do this mechanically, then review each reuse |
| `RETURNING` | 20 | Inserts: generate UUIDs in JS (`crypto.randomUUID()`) or read `insertId`, then `SELECT`. Updates: `SELECT ... FOR UPDATE` then `UPDATE`, or re-`SELECT` after update, inside the same transaction |
| `ON CONFLICT (...) DO NOTHING` (`spec/editAudit.ts`) | 1 | `INSERT IGNORE` is too broad (swallows other errors); use `INSERT ... ON DUPLICATE KEY UPDATE session_id = session_id` |
| `ON CONFLICT ... DO UPDATE SET x = EXCLUDED.x` (`auth/tokens.ts`, `auth/callback/route.ts`) | 2 | `INSERT ... AS new ON DUPLICATE KEY UPDATE x = new.x` (8.0.19+) |
| `cardinality(EXCLUDED.scopes) = 0` (`auth/tokens.ts`) | 1 | `JSON_LENGTH(new.scopes) = 0` |
| `make_interval(...)`, `interval '60 seconds'` (`auth/session.ts`, `auth/tokens.ts`, `sessions/lock.ts`) | 7 | `NOW(6) + INTERVAL ? HOUR` / `SECOND` / `DAY` |
| `LEAST`, `COALESCE`, `now()` | many | Same names; use `NOW(6)` for microsecond precision |
| `::text`, `::bigint`, `::timestamptz` casts | 10 | Remove or `CAST(? AS ...)` |
| `IS NOT DISTINCT FROM` | trigger only | `<=>` |
| `SELECT ... FOR UPDATE` | 15 | Same syntax. Re-check each for gap-lock deadlocks (§8) |
| `pg_advisory_xact_lock(hashtext(...))` (`audit/audit.ts`, `auth/tokens.ts`, `scripts/migrate.ts`) | 3 | MySQL has no transaction-scoped advisory lock. Replace with a row lock on a dedicated `app_lock (name VARCHAR(64) PRIMARY KEY)` table: `SELECT 1 FROM app_lock WHERE name = ? FOR UPDATE` (seed rows for `audit_chain`; `INSERT ... ON DUPLICATE KEY UPDATE` + `FOR UPDATE` for per-user `refresh:<id>`). Released at commit, same semantics |
| `pg_try_advisory_lock` / `pg_advisory_unlock` session lock (`api/sessions/[id]/messages/route.ts`) | 1 | `GET_LOCK(?, 0)` / `RELEASE_LOCK(?)`; connection-scoped, same as today. Lock names ≤ 64 chars: `turn:<uuid>` is 41 |
| `rowCount` on results | many | `affectedRows` for writes, `rows.length` for reads; wrap in `DbClient` |
| Arrays passed as JS arrays to `text[]` | `ticket_keys`, `scopes`, `ticket_ids` | `JSON.stringify` on write; mysql2 parses `JSON` on read |
| `JSON.stringify(...)` into `jsonb` | 2+ | Unchanged |

### 5.4 Error codes

Code that maps Postgres SQLSTATEs (unique violation `23505`, FK `23503`, serialisation `40001`, deadlock
`40P01`) must map MySQL errno instead: `ER_DUP_ENTRY 1062`, `ER_NO_REFERENCED_ROW_2 1452`, deadlock `1213`, lock
wait timeout `1205`, `SIGNAL` → `1644`. Grep found no direct SQLSTATE checks in `src/`; tests asserting trigger
errors (`tests/integration/schema.test.ts`, `audit.test.ts`) must change their expected messages.

## 6. Migration runner (`scripts/migrate.ts`)

- `schema_migrations (filename VARCHAR(255) PRIMARY KEY, applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6))`.
- **DDL is not transactional in MySQL** (implicit commit). "A failed migration leaves nothing behind" no longer
  holds. Mitigations: one logical change per file; make DDL idempotent where cheap (`IF NOT EXISTS`); document
  that a failed migration needs manual cleanup.
- Concurrency: `GET_LOCK('techplanner_migrate', 60)` for the whole run, `RELEASE_LOCK` in `finally`.
- Statement splitting: run on a dedicated connection with `multipleStatements: true`, or split files on a
  `-- statement-break` marker. Recommendation: the marker, because it keeps trigger bodies (which contain `;`)
  intact without a SQL parser.

## 7. Job queue (replaces `pg-boss`)

`pg-boss` only supports PostgreSQL. Used features (`src/server/jobs/queue.ts`): named queues, `singletonKey`
with the `short` policy (at most one queued job per key, used to debounce readiness evaluation), `startAfter`,
`retryLimit: 3` with exponential backoff, `retryDelay`, dead-letter on `NonRetryableJobError`, `batchSize: 1`,
graceful stop.

### 7.1 Options

| Option | Verdict |
| --- | --- |
| BullMQ | Needs Redis: adds a server, defeats the goal |
| Agenda / Bree | Mongo / in-process only |
| In-house MySQL queue | **Recommended.** ~200 lines; the feature set above is small and already covered by `tests/integration/jobs.test.ts` |

### 7.2 Design

```sql
CREATE TABLE job (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  data JSON NOT NULL,
  state VARCHAR(16) NOT NULL CHECK (state IN ('created','active','completed','failed','deadletter')),
  singleton_key VARCHAR(255),
  -- Generated column makes the 'short' policy a unique index: one queued job per (name, key).
  queued_singleton VARCHAR(330) AS (IF(state = 'created' AND singleton_key IS NOT NULL, CONCAT(name, ':', singleton_key), NULL)) STORED,
  retry_count INT NOT NULL DEFAULT 0,
  retry_limit INT NOT NULL,
  retry_delay_s INT NOT NULL,
  start_after DATETIME(6) NOT NULL,
  locked_until DATETIME(6),
  output JSON,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY job_queued_singleton (queued_singleton),
  KEY job_fetch (name, state, start_after)
);
```

- `enqueue`: `INSERT`; on `ER_DUP_ENTRY` against `job_queued_singleton` return `null` (current contract).
- Fetch: in a transaction, `SELECT ... WHERE name = ? AND state = 'created' AND start_after <= NOW(6) ORDER BY
  start_after LIMIT 1 FOR UPDATE SKIP LOCKED`, set `state='active'`, `locked_until = NOW(6) + visibility timeout`,
  commit, then run the handler outside the transaction.
- Success → `completed`. Error → if `retry_count < retry_limit`, back to `created` with
  `start_after = NOW(6) + retry_delay_s * 2^retry_count`; else `failed`. `NonRetryableJobError` → `deadletter`.
- Expired `active` jobs (`locked_until < NOW(6)`, crashed worker) are returned to `created` by the poller.
- Poll interval 1 s with immediate re-poll after a job; graceful stop waits for the in-flight handler.
- Retention: delete `completed` older than 7 days on worker start and hourly.
- Keep `enqueue`, `subscribeHandlers`, `stopQueue`, `getQueue` signatures so callers
  (`readiness/schedule.ts`, `publish/jobHandler.ts`, `worker/index.ts`) are untouched.

### 7.3 Audit hash chain

`details` is hashed in canonical JSON (`audit/hash.ts`, sorted keys), so MySQL's key reordering does not break
verification. Still required:

- Read-back must return the same JSON value: integers beyond 2^53 and floats like `1.0` can round-trip
  differently between `jsonb` and MySQL `JSON`. Add a property test that writes and re-verifies varied
  `details` through `scripts/audit-verify.ts`.
- `ts` is hashed as the JS ISO string (millisecond precision); `DATETIME(6)` read-back in UTC must format to the
  same string. Covered by `tests/integration/audit.test.ts`.
- Text columns in the hash use `utf8mb4_0900_bin` so stored bytes equal hashed bytes. The existing lone-surrogate
  rejection stays.

Outcome (task 47): integers beyond 2^53 round-trip (JS has already rounded them before hashing). Doubles with 16–17
significant digits do not: MySQL's JSON parser is not correctly rounded, and about one random double in eight read
back one or two units in the last place off (e.g. `123456789.12345679` → `123456789.1234568`). `recordAudit` now
rejects such `details` numbers (`assertStorableDetails` in `audit/hash.ts`). It accepts integer literals within
int64/uint64, and other numbers whose shortest form is m × 10^p with m < 2^53 and |p| ≤ 22.

## 8. Concurrency review

The app runs at `READ COMMITTED` (§3), where InnoDB takes only record locks for `FOR UPDATE` on searches and
index scans, as Postgres does; gap locks remain for foreign-key and duplicate-key checks. Under `REPEATABLE READ`
(InnoDB's default, used by any connection that does not run the session init) `FOR UPDATE` also takes
next-key/gap locks over ranges and non-unique indexes. Review each of the 15 `FOR UPDATE` sites:

- Point lookups by primary key (`planning_session`, `working_copy`, `publish_run`, `pending_suggestion`): same
  behaviour.
- `SELECT_ISSUES ... FOR UPDATE` (`readiness/evaluate.ts:131`) and
  `edit_audit_state WHERE session_id = ? ORDER BY section FOR UPDATE` (`spec/editAudit.ts:134`) lock ranges.
  They are already scoped by `session_id` under a held `planning_session` row lock, so gap locks stay within one
  session. Confirm with the concurrency tests; add deadlock retry (errno 1213) in `withTransaction` only if
  tests show it is needed.
- Keep a consistent lock order: `planning_session` row first, then children (already the pattern).

Outcome (task 47): 18 `FOR UPDATE` sites. 15 are point lookups on a primary key. 3 are ranges and carry a comment:
the two above and the job claim (`jobs/queue.ts`, `SKIP LOCKED`). `tests/integration/concurrency.test.ts` passes
20 consecutive runs at READ COMMITTED with no 1213. At REPEATABLE READ the same tests deadlock in evaluate + edit
and fork the audit chain. `withTransaction(fn, { retryOnDeadlock: true })` re-runs the callback up to 3 times. It is
opted in only for the database-only callbacks on range or upsert locks: `evaluateSession`'s write transaction,
`recordSectionEdit` and `flushEditAudits`.

## 9. Tests and tooling

| File | Change |
| --- | --- |
| `tests/integration/setup.ts` | `DROP SCHEMA public CASCADE` → `DROP DATABASE IF EXISTS x; CREATE DATABASE x` (test user needs `CREATE, DROP` on the test DB), then migrate |
| `tests/integration/env.ts`, `tests/e2e/support/env.ts` | Default `DATABASE_URL` to `mysql://…:3306/techplanner_test` |
| `tests/e2e/support/prepareDb.ts` | `CREATE DATABASE IF NOT EXISTS` via `information_schema.SCHEMATA` |
| `tests/e2e/support/helpers.ts`, `tests/integration/jobs.test.ts` | Driver + queue API |
| `tests/integration/schema.test.ts` | Trigger error messages; TRUNCATE test becomes a privilege test (§4.2) |
| `scripts/audit-verify.ts`, `scripts/perf/run.ts` | Driver swap |
| CI | Use the runner's preinstalled MySQL (`sudo systemctl start mysql` on `ubuntu-latest`) or a `services: mysql:8.4` block. A service container in CI is acceptable; the goal is dev machines |

## 10. Alternatives

Rejected because MySQL is required (§13). Kept for the ADR record.

| Option | Removes Docker locally | Code change | Why rejected |
| --- | --- | --- | --- |
| Native PostgreSQL 16 | Yes | None | MySQL required |
| PGlite (embedded Postgres) for dev/tests | Yes | Small | MySQL required |
| Managed Postgres | Yes | None | MySQL required; DB runs on the hosting server |

## 11. Work breakdown

Each step lands green (lint, typecheck, unit, integration). Implementation tasks: DEV_TASK_43–49
([DEV_TASK_LIST.md](../../DEV_TASK_LIST.md), phase 7). The tasks reorder the steps below so the dialect-neutral
refactor and the queue replacement land on PostgreSQL first, and one task (46) switches databases.

1. **ADR**: write ADR-0017 "Database: MySQL 8.4 on the hosting server", amend ADR-0001 (database) and ADR-0013
   (TRUNCATE enforced by privileges, accepted).
2. **Driver layer**: `mysql2` pool, `DbClient` interface, type casts, error mapping. Keep `pg` until step 6.
3. **Schema + runner**: MySQL migrations, statement splitting, `GET_LOCK`, `app_lock` table; `schema.test.ts`
   green.
4. **Query port**: placeholders, `RETURNING`, upserts, intervals, arrays, advisory locks, file by file; integration
   suites green.
5. **Queue**: MySQL job table and worker; `jobs.test.ts`, readiness debounce and publish retry tests green.
6. **Remove Postgres**: drop `pg`, `@types/pg`, `pg-boss`; delete `docker-compose.dev.yml`; remove the `postgres`
   service from `docker-compose.prod.example.yml` and wire the containers to the host's MySQL (§11a).
7. **Docs**: README dev setup (install MySQL 8.4, `scripts/mysql-bootstrap.sql`), `.env.example`, runbook
   (§11a: install, users, grants, backup, restore, TRUNCATE note), `MANUAL_TEST.md`.
8. **Verification**: full E2E suite, `npm run audit:verify` on a populated DB, `npm run perf` against the
   ADR-0007 targets.

Rough size: 7–10 developer-days, about half of it in steps 4–5; the production setup (§11a) adds about one day.

## 11a. Production: MySQL on the hosting server

MySQL 8.4 is installed natively on the hosting server (OS package from the MySQL APT/YUM repository), not as a
container, so its data, upgrades and backups are independent of the app image.

**Network.** `bind-address = 127.0.0.1` plus the Docker bridge gateway (e.g. `172.17.0.1`), with the firewall
closing 3306 to everything else. The containers reach it through `extra_hosts: ["host.docker.internal:host-gateway"]`
and `DATABASE_URL=mysql://techplanner_app:…@host.docker.internal:3306/techplanner`.

**Users** (created by `scripts/mysql-bootstrap.sql`, run once as root; used for dev too, with dev passwords):

```sql
CREATE DATABASE techplanner CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'techplanner_owner'@'%' IDENTIFIED BY '…';   -- restrict host to the bridge subnet in prod
CREATE USER 'techplanner_app'@'%'   IDENTIFIED BY '…';
GRANT ALL PRIVILEGES ON techplanner.* TO 'techplanner_owner'@'%' WITH GRANT OPTION;
-- No database-wide grant for techplanner_app: migrations grant per table (below).
```

Because a database-level `UPDATE, DELETE` grant cannot exclude one table, the app user's grants are per table:
each migration that creates a table also grants on it (`SELECT, INSERT, UPDATE, DELETE`, or `SELECT, INSERT` for
`audit_record`). The bootstrap script then grants nothing database-wide to `techplanner_app`.
`tests/integration/schema.test.ts` asserts that `techplanner_app` cannot `UPDATE`, `DELETE` or `TRUNCATE`
`audit_record`.

**Roles.** The `migrate` service gets `DATABASE_URL` built from a new `MIGRATE_DATABASE_URL` (owner user); `web`
and `worker` use the app user. `npm run migrate` in dev reads `MIGRATE_DATABASE_URL` when set, else
`DATABASE_URL`.

**Server settings** (`/etc/mysql/mysql.conf.d/techplanner.cnf`): `default_time_zone = '+00:00'`,
`sql_mode = STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO`,
`character_set_server = utf8mb4`, `log_bin = ON`, `binlog_expire_logs_seconds = 604800`,
`innodb_buffer_pool_size` ≈ 50% of RAM left after the app containers.

**Backup and restore** (runbook):

- Nightly `mysqldump --single-transaction --routines --triggers techplanner | gzip` as a backup user with
  `SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, PROCESS`, kept 14 days, copied off the host.
- Binary logs give point-in-time recovery between dumps.
- Restore drill once before go-live: restore into a scratch database, then run `npm run audit:verify` against it.

**Upgrades.** Stay on the 8.4 LTS line; take a dump before each minor upgrade.

## 12. Acceptance criteria

- `npm run migrate && npm run dev` works against a native MySQL 8.4 with no Docker running.
- `npm test`, `npm run test:integration`, `npm run test:e2e` pass against MySQL.
- `npm run audit:verify` reports an intact chain after the E2E run, and after a backup restore (§11a).
- `docker-compose.prod.example.yml` starts web, worker and migrate against the host's MySQL with no database
  container.
- Audit UPDATE and DELETE are rejected by triggers; TRUNCATE is rejected for the app user by privileges.
- Readiness debounce: two enqueues with the same `singletonKey` yield one queued job.
- No `pg`, `pg-boss`, or `$n` placeholder remains (`grep` check in CI).
- Perf targets in ADR-0007 still met.

## 13. Decisions (2026-10-29)

1. MySQL is required. Postgres alternatives (§10) are rejected.
2. TRUNCATE on `audit_record` is blocked by privileges only (no trigger). Accepted; record in ADR-0013.
3. Production MySQL runs natively on the hosting server (§11a).
4. MySQL 8.4 LTS is the minimum and target version for dev, CI and production.
