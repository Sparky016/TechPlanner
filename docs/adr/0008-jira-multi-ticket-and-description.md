# ADR-0008: Jira Multi-Ticket and Description Block Handling

Status: Proposed

Date: 2026-10-05

Source: SPEC_DOC.md §9 D-8

## Context

Multiple tickets; destructive "Update description".

## Decision

First key = primary; all tickets receive attachment, delimited description block, comment and label; one Confluence page per session. Description update only appends/replaces a delimited block.

## Rationale

§13 asks to update description but §4 says don't replace Jira; preserving original ticket content is the safe reading.

## Revisit if

Team wants description replaced wholesale.
