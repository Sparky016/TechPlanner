# ADR-0009: Downstream Hook Interface

Status: Proposed

Date: 2026-10-05

Source: SPEC_DOC.md §9 D-9

## Context

"Trigger downstream workflow" has no defined interface (today manual, §5).

## Decision

Configurable signed webhook with defined payload; fallback signal = `spec-published` Jira label. Do not call the Task Generator's API directly.

## Rationale

Downstream interface is unknown; a webhook + label decouples and is adaptable.

## Revisit if

Task Generator exposes a defined API.
