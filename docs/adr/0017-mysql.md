# ADR-0017: Database Engine: MySQL 8.4 LTS

Status: Accepted

Date: 2026-10-29

Source: docs/specs/mysql-migration.md §13 decisions 1-4, §4.2, §11a

## Context

ADR-0001 chose PostgreSQL 16. MySQL is now required (spec §13.1), so PostgreSQL alternatives in spec §10 are
rejected. Three consequences follow: PostgreSQL-only features (transactional DDL, `pg-boss`, the TRUNCATE trigger
in ADR-0013) need replacements, and production must run MySQL natively on the hosting server (§11a).

## Decision

- Use MySQL 8.4 LTS as the database for dev, CI and production. 8.4 is the minimum and target version.
- Run MySQL natively on the hosting server (OS package, not a container), next to the TechPlanner containers.
- Enforce the audit TRUNCATE guarantee with privileges instead of a trigger: `techplanner_app` has `SELECT, INSERT`
  on `audit_record` and no `DROP`. UPDATE and DELETE stay rejected by triggers (ADR-0013).
- Replace `pg-boss` with an in-house MySQL job queue (spec §7).

## Rationale

MySQL is a requirement, so the question is how to meet the existing guarantees on it. MySQL 8.4 LTS has
enforceable `CHECK` constraints, `SIGNAL`-based triggers for UPDATE and DELETE rejection, and per-table privileges.
Only TRUNCATE lacks a trigger equivalent, and privileges close that gap for the app user. `pg-boss` only supports
PostgreSQL, while BullMQ needs Redis. The job feature set is small (spec §7.1), so an in-house queue of about 200
lines is the simplest option. Native installation keeps database data, upgrades and backups independent of the app
image.

## Consequences

- DDL is not transactional in MySQL. A failed migration can leave partial schema changes, so migrations must be
  written to be re-runnable or to be checked before they are applied.
- There are no TRUNCATE triggers. The owner user (`techplanner_owner`) can still truncate `audit_record`. This
  weakens SR-12.3 and is an accepted risk (spec §13.2, recorded in ADR-0013).
- Triggers must be applied as single statements without `DELIMITER` (spec §4.2).
- The job queue is custom code that must be maintained and tested (`tests/integration/jobs.test.ts`).
- Production needs a backup and restore runbook (nightly `mysqldump`, binary logs, restore drill before go-live).

## Revisit if

- The organization mandates PostgreSQL or a managed database service.
- MySQL 8.4 LTS support ends, or a later LTS version is required.
- Audit requirements need a stronger guarantee than the owner-user TRUNCATE risk allows.
