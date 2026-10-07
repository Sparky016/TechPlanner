# ADR-0002: LLM Integration

Status: Accepted

Date: 2026-10-05

Source: SPEC_DOC.md §9 D-2

## Context

LLM integration unspecified in PRD.

## Decision

User directive (2026-10-05): GitHub Copilot SDK + GitHub Copilot CLI (§7.6). Author-resolved sub-decisions: deployment-level Copilot token (no per-user GitHub login); custom-tool-only allow-list; strongest model for facilitation, faster model for evaluation, both configurable.

## Rationale

Directive from user. Single Atlassian login stays the only user auth (FR-1); locking down built-in tools keeps the agent a planner, not a code generator (§4).

## Revisit if

Per-user Copilot attribution/billing is required → add GitHub OAuth per user.
