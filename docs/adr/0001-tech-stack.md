# ADR-0001: Tech Stack and Hosting

Status: Amended by ADR-0017

Date: 2026-10-05

Source: SPEC_DOC.md §9 D-1

## Context

Tech stack & hosting unspecified.

## Decision

TypeScript / Next.js / Node 22 / MySQL 8.4 LTS (database amended from PostgreSQL 16 by ADR-0017), single Docker image on the hosting server.

## Rationale

One language end-to-end, strong streaming support, Postgres gives relational history + enforceable append-only audit; FR-12 allows hosting-server storage.

## Revisit if

Org mandates another stack or cloud.
