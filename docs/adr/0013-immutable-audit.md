# ADR-0013: Immutable Audit Enforcement

Status: Accepted

Date: 2026-10-05

Source: SPEC_DOC.md §9 D-13

## Context

How "immutable" audit is enforced.

## Decision

Append-only Postgres table (trigger rejects UPDATE/DELETE, app role has INSERT/SELECT only) + SHA-256 hash chain + verify command. Indefinite retention.

## Rationale

§14 requires immutable records for compliance; hash chain makes tampering detectable.

## Revisit if

Move to centralized logging (FR-12 future).
