# ADR-0011: OAuth Scopes and Token Storage

Status: Accepted

Date: 2026-10-05

Source: SPEC_DOC.md §9 D-11

## Context

OAuth scopes, token storage, tenancy.

## Decision

Scopes per SR-1.3; server-side AES-256-GCM token storage; one Atlassian site per deployment.

## Rationale

Least privilege for the operations in §13; FR-1 forbids shared credentials.

## Revisit if

Multi-site requirement.
