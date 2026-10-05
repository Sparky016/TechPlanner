# ADR-0012: Authorization Delegation to Atlassian

Status: Accepted

Date: 2026-10-05

Source: SPEC_DOC.md §9 D-12

## Context

Authorization model.

## Decision

Delegated to Atlassian: can read primary ticket ⇒ can open its sessions; writes succeed only if Atlassian permits.

## Rationale

No separate permission system to maintain; aligns with "authenticated user identity used for all external operations" (§13).

## Revisit if

Need for app-level roles (future users).
