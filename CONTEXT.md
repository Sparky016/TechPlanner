# Glossary

| Term | Definition |
|---|---|
| **PRD (input)** | `PRD.md` in this repo — the product requirements for *this* tool. |
| **Generated Specification** | The document the tool produces for a Jira ticket. The PRD calls it "generated PRD"; this spec uses *Generated Specification* to avoid ambiguity. Structure fixed by FR-5. |
| **Facilitator** | The authenticated Engineering Lead running a Planning Session (PRD §7). |
| **Participant** | A Software Developer present in the meeting. In MVP participates verbally; does not log in to the session [D-3]. |
| **Planning Session** | A persisted unit of work bound to one or more Jira tickets, containing conversation, notes, working copy and revisions (FR-2). |
| **Working Copy** | The current, unsaved-to-history state of the Generated Specification, updated live by AI and Facilitator (FR-4) [D-5]. |
| **Revision** | An immutable snapshot of the Working Copy created by an explicit Save Draft, Restore, or Publish (FR-10, FR-11) [D-5]. |
| **Section** | One of the 27 headings mandated by FR-5. |
| **Section Status** | `Complete` / `Partial` / `Missing` (FR-6). |
| **Issue** | A readiness finding with severity `Critical` / `Warning` / `Informational` (FR-7). |
| **Readiness Score** | Percentage computed from Section Statuses [D-6]. |
| **Readiness Gate** | Advisory check: passes when no open Critical Issues exist (FR-8, FR-9) [D-6]. |
| **Override** | Facilitator bypass of a failing Readiness Gate, with justification + confirmation, audited (FR-9). |
| **Publish** | Explicit action that pushes a Revision to Jira and Confluence and triggers downstream (FR-13). |
| **Downstream Hook** | Configured mechanism signalling the existing AI Task Generator that a specification is published [D-9]. |
| **Audit Record** | Immutable log entry with the fields of PRD §14. |
