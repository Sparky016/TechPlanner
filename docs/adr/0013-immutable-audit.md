# ADR-0013: Immutable Audit Enforcement

Status: Accepted

Date: 2026-10-05

Source: SPEC_DOC.md §9 D-13

## Context

How "immutable" audit is enforced.

## Decision

Append-only table with UPDATE/DELETE rejected by triggers, app role has INSERT/SELECT only + SHA-256 hash chain + verify command. Indefinite retention.

Amended by ADR-0017 (MySQL 8.4):

- UPDATE and DELETE are still rejected by `BEFORE UPDATE` and `BEFORE DELETE` triggers that signal SQLSTATE `45000`.
- TRUNCATE is rejected by privileges, not a trigger (MySQL has no TRUNCATE triggers). `techplanner_app` gets
  `SELECT, INSERT` on `audit_record` and no `DROP`.
- Accepted risk: the owner user (`techplanner_owner`) can still truncate `audit_record` (spec §13.2).

## Rationale

§14 requires immutable records for compliance; hash chain makes tampering detectable.

## Revisit if

Move to centralized logging (FR-12 future).
