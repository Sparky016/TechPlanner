# ADR-0006: Readiness Score and Gate

Status: Accepted

Date: 2026-10-05

Source: SPEC_DOC.md §9 D-6

## Context

Score formula, gate rule, Section mapping of FR-6 example.

## Decision

Equal-weight score (Complete 1 / Partial 0.5 / Missing 0); gate = zero open Critical Issues (score is informational); mandatory Critical rules in SR-7.3; FR-6 "Architecture" ≙ Technical Design, "Edge Cases" evaluated within Functional Requirements / Error Handling / Acceptance Criteria; "Testing" ≙ Testing Strategy.

## Rationale

FR-8 ties loop termination to Critical gaps, so the gate must too; §10 says a developer must not need clarification — core sections missing violates that.

## Revisit if

Calibration data shows score/gate disagree with developer feedback.
