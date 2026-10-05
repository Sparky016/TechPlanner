# ADR-0005: Revision Granularity and Autosave

Status: Accepted

Date: 2026-10-05

Source: SPEC_DOC.md §9 D-5

## Context

"Every draft creates a revision" (FR-11) vs real-time updates (FR-4).

## Decision

Continuous autosave of Working Copy (no revision); Revision only on Save Draft / Restore / Publish; Restore is non-destructive. AI patches don't overwrite sections the user edited since AI last read them — they become pending suggestions.

## Rationale

Avoid revision-per-keystroke while keeping meaningful history and protecting human edits (§4 "does not replace engineering judgement").

## Revisit if

Users want automatic periodic revisions.
